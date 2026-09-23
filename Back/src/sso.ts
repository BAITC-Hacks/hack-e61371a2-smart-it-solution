import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import { z } from "zod";
import { tokenHash } from "./auth.js";
import { HttpError, transaction } from "./http.js";

type SsoConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  trustedOrigins: string[];
};
export function readSsoConfig(config: Config): SsoConfig | null {
  if (!process.env.OIDC_ISSUER || !process.env.OIDC_CLIENT_ID) return null;
  const issuer = z.url().parse(process.env.OIDC_ISSUER);
  if (!issuer.startsWith("https://"))
    throw new HttpError(503, "SSO_CONFIG_INVALID", "OIDC требует HTTPS");
  const redirectUri = `${config.origin}/api/v1/auth/sso/callback`;
  if (!config.secure)
    throw new HttpError(
      503,
      "SSO_CONFIG_INVALID",
      "SSO требует HTTPS и Secure cookie приложения",
    );
  return {
    issuer,
    clientId: process.env.OIDC_CLIENT_ID,
    clientSecret: process.env.OIDC_CLIENT_SECRET ?? "",
    redirectUri,
    trustedOrigins: [
      new URL(issuer).origin,
      ...(process.env.OIDC_TRUSTED_ORIGINS ?? "").split(",").filter(Boolean),
    ],
  };
}
export async function validateOidcToken(
  token: string,
  key: JWTVerifyGetKey | CryptoKey,
  settings: { issuer: string; clientId: string; nonce: string },
) {
  const { payload } = await jwtVerify(token, key as JWTVerifyGetKey, {
    issuer: settings.issuer,
    audience: settings.clientId,
    algorithms: ["RS256", "ES256"],
    requiredClaims: ["sub", "iat", "exp", "nonce"],
    clockTolerance: 5,
  });
  if (
    payload.nonce !== settings.nonce ||
    (Array.isArray(payload.aud) &&
      payload.aud.length > 1 &&
      payload.azp !== settings.clientId) ||
    (payload.azp && payload.azp !== settings.clientId)
  )
    throw new HttpError(
      401,
      "SSO_TOKEN_INVALID",
      "Проверка токена SSO не пройдена",
    );
  return payload;
}
const metadataCache = new Map<
  string,
  {
    until: number;
    value: {
      authorization_endpoint: string;
      token_endpoint: string;
      jwks_uri: string;
      issuer: string;
    };
  }
