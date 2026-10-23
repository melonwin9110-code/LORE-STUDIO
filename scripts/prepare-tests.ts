import "dotenv/config";
import { Pool } from "pg";
import { spawnSync } from "node:child_process";

const target = process.env.TEST_DATABASE_URL || "postgresql://lore:lore_local@127.0.0.1:5432/lore_studio_test";
const url = new URL(target);
const database = decodeURIComponent(url.pathname.slice(1));
if (!/^[a-zA-Z0-9_]+_test$/.test(database)) {
  throw new Error("Тестовая база должна иметь отдельное имя с окончанием _test");
}
url.pathname = "/postgres";
const admin = new Pool({ connectionString: url.toString() });
try {
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [database]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE "${database}"`);
} finally {
  await admin.end();
}
const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
  stdio: "inherit", env: { ...process.env, DATABASE_URL: target },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
