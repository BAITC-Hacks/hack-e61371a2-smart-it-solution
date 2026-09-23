import { readConfig } from "./config.js";
import { createPool, migrate } from "./db.js";
import { importBundle, readBundle, ImportError } from "./imports.js";
import { seedDemoAccounts, hashPassword, appRoles } from "./auth.js";
import { z } from "zod";
import { seedGuideDemo } from "./guide.js";
const config = readConfig();
const pool = createPool(config.databaseUrl);
try {
  const command = process.argv[2];
  if (command === "migrate") {
    await migrate(pool);
    console.log("Migrations applied");
  } else if (command === "seed") {
    console.log(
      await importBundle(pool, await readBundle(config.datasetPath), {
        commit: true,
      }),
    );
    if (config.demo) {
      await seedDemoAccounts(pool);
      await seedGuideDemo(pool);
    }
  } else if (command === "account") {
    const a = z
      .object({
        ACCOUNT_LOGIN: z.string().min(3).max(120),
        ACCOUNT_PASSWORD: z.string().min(12).max(256),
        ACCOUNT_ROLE: z.enum(appRoles),
        ACCOUNT_EMPLOYEE_ID: z.string().optional(),
        ACCOUNT_NAME: z.string().min(1),
      })
      .parse(process.env);
    await pool.query(
      "INSERT INTO user_accounts(login,display_name,app_role,employee_id,password_hash) VALUES($1,$2,$3,$4,$5)",
      [
        a.ACCOUNT_LOGIN,
        a.ACCOUNT_NAME,
        a.ACCOUNT_ROLE,
        a.ACCOUNT_EMPLOYEE_ID ?? null,
        await hashPassword(a.ACCOUNT_PASSWORD),
      ],
    );
    console.log("Account created");
  } else throw new Error("Use migrate, seed or account");
} catch (e) {
  console.error(
    e instanceof ImportError
      ? e.details
      : e instanceof z.ZodError
        ? e.issues.map((i) => ({ field: i.path.join("."), message: i.message }))
        : "Command failed; verify database, configuration and constraints",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
