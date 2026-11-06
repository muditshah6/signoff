import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { comments, findings, findingVersions, followups, memos, reviews } from "@/db/schema";
import { appendAudit, type Actor } from "./audit";
import { matchingRules, recordEpisode, touchRules } from "./memory";

export type FindingInput = {
  title: string; detail?: string; issue_type: string; vendor?: string;
  severity: "low" | "medium" | "high"; suggested_action?: string;
  basis: "rule" | "episode" | "reference" | "parametric";
  txn_ids: string[]; memory_refs?: { kind: "rule" | "episode" | "reference"; id: string }[];
  confidence?: number;
};

const nextMonth = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

/**
 * Claude-authored writes are capped to draft status. If an active human-approved rule
 * covers the vendor, the finding is stored as a low-severity "suppressed" line, never hidden.
 */
export async function submitFindings(
  db: Db,
  p: { firmId: string; clientId: string; reviewId: string; items: FindingInput[] },
) {
  const out: { id: string; status: string; suppressed_by?: string }[] = [];
  for (const f of p.items) {
    const rules = await matchingRules(db, p.clientId, f.vendor, f.issue_type);
    const suppressed = rules.length > 0;
    const refs = [...(f.memory_refs ?? []), ...rules.map((r) => ({ kind: "rule" as const, id: r.id }))];
    const [row] = await db.insert(findings).values({
      firmId: p.firmId, reviewId: p.reviewId, clientId: p.clientId, title: f.title, detail: f.detail,
      issueType: f.issue_type, vendor: f.vendor?.toLowerCase(),
      severity: suppressed ? "low" : f.severity, suggestedAction: f.suggested_action,
      basis: suppressed ? "rule" : f.basis, txnIds: f.txn_ids, memoryRefs: refs,
      confidence: f.confidence, status: suppressed ? "suppressed" : "ai_draft", authorType: "claude",
      detail_: undefined,
    } as never).returning();
    await db.insert(findingVersions).values({
      findingId: row.id, version: 1, authorType: "claude", diffJson: { created: true, title: f.title },
    });
    if (suppressed) await touchRules(db, rules.map((r) => r.id));
    out.push({ id: row.id, status: row.status, ...(suppressed && { suppressed_by: rules[0].content }) });
  }
  await db.update(reviews).set({ status: "in_review" })
    .where(and(eq(reviews.id, p.reviewId), eq(reviews.status, "draft")));
  await appendAudit(db, {
    firmId: p.firmId, clientId: p.clientId, actor: { type: "claude" }, action: "findings.submitted",
    entity: `review:${p.reviewId}`, payload: { count: p.items.length },
  });
  return out;
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
  await db.insert(findingVersions).values({
    findingId: cur.id, version: 99999 - Math.floor(Math.random() * 1000), authorType: "user",
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
    await db.insert(followups).values({
      firmId: p.firmId, clientId: cur.clientId, dueMonth: nextMonth(month),
      text: p.decision === "needs_receipt" ? `Receipt needed: ${cur.title}` : `Re-check disputed item: ${cur.title}`,
      txnIds: cur.txnIds, sourceFindingId: cur.id,
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
