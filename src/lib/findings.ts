import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { comments, episodes, findings, findingVersions, followups, memoryItems, memos, reviews, transactions } from "@/db/schema";
import { appendAudit, type Actor } from "./audit";
import { matchingRules, recordEpisode, touchRules } from "./memory";

export type FindingInput = {
  title: string; issue_type: string; severity: "low" | "medium" | "high"; suggested_action?: string;
  basis: "rule" | "episode" | "reference" | "parametric";
  txn_ids: string[]; // external ids such as VP-10014
  memory_refs?: string[]; // rule or episode ids belonging to this client
  confidence?: number; suppressed_by?: string;
  detail?: string; // plain-language why, shown to the client
};

const nextMonth = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

/**
 * Claude-authored writes are forced to draft status. A finding is stored as a low-severity
 * "suppressed" line when Claude cites a past episode, or when an active human-approved rule
 * covers the vendor. It is never hidden.
 */
export async function submitFindings(
  db: Db,
  p: { firmId: string; clientId: string; reviewId: string; actor: Actor; items: FindingInput[] },
) {
  const txns = await db.select().from(transactions).where(eq(transactions.reviewId, p.reviewId));
  const byExt = new Map(txns.map((t) => [t.extId, t]));
  const refIds = [...new Set(p.items.flatMap((i) => [...(i.memory_refs ?? []), ...(i.suppressed_by ? [i.suppressed_by] : [])]))];
  const rules = refIds.length ? await db.select().from(memoryItems).where(and(eq(memoryItems.clientId, p.clientId), inArray(memoryItems.id, refIds))) : [];
  const eps = refIds.length ? await db.select().from(episodes).where(and(eq(episodes.clientId, p.clientId), inArray(episodes.id, refIds))) : [];
  const kindOf = new Map<string, "rule" | "episode">([...rules.map((r) => [r.id, "rule"] as const), ...eps.map((e) => [e.id, "episode"] as const)]);

  // validate everything first so a bad item stores nothing
  for (const f of p.items) {
    const unknown = f.txn_ids.filter((x) => !byExt.has(x));
    if (unknown.length) throw new Error(`Unknown txn_ids for this review: ${unknown.join(", ")}`);
    const badRef = [...(f.memory_refs ?? []), ...(f.suppressed_by ? [f.suppressed_by] : [])].filter((r) => !kindOf.has(r));
    if (badRef.length) throw new Error(`memory_refs not found for this client: ${badRef.join(", ")}`);
  }

  const created: string[] = [];
  for (const f of p.items) {
    const rows = f.txn_ids.map((x) => byExt.get(x)!);
    const vendor = rows[0]?.vendorKey;
    const covering = await matchingRules(db, p.clientId, vendor, f.issue_type);
    const suppressed = Boolean(f.suppressed_by) || covering.length > 0;
    const refs = [...new Set([...(f.memory_refs ?? []), ...covering.map((r) => r.id)])].map((id) => ({ kind: kindOf.get(id) ?? "rule", id }));
    const [row] = await db.insert(findings).values({
      firmId: p.firmId, reviewId: p.reviewId, clientId: p.clientId, title: f.title, detail: f.detail,
      issueType: f.issue_type, vendor, severity: suppressed ? "low" : f.severity,
      suggestedAction: f.suggested_action, basis: f.basis,
      txnIds: rows.map((t) => t.id), memoryRefs: refs, confidence: f.confidence,
      status: suppressed ? "suppressed" : "ai_draft", authorType: "claude",
      suppressedBy: f.suppressed_by ?? covering[0]?.id,
    }).returning();
    await db.insert(findingVersions).values({
      findingId: row.id, version: 1, authorType: "claude", diffJson: { created: true, title: f.title, severity: f.severity },
    });
    if (covering.length) await touchRules(db, covering.map((r) => r.id));
    const cited = (f.memory_refs ?? []).filter((r) => kindOf.get(r) === "rule");
    if (cited.length) await touchRules(db, cited);
    await appendAudit(db, {
      firmId: p.firmId, clientId: p.clientId, actor: p.actor, action: "finding.created",
      entity: `finding:${row.id}`, payload: { title: f.title, status: row.status },
    });
    created.push(row.id);
  }
  await db.update(reviews).set({ status: "in_review" })
    .where(and(eq(reviews.id, p.reviewId), eq(reviews.status, "draft")));
  return created;
}

