import type { PgDatabase } from "drizzle-orm/pg-core";
import * as schema from "./schema";

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
    return drizzle(postgres(url), { schema }) as unknown as Db;
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite(process.env.PGLITE_DIR ?? ".data/pglite");
  return drizzle(client, { schema }) as unknown as Db;
}

export function getDb(): Promise<Db> {
  return (g.__signoffDb ??= create());
}