>();
async function metadata(config: SsoConfig) {
  const previous = metadataCache.get(config.issuer);
  if (previous && previous.until > Date.now()) return previous.value;
  let response: Response;
  try {
    response = await fetch(
      config.issuer.replace(/\/$/, "") + "/.well-known/openid-configuration",
      { redirect: "error", signal: AbortSignal.timeout(5000) },
    );
  } catch {
    throw new HttpError(503, "SSO_UNAVAILABLE", "Провайдер SSO недоступен");
  }
  const result = z
    .object({
      issuer: z.literal(config.issuer),
      authorization_endpoint: z.url(),
      token_endpoint: z.url(),
      jwks_uri: z.url(),
    })
    .safeParse(response.ok ? await response.json() : null);
  if (!result.success)
    throw new HttpError(
      503,
      "SSO_METADATA_INVALID",
      "Некорректные настройки провайдера SSO",
    );
  for (const target of [
    result.data.authorization_endpoint,
    result.data.token_endpoint,
    result.data.jwks_uri,
  ]) {
    const u = new URL(target);
    if (
      u.protocol !== "https:" ||
      !config.trustedOrigins.includes(u.origin) ||
      u.username ||
      u.password
    )
      throw new HttpError(
        503,
        "SSO_ENDPOINT_REJECTED",
        "Адрес провайдера SSO не разрешён",
      );
  }
  metadataCache.set(config.issuer, {
    until: Date.now() + 300000,
    value: result.data,
  });
  return result.data;
}
function cookie(req: IncomingMessage, name: string) {
  return (
    (req.headers.cookie ?? "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(name + "="))
      ?.slice(name.length + 1) ?? ""
  );
}
export async function handleSso(
  pool: Pool,
  config: Config,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  send: (data: unknown) => void,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/api/v1/auth/sso/")) return false;
  if (path === "/api/v1/auth/sso/config" && req.method === "GET") {
    send({
      enabled: Boolean(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID),
    });
    return true;
  }
  const settings = readSsoConfig(config);
  if (!settings)
    throw new HttpError(
      503,
      "SSO_NOT_CONFIGURED",
      "Корпоративный вход ещё не подключён",
    );
  if (path === "/api/v1/auth/sso/start" && req.method === "POST") {
    const m = await metadata(settings);
    const state = randomBytes(32).toString("base64url"),
      nonce = randomBytes(32).toString("base64url"),
      browser = randomBytes(32).toString("base64url"),
      verifier = randomBytes(32).toString("base64url");
    await pool.query("DELETE FROM oidc_states WHERE expires_at<now()");
    await pool.query(
      "INSERT INTO oidc_states(state_hash,browser_hash,nonce,verifier,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')",
      [tokenHash(state), tokenHash(browser), nonce, verifier],
    );
    const authorize = new URL(m.authorization_endpoint);
    for (const [k, v] of Object.entries({
      client_id: settings.clientId,
      redirect_uri: settings.redirectUri,
      response_type: "code",
      scope: "openid",
      state,
      nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }))
      authorize.searchParams.set(k, v);
    res.setHeader(
      "Set-Cookie",
      `cq_oidc=${browser}; HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth/sso; Max-Age=600`,
    );
    send({ authorizationUrl: authorize.toString() });
    return true;
  }
  if (path === "/api/v1/auth/sso/callback" && req.method === "GET") {
    const code = z
      .string()
      .min(1)
      .max(4096)
      .parse(url.searchParams.get("code"));
    const state = z
      .string()
      .min(20)
      .max(200)
      .parse(url.searchParams.get("state"));
    const pending = await transaction(pool, async (c) => {
      const r = (
        await c.query(
          "UPDATE oidc_states SET consumed_at=now() WHERE state_hash=$1 AND browser_hash=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING nonce,verifier",
          [tokenHash(state), tokenHash(cookie(req, "cq_oidc"))],
        )
      ).rows[0];
      if (!r)
        throw new HttpError(
          401,
          "SSO_STATE_INVALID",
          "Сессия входа истекла или уже использована",
        );
      return r;
    });
    const m = await metadata(settings);
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: settings.clientId,
      code,
      redirect_uri: settings.redirectUri,
      code_verifier: pending.verifier,
    });
    if (settings.clientSecret)
      params.set("client_secret", settings.clientSecret);
    let response: Response;
    try {
      response = await fetch(m.token_endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(8000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
      });
    } catch {
      throw new HttpError(502, "SSO_UNAVAILABLE", "Провайдер SSO недоступен");
    }
    const tokens = z
      .object({ id_token: z.string().max(20000) })
      .safeParse(response.ok ? await response.json() : null);
    if (!tokens.success)
      throw new HttpError(
        401,
        "SSO_EXCHANGE_FAILED",
        "Не удалось подтвердить вход",
      );
    let payload;
    try {
      payload = await validateOidcToken(
        tokens.data.id_token,
        createRemoteJWKSet(new URL(m.jwks_uri), { timeoutDuration: 5000 }),
        { ...settings, nonce: pending.nonce },
      );
    } catch {
      throw new HttpError(
        401,
        "SSO_TOKEN_INVALID",
        "Проверка токена SSO не пройдена",
      );
    }
    const sessionToken = randomBytes(32).toString("hex");
    await transaction(pool, async (c) => {
      const account = (
        await c.query(
          "SELECT u.id FROM oidc_identities i JOIN user_accounts u ON u.id=i.user_id WHERE i.issuer=$1 AND i.subject=$2 AND u.active AND NOT u.demo_only FOR UPDATE OF u",
          [settings.issuer, payload.sub],
        )
      ).rows[0];
      if (!account)
        throw new HttpError(
          403,
          "SSO_ACCOUNT_UNMAPPED",
          "Администратор должен связать корпоративный аккаунт",
        );
      await c.query(
        "UPDATE sessions SET revoked_at=now() WHERE token_hash=$1",
        [tokenHash(cookie(req, "cq_session"))],
      );
      await c.query(
        "INSERT INTO sessions(user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')",
        [account.id, tokenHash(sessionToken), randomBytes(32).toString("hex")],
      );
      await c.query(
        "INSERT INTO audit_log(actor,action,entity,entity_id) VALUES($1,'auth.sso','user_accounts',$2)",
        [account.id, account.id],
      );
    });
    res.setHeader("Set-Cookie", [
      `cq_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800`,
      "cq_oidc=; HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth/sso; Max-Age=0",
    ]);
    res.writeHead(303, { Location: config.origin + "/" });
    res.end();
    return true;
  }
  return false;
}
