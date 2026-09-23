import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const createPool = (connectionString: string) =>
  new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
  });
export async function migrate(pool: pg.Pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(2401901)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of (await readdir(resolve("db/migrations")))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(resolve("db/migrations", name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = await client.query(
        "SELECT checksum FROM schema_migrations WHERE name=$1",
        [name],
      );
      if (previous.rowCount) {
        if (previous.rows[0].checksum !== checksum)
          throw new Error(`Migration changed: ${name}`);
        continue;
      }
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)",
        [name, checksum],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
