import { sql } from "drizzle-orm";
import { getDb } from "../src/db/client";
import { firms } from "../src/db/schema";
import { resetDatabase, seed } from "../src/lib/seed";

/**
 * Local (no DATABASE_URL): seeds the embedded DB with the kit's fixed dev tokens (`npm run seed` wipes .data first).
 * Remote (DATABASE_URL set): seeds with RANDOM tokens, refuses a database that already has data unless --reset.
 */
async function main() {
  const remote = Boolean(process.env.DATABASE_URL);
  const reset = process.argv.includes("--reset");
  const db = await getDb();

  if (remote) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(firms);
    if (n > 0 && !reset) throw new Error(`The database already has ${n} firm(s). Re-run with --reset to wipe it and reseed.`);
    if (reset) await resetDatabase(db);
  }

  const s = await seed(db, { devTokens: !remote });
  console.log("Seeded firms:", Object.values(s.firm).map((f) => f.name).join(" | "));
  console.log(`MCP URL: ${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/api/mcp`);
  console.log(remote ? "MCP tokens (shown once, store them now):" : "MCP tokens (local dev tokens):");
  for (const [who, tok] of Object.entries(s.token)) console.log(`  token ${who.padEnd(8)} ${tok}`);
  console.log("Acme client id:", s.client.acme.id);
}

main().then(() => process.exit(0), (e) => { console.error(e.message ?? e); process.exit(1); });
