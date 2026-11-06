import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { episodes, followups, memoryItems, playbooks } from "@/db/schema";
import { appendAudit, type Actor } from "./audit";

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
export const vendorKey = (v: string) => `vendor:${norm(v)}`;

/** ~4 chars per token; the start_review bundle is capped near 2,000 tokens. */
const BUNDLE_CHAR_BUDGET = 8000;

/* ---------------- Episodic: written by the app from human actions only ---------------- */

export async function recordEpisode(
  db: Db,
  p: {
    firmId: string; clientId: string; month: string; vendor?: string | null; issueType: string;
    aiSaid?: string | null; humanChange?: string | null; clientDecision?: string | null;
    reason?: string | null; decidedBy: string; sourceFindingId?: string;
  },
) {
  const [ep] = await db
    .insert(episodes)
    .values({ ...p, vendor: p.vendor ? norm(p.vendor) : null })
    .returning();
  await flagContradictions(db, p.firmId, p.clientId, ep);
  return ep;
}

/**
 * A new human decision that contradicts an active rule (e.g. rule says "pre-approved"
 * but the client now disputes it) moves the rule to under_review. Never resolved silently.
 */
async function flagContradictions(db: Db, firmId: string, clientId: string, ep: typeof episodes.$inferSelect) {
  if (!ep.vendor || !ep.clientDecision) return;
  const rules = await db
    .select()
    .from(memoryItems)
    .where(and(
      eq(memoryItems.clientId, clientId), eq(memoryItems.status, "active"),
      eq(memoryItems.key, vendorKey(ep.vendor)),
    ));
  for (const r of rules) {
    const ruleSaysOk = /pre-?approved|allowed|exempt|ignore/i.test(r.content);
    if (ruleSaysOk && ep.clientDecision === "disputed" && !/valid|pre-?approved/i.test(ep.reason ?? "")) {
      await db.update(memoryItems).set({ status: "under_review" }).where(eq(memoryItems.id, r.id));
      await appendAudit(db, {
        firmId, clientId, actor: { type: "system" }, action: "memory.under_review",
        entity: `memory_item:${r.id}`, payload: { episodeId: ep.id },
      });
    }
  }
}

export async function recallEpisodes(
  db: Db,
  p: { clientId: string; vendor?: string; issueType?: string; k?: number },
) {
  const k = Math.min(p.k ?? 5, 5);
  const conds = [eq(episodes.clientId, p.clientId)];
  if (p.vendor) conds.push(eq(episodes.vendor, norm(p.vendor)));
  if (p.issueType) conds.push(eq(episodes.issueType, p.issueType));
  const rows = await db.select().from(episodes).where(and(...conds)).orderBy(desc(episodes.decidedAt)).limit(k);
  return rows.map((e) => ({
    id: e.id, month: e.month, vendor: e.vendor, issue_type: e.issueType,
    ai_said: e.aiSaid, client_decision: e.clientDecision, reason: e.reason,
    matched_on: [p.vendor && "vendor", p.issueType && "issue_type"].filter(Boolean),
  }));
}

/** Count of consistent episodes for a vendor+issue+decision, used to gate propose_memory. */
export async function consistentEpisodeCount(db: Db, clientId: string, vendor: string, issueType: string) {
  const rows = await db
    .select({ d: episodes.clientDecision, n: sql<number>`count(*)::int` })
    .from(episodes)
    .where(and(eq(episodes.clientId, clientId), eq(episodes.vendor, norm(vendor)), eq(episodes.issueType, issueType)))
    .groupBy(episodes.clientDecision);
  return rows.reduce((m, r) => Math.max(m, r.n), 0);
}

/* ---------------- Semantic / procedural: proposal queue + lifecycle ---------------- */

export async function proposeMemory(
  db: Db,
  p: {
    firmId: string; clientId: string; type: "semantic" | "procedural"; key: string;
    content: string; evidenceIds: string[]; vendor?: string; issueType?: string;
  },
) {
  const ev = p.evidenceIds.length
    ? await db.select({ id: episodes.id }).from(episodes)
        .where(and(eq(episodes.clientId, p.clientId), inArray(episodes.id, p.evidenceIds)))
    : [];
  if (ev.length < 2) {
    throw new Error("propose_memory needs 2 or more evidence episodes belonging to this client");
  }
  const [item] = await db
    .insert(memoryItems)
    .values({
      firmId: p.firmId, clientId: p.clientId, type: p.type, key: p.key.toLowerCase(),
      vendor: p.vendor ? norm(p.vendor) : null, issueType: p.issueType ?? null,
      content: p.content, status: "pending", evidenceIds: ev.map((e) => e.id), author: "claude",
    })
    .returning();
  await appendAudit(db, {
    firmId: p.firmId, clientId: p.clientId, actor: { type: "claude" },
    action: "memory.proposed", entity: `memory_item:${item.id}`, payload: { key: item.key },
  });
  return item;
}

