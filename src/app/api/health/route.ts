import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { isDemo } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Liveness + database check for a deployment. Reveals no data and no secrets. */
export async function GET() {
  try {
    const db = await getDb();
    await db.execute(sql`select 1`);
    return Response.json({ ok: true, db: "up", mode: isDemo() ? "demo" : "standard" });
  } catch (e) {
    // The message is operational ("DATABASE_URL is not set"), never a connection string.
    return Response.json({ ok: false, db: "down", error: (e as Error).message.split("\n")[0].slice(0, 200) }, { status: 503 });
  }
}
