import type { PgDatabase } from "drizzle-orm/pg-core";
import * as schema from "./schema";

// The query-result HKT differs per driver (PGlite vs postgres-js); callers only use the shared query API.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema>;

const g = globalThis as unknown as { __signoffDb?: Promise<Db> };

/**
 * DATABASE_URL set  -> real Postgres (Neon in deploy).
 * otherwise         -> embedded PGlite persisted at PGLITE_DIR (default .data/pglite);
 *                      PGLITE_DIR=memory:// gives an in-memory DB (used by tests).
 */
async function create(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    // prepare:false keeps this working through Neon's pooled (pgbouncer transaction mode) endpoint.
    const client = postgres(url, { max: 5, prepare: false, idle_timeout: 20, connect_timeout: 10 });
    return drizzle(client, { schema }) as unknown as Db;
  }
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_EPHEMERAL_DB !== "1") {
    // Serverless disks are read-only or wiped between invocations: an embedded DB would silently lose data.
    throw new Error("DATABASE_URL is not set. Production needs a real Postgres (e.g. Neon). Run `npm run db:push` once, then `npm run db:seed`.");
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const dir = process.env.PGLITE_DIR ?? ".data/pglite";
  if (!dir.includes("://")) {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true }); // PGlite does not create parent directories
  }
  const client = new PGlite(dir);
  const db = drizzle(client, { schema });
  // Embedded dev/test DB: create tables on first use only (a re-diff can prompt interactively).
  // Real Postgres uses `npm run db:push`. After a schema change, re-run `npm run seed` to rebuild.
  const { rows } = await client.query<{ n: number }>(
    "select count(*)::int as n from information_schema.tables where table_schema = 'public'",
  );
  if (rows[0].n === 0) {
    const { pushSchema } = await import("drizzle-kit/api");
    const { apply } = await pushSchema(schema, db as never);
    await apply();
  }
  return db as unknown as Db;
}

export function getDb(): Promise<Db> {
  // A failed first connection must not be cached, or one transient error would poison this instance.
  return (g.__signoffDb ??= create().catch((e) => {
    g.__signoffDb = undefined;
    throw e;
  }));
}
