/**
 * Serves an in-memory PGlite over the Postgres wire protocol, so the production driver path (postgres-js via
 * DATABASE_URL) can be exercised locally with no Postgres install:
 *   npm run pg:socket      # terminal 1
 *   DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5544/postgres?sslmode=disable" npm run db:push
 */
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

async function main() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: Number(process.env.PG_PORT ?? 5544), host: "127.0.0.1", maxConnections: 8 });
  await server.start();
  console.log(`PGlite wire-protocol server on 127.0.0.1:${process.env.PG_PORT ?? 5544}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