/** Only a human can make memory durable. Callers pass the acting user. */
export async function decideProposal(
  db: Db,
  p: { firmId: string; itemId: string; decision: "approve" | "reject"; actor: Actor; editedContent?: string },
) {
  const [item] = await db.select().from(memoryItems)
    .where(and(eq(memoryItems.id, p.itemId), eq(memoryItems.firmId, p.firmId))).limit(1);
  if (!item || item.status !== "pending") throw new Error("Proposal not found or not pending");
  const patch = p.decision === "approve"
    ? { status: "active" as const, validFrom: new Date(), author: p.actor.id ?? "user", content: p.editedContent ?? item.content }
    : { status: "retired" as const, validTo: new Date() };
  await db.update(memoryItems).set(patch).where(eq(memoryItems.id, item.id));
  await appendAudit(db, {
    firmId: p.firmId, clientId: item.clientId, actor: p.actor,
    action: p.decision === "approve" ? "memory.activated" : "memory.rejected",
    entity: `memory_item:${item.id}`, payload: { key: item.key },
  });
}

export async function retireMemory(db: Db, firmId: string, itemId: string, actor: Actor) {
  const [item] = await db.update(memoryItems)
    .set({ status: "retired", validTo: new Date() })
    .where(and(eq(memoryItems.id, itemId), eq(memoryItems.firmId, firmId))).returning();
  if (!item) throw new Error("Memory item not found");
  await appendAudit(db, {
    firmId, clientId: item.clientId, actor, action: "memory.retired", entity: `memory_item:${item.id}`,
  });
}

/* ---------------- start_review bundle ---------------- */

export async function buildStartBundle(db: Db, p: { firmId: string; clientId: string; month: string }) {
  const [pb] = await db.select().from(playbooks)
    .where(and(eq(playbooks.firmId, p.firmId)))
    .orderBy(desc(playbooks.version)).limit(1);

  const rules = await db.select().from(memoryItems)
    .where(and(eq(memoryItems.clientId, p.clientId), inArray(memoryItems.status, ["active", "under_review"])))
    .orderBy(desc(memoryItems.hitCount), desc(memoryItems.lastUsedAt)).limit(20);

  const open = await db.select().from(followups)
    .where(and(eq(followups.clientId, p.clientId), eq(followups.status, "open")));

  let used = (pb?.body.length ?? 0);
  const keptRules: typeof rules = [];
  for (const r of rules) {
    used += r.content.length + r.key.length + 40;
    if (used > BUNDLE_CHAR_BUDGET) break;
    keptRules.push(r);
  }
  return {
    playbook: pb ? { version: pb.version, body: pb.body } : null,
    rules: keptRules.map((r) => ({
      id: r.id, key: r.key, type: r.type, content: r.content, status: r.status,
      ...(r.status === "under_review" && { warning: "Contradicted by a recent human decision; confirm with the bookkeeper" }),
    })),
    open_followups: open.map((f) => ({
      id: f.id, due_month: f.dueMonth, text: f.text, txn_ids: f.txnIds, cycles_open: f.cyclesOpen,
      ...(f.cyclesOpen >= 2 && { escalated: true }),
    })),
    truncated: keptRules.length < rules.length,
    playbookVersion: pb?.version ?? null,
  };
}

/** Rules matching a vendor (and optionally issue type) for a client, for suppression + hit counting. */
export async function matchingRules(db: Db, clientId: string, vendor: string | null | undefined, issueType?: string) {
  if (!vendor) return [];
  const rows = await db.select().from(memoryItems)
    .where(and(eq(memoryItems.clientId, clientId), eq(memoryItems.status, "active"), eq(memoryItems.key, vendorKey(vendor))));
  return issueType ? rows.filter((r) => !r.issueType || r.issueType === issueType) : rows;
}

export async function touchRules(db: Db, ids: string[]) {
  if (!ids.length) return;
  await db.update(memoryItems)
    .set({ hitCount: sql`${memoryItems.hitCount} + 1`, lastUsedAt: new Date() })
    .where(inArray(memoryItems.id, ids));
}
