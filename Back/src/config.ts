import { z } from "zod";

const env = z.object({
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  APP_ORIGIN: z.url().default("http://localhost:5173"),
  DEMO_MODE: z.enum(["true", "false"]).default("false"),
  COOKIE_SECURE: z.enum(["true", "false"]).default("false"),
  DATASET_PATH: z.string().default("./data"),
});
export function readConfig(source = process.env) {
  const parsed = env.safeParse(source);
  if (!parsed.success)
    throw new Error(
      `Invalid configuration fields: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  const c = parsed.data;
  if (new URL(c.APP_ORIGIN).origin !== c.APP_ORIGIN)
    throw new Error("APP_ORIGIN must be an origin without a path");
  if (c.APP_ORIGIN.startsWith("https:") && c.COOKIE_SECURE !== "true")
    throw new Error("HTTPS requires COOKIE_SECURE=true");
  return {
    databaseUrl: c.DATABASE_URL,
    port: c.API_PORT,
    origin: c.APP_ORIGIN,
    demo: c.DEMO_MODE === "true",
    secure: c.COOKIE_SECURE === "true",
    datasetPath: c.DATASET_PATH,
  };
}
export type Config = ReturnType<typeof readConfig>;
