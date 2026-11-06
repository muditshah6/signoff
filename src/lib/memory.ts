import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { episodes, followups, memoryItems, playbooks } from "@/db/schema";
import { appendAudit, type Actor } from "./audit";
import { normaliseVendor } from "./csv";

const norm = (s: string | null | undefined) => normaliseVendor(s ?? "");

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
  const [ep] = await db.insert(episodes).values({ ...p, vendor: p.vendor ? norm(p.vendor) : null }).returning();
  await flagContradictions(db, p.firmId, p.clientId, ep);
  return ep;
}

/**
 * A new human decision that contradicts an active rule (the rule says "pre-approved" but the
 * client now disputes it without that reason) moves the rule to under_review. Never resolved silently.
 */
async function flagContradictions(db: Db, firmId: string, clientId: string, ep: typeof episodes.$inferSelect) {
  if (!ep.vendor || !ep.clientDecision) return;
  const rules = await db.select().from(memoryItems).where(and(
    eq(memoryItems.clientId, clientId), eq(memoryItems.status, "active"), eq(memoryItems.vendor, ep.vendor),
  ));
  for (const r of rules) {
    if (r.issueType && r.issueType !== ep.issueType) continue;
    const ruleSaysOk = /pre-?approved|allowed|exempt|ignore|do not flag/i.test(r.content);
    if (ruleSaysOk && ep.clientDecision === "disputed" && !/valid|pre-?approved/i.test(ep.reason ?? "")) {
      await db.update(memoryItems).set({ status: "under_review" }).where(eq(memoryItems.id, r.id));
      await appendAudit(db, {
        firmId, clientId, actor: { type: "system" }, action: "memory.under_review",
        entity: `memory_item:${r.id}`, payload: { episodeId: ep.id },
      });
    }
  }
}

/** Vendor matches exact or by prefix on the normalised name; issue type is exact. Newest first. */
export async function recallEpisodes(
  db: Db,
  p: { clientId: string; vendor?: string; issueType?: string; k?: number },
) {
  if (!p.vendor && !p.issueType) throw new Error("Give at least one of vendor or issue_type");
  const k = Math.min(p.k ?? 5, 5);
  const conds = [eq(episodes.clientId, p.clientId)];
  if (p.vendor) {
    const v = norm(p.vendor);
    conds.push(or(eq(episodes.vendor, v), like(episodes.vendor, `${v}%`))!);
  }
  if (p.issueType) conds.push(eq(episodes.issueType, p.issueType));
  const rows = await db.select().from(episodes).where(and(...conds)).orderBy(desc(episodes.decidedAt)).limit(k);
  return rows.map((e) => ({
    episode_id: e.id, month: e.month, vendor: e.vendor, issue_type: e.issueType, ai_said: e.aiSaid,
    human_change: e.humanChange, client_decision: e.clientDecision, reason: e.reason, decided_by: e.decidedBy,
  }));
}

/* ---------------- Semantic / procedural: proposal queue + lifecycle ---------------- */

export async function proposeMemory(
  db: Db,
  p: {
    firmId: string; clientId: string; type: "semantic" | "procedural"; key: string;
    content: string; evidenceIds: string[];
  },
) {
  const ev = p.evidenceIds.length
    ? await db.select().from(episodes).where(and(eq(episodes.clientId, p.clientId), inArray(episodes.id, p.evidenceIds)))
    : [];
  if (ev.length < 2 || new Set(ev.map((e) => e.id)).size < 2) {
    throw new Error("propose_memory needs 2 or more distinct evidence episodes belonging to this client");
  }
  const key = p.key.trim().toLowerCase();
  const [dup] = await db.select({ id: memoryItems.id }).from(memoryItems)
    .where(and(eq(memoryItems.clientId, p.clientId), eq(memoryItems.key, key), eq(memoryItems.status, "pending"))).limit(1);
  if (dup) throw new Error("A proposal with this key is already pending");

  // key looks like "vendor:taj hotels|issue:policy_breach"; split it so rules can be matched exactly.
  const vendor = key.match(/vendor:([^|]+)/)?.[1]?.trim() ?? null;
  const issueType = key.match(/issue:([^|]+)/)?.[1]?.trim() ?? null;
  const [item] = await db.insert(memoryItems).values({
    firmId: p.firmId, clientId: p.clientId, type: p.type, key, vendor, issueType,
    content: p.content, status: "pending", evidenceIds: ev.map((e) => e.id), author: "claude",
  }).returning();
  await appendAudit(db, {
    firmId: p.firmId, clientId: p.clientId, actor: { type: "claude" },
    action: "memory.proposed", entity: `memory_item:${item.id}`, payload: { key, evidence: ev.length },
  });
  return item;
}