export async function writeMemo(
  db: Db,
  p: { firmId: string; clientId: string; reviewId: string; markdown: string; authorType: "claude" | "user"; actor: Actor },
) {
  const [last] = await db.select({ v: memos.version }).from(memos)
    .where(eq(memos.reviewId, p.reviewId)).orderBy(desc(memos.version)).limit(1);
  const [m] = await db.insert(memos).values({
    reviewId: p.reviewId, version: (last?.v ?? 0) + 1, markdown: p.markdown, authorType: p.authorType,
  }).returning();
  await appendAudit(db, {
    firmId: p.firmId, clientId: p.clientId, actor: p.actor, action: "memo.written",
    entity: `memo:${m.id}`, payload: { version: m.version },
  });
  return m;
}

/** Human edit: writes a version with a diff and flips the finding to "edited". */
export async function editFinding(
  db: Db,
  p: {
    firmId: string; findingId: string; actor: Actor;
    patch: Partial<Pick<typeof findings.$inferSelect, "title" | "detail" | "severity" | "suggestedAction" | "owner">>;
  },
) {
  const [cur] = await db.select().from(findings)
    .where(and(eq(findings.id, p.findingId), eq(findings.firmId, p.firmId))).limit(1);
  if (!cur) throw new Error("Finding not found");
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(p.patch)) {
    const before = (cur as Record<string, unknown>)[k];
    if (v !== undefined && v !== before) diff[k] = { from: before, to: v };
  }
  if (!Object.keys(diff).length) return cur;
  const [v] = await db.select({ n: sql<number>`coalesce(max(${findingVersions.version}),0)::int` })
    .from(findingVersions).where(eq(findingVersions.findingId, cur.id));
  const keepStatus = ["approved", "disputed", "needs_receipt"].includes(cur.status);
  const [upd] = await db.update(findings).set({
    ...p.patch, authorType: "user", status: keepStatus ? cur.status : "edited",
  }).where(eq(findings.id, cur.id)).returning();
  await db.insert(findingVersions).values({
    findingId: cur.id, version: v.n + 1, authorType: "user", authorId: p.actor.id, diffJson: diff,
  });
  await appendAudit(db, {
    firmId: p.firmId, clientId: cur.clientId, actor: p.actor, action: "finding.edited",
    entity: `finding:${cur.id}`, payload: { diff },
  });
  if (diff.severity || diff.title) {
    await recordEpisode(db, {
      firmId: p.firmId, clientId: cur.clientId, month: await reviewMonth(db, cur.reviewId),
      vendor: cur.vendor, issueType: cur.issueType, aiSaid: cur.title,
      humanChange: JSON.stringify(diff), decidedBy: p.actor.id ?? "user", sourceFindingId: cur.id,
    });
  }
  return upd;
}

/** "Drop" keeps the row (audit + version history) but removes it from the working set. */
export async function dropFinding(db: Db, p: { firmId: string; findingId: string; actor: Actor; reason?: string }) {
  const [cur] = await db.update(findings).set({ status: "dropped", decisionReason: p.reason ?? null })
    .where(and(eq(findings.id, p.findingId), eq(findings.firmId, p.firmId))).returning();
  if (!cur) throw new Error("Finding not found");
  const [v] = await db.select({ n: sql<number>`coalesce(max(${findingVersions.version}),0)::int` })
    .from(findingVersions).where(eq(findingVersions.findingId, cur.id));
  await db.insert(findingVersions).values({
    findingId: cur.id, version: v.n + 1, authorType: "user",
    authorId: p.actor.id, diffJson: { dropped: true, reason: p.reason ?? null },
  });
  await appendAudit(db, {
    firmId: p.firmId, clientId: cur.clientId, actor: p.actor, action: "finding.dropped",
    entity: `finding:${cur.id}`, payload: { reason: p.reason ?? null },
  });
  await recordEpisode(db, {
    firmId: p.firmId, clientId: cur.clientId, month: await reviewMonth(db, cur.reviewId),
    vendor: cur.vendor, issueType: cur.issueType, aiSaid: cur.title,
    humanChange: "dropped as false positive", reason: p.reason, decidedBy: p.actor.id ?? "user",
    sourceFindingId: cur.id,
  });
}

