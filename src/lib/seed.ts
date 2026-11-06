import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { clientAssignments, clients, firms, playbooks, references, users } from "@/db/schema";
import { ingestFile } from "./ingest";
import type { Ctx, Role } from "./rbac";
import { createShareLink } from "./share";
import { issueToken } from "./tokens";

type SeedJson = {
  firms: {
    key: string; name: string;
    users: { email: string; name: string; role: Role; mcp_token_dev?: string; assigned_clients?: string[] }[];
    clients: { key: string; name: string; source_tools: string[]; color: string; cfo_email?: string; csvs: string[] }[];
  }[];
  playbooks: { firm: string; version: number; body_file: string }[];
  references: { firm: string; topic: string; version: number; body: string; source_url: string; as_of: string }[];
  share_links: { client: string; month: string; approver_name: string; otp_email: string; created_by: string }[];
};

const root = () => process.cwd();
const read = (p: string) => readFileSync(join(root(), p), "utf8");
const monthOf = (file: string) => file.match(/(\d{4}-\d{2})/)![1];

export type Seeded = Awaited<ReturnType<typeof seed>>;

/**
 * Loads seed/seed.json (the kit's synthetic data): two firms so cross-firm tests have something to fail
 * against, four roles, personal dev tokens, client assignments, CSVs, playbook, references, one share link.
 */
/** Wipes every table in the public schema. Only ever called on purpose (`npm run db:reset`). */
export async function resetDatabase(db: Db) {
  const rows = (await db.execute(sql`select tablename from pg_tables where schemaname = 'public'`)) as unknown as { tablename: string }[] | { rows: { tablename: string }[] };
  const names = (Array.isArray(rows) ? rows : rows.rows).map((r) => r.tablename);
  if (names.length) await db.execute(sql.raw(`truncate table ${names.map((n) => `"${n}"`).join(", ")} restart identity cascade`));
}

/**
 * devTokens=true (local, tests): the kit's fixed tokens, so docs and walkthroughs are reproducible.
 * devTokens=false (any real database): fresh random tokens, so no well-known credential is ever live.
 */
export async function seed(db: Db, opts: { withCsv?: boolean; devTokens?: boolean } = {}) {
  const withCsv = opts.withCsv ?? true;
  const devTokens = opts.devTokens ?? true;
  const data = JSON.parse(read("seed/seed.json")) as SeedJson;
  const out = {
    firm: {} as Record<string, typeof firms.$inferSelect>,
    user: {} as Record<string, typeof users.$inferSelect>,
    ctx: {} as Record<string, Ctx>,
    token: {} as Record<string, string>,
    client: {} as Record<string, typeof clients.$inferSelect>,
    review: {} as Record<string, string>, // "acme:2026-10" -> review id
    share: null as null | { token: string; linkId: string },
  };

  for (const f of data.firms) {
    const [firm] = await db.insert(firms).values({ name: f.name }).returning();
    out.firm[f.key] = firm;
    for (const c of f.clients) {
      const [row] = await db.insert(clients).values({
        firmId: firm.id, name: c.name, sourceTools: c.source_tools, color: c.color, cfoEmail: c.cfo_email,
      }).returning();
      out.client[c.key] = row;
    }
    for (const u of f.users) {
      const [row] = await db.insert(users).values({ firmId: firm.id, email: u.email, name: u.name, role: u.role }).returning();
      const short = u.email.split("@")[0];
      out.user[short] = row;
      out.ctx[short] = { firmId: firm.id, userId: row.id, role: u.role, actor: "user", name: u.name };
      if (u.mcp_token_dev) out.token[short] = await issueToken(db, { firmId: firm.id, userId: row.id, token: devTokens ? u.mcp_token_dev : undefined });
      for (const ck of u.assigned_clients ?? []) {
        await db.insert(clientAssignments).values({ userId: row.id, clientId: out.client[ck].id });
      }
    }
  }
  for (const p of data.playbooks) {
    await db.insert(playbooks).values({ firmId: out.firm[p.firm].id, version: p.version, body: read(p.body_file) });
  }
  for (const r of data.references) {
    await db.insert(references).values({
      firmId: out.firm[r.firm].id, topic: r.topic, version: r.version, body: r.body, sourceUrl: r.source_url, asOf: r.as_of,
    });
  }

  if (withCsv) {
    for (const f of data.firms) {
      const priya = out.ctx[f.users.find((u) => u.role === "owner")!.email.split("@")[0]];
      for (const c of f.clients) {
        for (const file of c.csvs) {
          const r = await ingestFile(db, {
            firmId: priya.firmId, clientId: out.client[c.key].id, month: monthOf(file), text: read(file),
            source: "upload", actor: { type: "user", id: priya.name },
          });
          if (r.rejected.length) throw new Error(`Seed CSV ${file} had rejected lines: ${JSON.stringify(r.rejected)}`);
          out.review[`${c.key}:${monthOf(file)}`] = r.reviewId;
        }
      }
    }
    for (const s of data.share_links) {
      const reviewId = out.review[`${s.client}:${s.month}`];
      const { token, link } = await createShareLink(db, reviewId, s.otp_email, s.approver_name, s.created_by);
      out.share = { token, linkId: link.id };
    }
  }
  return out;
}
