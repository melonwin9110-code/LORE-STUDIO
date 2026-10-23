import pg, { type PoolClient } from "pg";

const globalDb = globalThis as unknown as { lorePool?: pg.Pool };
export const pool = globalDb.lorePool ?? new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});
if (process.env.NODE_ENV !== "production") globalDb.lorePool = pool;
pool.on("error", () => console.error("PostgreSQL: idle connection failed"));

export async function transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