async function reviewMonth(db: Db, reviewId: string) {
  const [r] = await db.select({ m: reviews.month }).from(reviews).where(eq(reviews.id, reviewId));
  return r.m;
}

/** Client decision from the share page. Only the client path can set approved/disputed/needs_receipt. */
export async function decideFinding(
  db: Db,
  p: {
    firmId: string; findingId: string; reviewId: string; decision: "approved" | "disputed" | "needs_receipt";
    reason?: string; by: string; comment?: string;
  },
) {
  const [cur] = await db.select().from(findings)
    .where(and(eq(findings.id, p.findingId), eq(findings.reviewId, p.reviewId))).limit(1);
  if (!cur || ["dropped"].includes(cur.status)) throw new Error("Finding not found");
  if (p.decision === "disputed" && !p.reason?.trim()) throw new Error("A dispute needs a reason");
  await db.update(findings).set({
    status: p.decision, decisionReason: p.reason ?? null, decidedBy: p.by, decidedAt: new Date(),
  }).where(eq(findings.id, cur.id));
  const [v] = await db.select({ n: sql<number>`coalesce(max(${findingVersions.version}),0)::int` })
    .from(findingVersions).where(eq(findingVersions.findingId, cur.id));
  await db.insert(findingVersions).values({
    findingId: cur.id, version: v.n + 1, authorType: "client", authorId: p.by,
    diffJson: { status: { from: cur.status, to: p.decision }, reason: p.reason ?? null },
  });
  if (p.comment?.trim()) {
    await db.insert(comments).values({ findingId: cur.id, authorType: "client", authorName: p.by, body: p.comment });
  }
  const month = await reviewMonth(db, p.reviewId);
  await recordEpisode(db, {
    firmId: p.firmId, clientId: cur.clientId, month, vendor: cur.vendor, issueType: cur.issueType,
    aiSaid: cur.title, clientDecision: p.decision, reason: p.reason, decidedBy: p.by, sourceFindingId: cur.id,
  });
  if (p.decision === "needs_receipt" || p.decision === "disputed") {
    const tx = cur.txnIds.length ? await db.select({ e: transactions.extId }).from(transactions).where(inArray(transactions.id, cur.txnIds)) : [];
    await db.insert(followups).values({
      firmId: p.firmId, clientId: cur.clientId, dueMonth: nextMonth(month),
      text: p.decision === "needs_receipt" ? `Receipt needed: ${cur.title}` : `Re-check disputed item: ${cur.title}`,
      txnIds: tx.map((x) => x.e), sourceFindingId: cur.id,
    });
  } else {
    // approving resolves any open follow-up tied to this finding
    await db.update(followups).set({ status: "done" })
      .where(and(eq(followups.sourceFindingId, cur.id), eq(followups.status, "open")));
  }
  await appendAudit(db, {
    firmId: p.firmId, clientId: cur.clientId, actor: { type: "client", id: p.by },
    action: `finding.${p.decision}`, entity: `finding:${cur.id}`, payload: { reason: p.reason ?? null },
  });
  await maybeClose(db, p.firmId, p.reviewId, cur.clientId);
}

async function maybeClose(db: Db, firmId: string, reviewId: string, clientId: string) {
  const rows = await db.select({ s: findings.status }).from(findings).where(eq(findings.reviewId, reviewId));
  const live = rows.filter((r) => !["dropped", "suppressed"].includes(r.s));
  if (live.length && live.every((r) => ["approved", "disputed", "needs_receipt"].includes(r.s))) {
    await db.update(reviews).set({ status: "closed" }).where(eq(reviews.id, reviewId));
    await appendAudit(db, { firmId, clientId, actor: { type: "system" }, action: "review.closed", entity: `review:${reviewId}` });
  }
}

export async function listFindings(db: Db, reviewId: string) {
  return db.select().from(findings).where(eq(findings.reviewId, reviewId)).orderBy(asc(findings.createdAt));
}