/** Only a human with memory.decide can make memory durable; callers check that before calling. */
export async function decideProposal(
  db: Db,
  p: { firmId: string; itemId: string; decision: "approve" | "reject"; actor: Actor; editedContent?: string },
) {
  const [item] = await db.select().from(memoryItems)
    .where(and(eq(memoryItems.id, p.itemId), eq(memoryItems.firmId, p.firmId))).limit(1);
  if (!item || item.status !== "pending") throw new Error("Proposal not found or not pending");
  const patch = p.decision === "approve"
    ? { status: "active" as const, validFrom: new Date(), approvedBy: p.actor.id ?? "user", content: p.editedContent ?? item.content }
    : { status: "retired" as const, validTo: new Date() };
  await db.update(memoryItems).set(patch).where(eq(memoryItems.id, item.id));
  await appendAudit(db, {
    firmId: p.firmId, clientId: item.clientId, actor: p.actor,
    action: p.decision === "approve" ? "memory.approved" : "memory.rejected",
    entity: `memory_item:${item.id}`, payload: { key: item.key },
  });
}

export async function retireMemory(db: Db, firmId: string, itemId: string, actor: Actor) {
  const [item] = await db.update(memoryItems)
    .set({ status: "retired", validTo: new Date() })
    .where(and(eq(memoryItems.id, itemId), eq(memoryItems.firmId, firmId))).returning();
  if (!item) throw new Error("Memory item not found");
  await appendAudit(db, { firmId, clientId: item.clientId, actor, action: "memory.retired", entity: `memory_item:${item.id}` });
}

/* ---------------- start_review bundle ---------------- */

/** Top 20 active rules: vendor present in this month's CSV first, then recency, then hit count. */
export async function buildStartBundle(
  db: Db,
  p: { firmId: string; clientId: string; vendorKeys: string[] },
) {
  const [pb] = await db.select().from(playbooks).where(eq(playbooks.firmId, p.firmId))
    .orderBy(desc(playbooks.version)).limit(1);

  const all = await db.select().from(memoryItems)
    .where(and(eq(memoryItems.clientId, p.clientId), inArray(memoryItems.status, ["active", "under_review"])));
  const inCsv = (r: typeof all[number]) => (r.vendor && p.vendorKeys.some((v) => v === r.vendor || v.startsWith(r.vendor!)) ? 1 : 0);
  const ranked = all
    .sort((a, b) => inCsv(b) - inCsv(a) || (b.lastUsedAt?.getTime() ?? 0) - (a.lastUsedAt?.getTime() ?? 0) || b.hitCount - a.hitCount)
    .slice(0, 20);

  let used = pb?.body.length ?? 0;
  const kept: typeof ranked = [];
  for (const r of ranked) {
    used += r.content.length + r.key.length + 40;
    if (used > BUNDLE_CHAR_BUDGET) break;
    kept.push(r);
  }
  const open = await db.select().from(followups)
    .where(and(eq(followups.clientId, p.clientId), inArray(followups.status, ["open", "escalated"])));

  return {
    playbook: pb ? { version: pb.version, body: pb.body } : null,
    semantic: kept.filter((r) => r.status === "active").map((r) => ({
      memory_id: r.id, key: r.key, content: r.content, approved_by: r.approvedBy, since: r.validFrom?.toISOString().slice(0, 10) ?? null,
    })),
    rules_under_review: kept.filter((r) => r.status === "under_review").map((r) => ({
      memory_id: r.id, key: r.key, content: r.content,
      warning: "Contradicted by a recent human decision. Confirm with the bookkeeper before relying on it.",
    })),
    prospective: open.map((f) => ({
      followup_id: f.id, due_month: f.dueMonth, text: f.text, txn_ids: f.txnIds, cycles_open: f.cyclesOpen,
      ...(f.status === "escalated" && { escalated: true }),
    })),
    truncated: kept.length < ranked.length,
  };
}

/** Active rules covering a vendor (and issue type), used to suppress a repeat flag and count hits. */
export async function matchingRules(db: Db, clientId: string, vendor: string | null | undefined, issueType?: string) {
  if (!vendor) return [];
  const v = norm(vendor);
  const rows = await db.select().from(memoryItems)
    .where(and(eq(memoryItems.clientId, clientId), eq(memoryItems.status, "active"), eq(memoryItems.type, "semantic")));
  return rows.filter((r) => r.vendor && (v === r.vendor || v.startsWith(r.vendor)) && (!r.issueType || !issueType || r.issueType === issueType));
}

export async function touchRules(db: Db, ids: string[]) {
  if (!ids.length) return;
  await db.update(memoryItems)
    .set({ hitCount: sql`${memoryItems.hitCount} + 1`, lastUsedAt: new Date() })
    .where(inArray(memoryItems.id, ids));
}
