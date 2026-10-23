import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required; copy .env.example to .env first");
  await client.connect();
  await client.query("SELECT pg_advisory_lock(84719321)");
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const directory = path.resolve("db/migrations");
  for (const name of (await readdir(directory)).filter((file) => /^\d+.*\.sql$/.test(file)).sort()) {
    const existing = await client.query("SELECT 1 FROM schema_migrations WHERE name=$1", [name]);
    if (existing.rowCount) continue;
    await client.query("BEGIN");
    try {
      await client.query(await readFile(path.join(directory, name), "utf8"));
      await client.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
      await client.query("COMMIT");
      console.log(`Applied ${name}`);
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  }
  console.log("Database migrations are current");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Migration failed");
  process.exitCode = 1;
} finally { await client.end(); }