export async function reviewStatus(db: Db, reviewId: string) {
  const fs = await listFindings(db, reviewId);
  const ids = fs.map((f) => f.id);
  const cs = ids.length ? await db.select().from(comments).where(inArray(comments.findingId, ids)) : [];
  return fs.map((f) => ({
    id: f.id, title: f.title, status: f.status, reason: f.decisionReason,
    comments: cs.filter((c) => c.findingId === f.id).map((c) => ({ by: c.authorName, body: c.body })),
  }));
}

/** Merge 2+ findings into the first: union of source txns, the others are removed (kept in history). */
export async function mergeFindings(db: Db, p: { firmId: string; ids: string[]; actor: Actor }) {
  if (p.ids.length < 2) throw new Error("Select at least two findings to merge");
  const rows = await db.select().from(findings).where(and(eq(findings.firmId, p.firmId), inArray(findings.id, p.ids)));
  if (rows.length !== p.ids.length || new Set(rows.map((r) => r.reviewId)).size !== 1) throw new Error("Findings must belong to one review");
  const [keep, ...rest] = p.ids.map((id) => rows.find((r) => r.id === id)!);
  const txnIds = [...new Set(rows.flatMap((r) => r.txnIds))];
  const sevRank = { low: 0, medium: 1, high: 2 } as const;
  const severity = rows.reduce((m, r) => (sevRank[r.severity] > sevRank[m] ? r.severity : m), keep.severity);
  await db.update(findings).set({ txnIds, severity, authorType: "user", status: "edited" }).where(eq(findings.id, keep.id));
  const [v] = await db.select({ n: sql<number>`coalesce(max(${findingVersions.version}),0)::int` }).from(findingVersions).where(eq(findingVersions.findingId, keep.id));
  await db.insert(findingVersions).values({
    findingId: keep.id, version: v.n + 1, authorType: "user", authorId: p.actor.id,
    diffJson: { merged: rest.map((r) => r.title), txn_ids: txnIds.length },
  });
  for (const r of rest) {
    await db.update(findings).set({ status: "dropped", decisionReason: `merged into "${keep.title}"` }).where(eq(findings.id, r.id));
  }
  await appendAudit(db, {
    firmId: p.firmId, clientId: keep.clientId, actor: p.actor, action: "finding.merged",
    entity: `finding:${keep.id}`, payload: { merged: rest.map((r) => r.id) },
  });
}

/** Undo a removal. The finding returns as a human-touched edit. */
export async function restoreFinding(db: Db, p: { firmId: string; findingId: string; actor: Actor }) {
  const [cur] = await db.update(findings).set({ status: "edited", decisionReason: null })
    .where(and(eq(findings.id, p.findingId), eq(findings.firmId, p.firmId), eq(findings.status, "dropped"))).returning();
  if (!cur) throw new Error("Finding is not removed");
  await appendAudit(db, { firmId: p.firmId, clientId: cur.clientId, actor: p.actor, action: "finding.restored", entity: `finding:${cur.id}` });
}

/**
 * A person confirms Claude's suppression of a repeat flag. This is a human act, so it becomes an episode:
 * the second consistent decision that lets Claude propose a lasting rule.
 */
export async function confirmSuppression(db: Db, p: { firmId: string; findingId: string; actor: Actor }) {
  const [f] = await db.select().from(findings)
    .where(and(eq(findings.id, p.findingId), eq(findings.firmId, p.firmId), eq(findings.status, "suppressed"))).limit(1);
  if (!f) throw new Error("Finding is not a suppressed flag");
  let reason: string | null = null;
  if (f.suppressedBy) {
    const [src] = await db.select().from(episodes).where(eq(episodes.id, f.suppressedBy));
    reason = src?.reason ?? null;
  }
  const ep = await recordEpisode(db, {
    firmId: p.firmId, clientId: f.clientId, month: await reviewMonth(db, f.reviewId), vendor: f.vendor, issueType: f.issueType,
    aiSaid: f.title, humanChange: "confirmed suppression", reason, decidedBy: p.actor.id ?? "user", sourceFindingId: f.id,
  });
  await appendAudit(db, {
    firmId: p.firmId, clientId: f.clientId, actor: p.actor, action: "finding.suppression_confirmed",
    entity: `finding:${f.id}`, payload: { episode: ep.id },
  });
  return ep;
}
