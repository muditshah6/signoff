import { and, asc, desc, eq, gte, ilike, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { auditEvents, clients, followups, references, reviews, transactions } from "@/db/schema";
import { appendAudit } from "@/lib/audit";
import { untrusted } from "@/lib/csv";
import { reviewStatus, submitFindings, writeMemo, type FindingInput } from "@/lib/findings";
import { buildStartBundle, proposeMemory, recallEpisodes } from "@/lib/memory";
import type { Ctx } from "@/lib/rbac";
import { ingestFile } from "@/lib/ingest";
import { assertClient, assertReview, visibleClientIds } from "@/lib/scope";

export type ToolCtx = { db: Db; ctx: Ctx; origin?: string };
const reviewUrl = (t: ToolCtx, id: string) => (t.origin ? `${t.origin}/reviews/${id}` : `/reviews/${id}`);
const claude = (c: Ctx) => ({ type: "claude" as const, id: c.name });

/** Chat entry point. Claude passes the attached file's text verbatim; the server parses, masks and fingerprints it. */
export async function ingestCsv(t: ToolCtx, a: { client_id: string; month: string; csv_text: string }) {
  await assertClient(t.db, t.ctx, a.client_id, "csv.upload");
  const r = await ingestFile(t.db, {
    firmId: t.ctx.firmId, clientId: a.client_id, month: a.month, text: a.csv_text, source: "chat", actor: claude(t.ctx),
  });
  return {
    review_id: r.reviewId, review_url: reviewUrl(t, r.reviewId), source: r.source, sha256: r.sha256,
    row_count: r.rowCount, total: r.total, currency: r.currency, missing_receipts: r.missingReceipts,
    rejected: r.rejected, injection_suspected: r.injectionSuspected, replaced_previous: r.replacedPrevious,
    next: r.rejected.length
      ? `${r.rejected.length} line(s) were rejected and left out. Show them to the user and stop unless they say to continue; then call start_review.`
      : "Show these numbers to the user, then call start_review.",
  };
}

export async function listClients({ db, ctx }: ToolCtx) {
  const ids = await visibleClientIds(db, ctx);
  if (!ids.length) return [];
  const cs = await db.select().from(clients).where(inArray(clients.id, ids)).orderBy(asc(clients.name));
  const out = [];
  for (const c of cs) {
    const [last] = await db.select({ m: reviews.month }).from(reviews).where(eq(reviews.clientId, c.id)).orderBy(desc(reviews.month)).limit(1);
    const [fu] = await db.select({ n: sql<number>`count(*)::int` }).from(followups)
      .where(and(eq(followups.clientId, c.id), inArray(followups.status, ["open", "escalated"])));
    out.push({ client_id: c.id, name: c.name, source_tools: c.sourceTools, last_review_month: last?.m ?? null, open_followups: fu.n });
  }
  return out;
}

export async function startReview(t: ToolCtx, a: { client_id: string; month: string }) {
  const { db, ctx } = t;
  const client = await assertClient(db, ctx, a.client_id, "review.run");
  const [review] = await db.select().from(reviews).where(and(eq(reviews.clientId, a.client_id), eq(reviews.month, a.month))).limit(1);
  const txns = review ? await db.select().from(transactions).where(eq(transactions.reviewId, review.id)) : [];
  if (!review || txns.length === 0) {
    throw new Error(`No file was ingested (chat) or uploaded (app) for ${a.month}. Attach the export in Claude and call ingest_csv, or ask the bookkeeper to upload it in the Signoff app.`);
  }
  const bundle = await buildStartBundle(db, { firmId: ctx.firmId, clientId: a.client_id, vendorKeys: txns.map((x) => x.vendorKey) });
  await db.update(reviews).set({ playbookVersion: bundle.playbook?.version ?? null, status: review.status === "draft" ? "in_review" : review.status })
    .where(eq(reviews.id, review.id));

  // A new review cycle ages every open follow-up once; 2 cycles open escalates it.
  const stamp = `review_started:${review.id}`;
  const [seen] = await db.select({ id: auditEvents.id }).from(auditEvents)
    .where(and(eq(auditEvents.firmId, ctx.firmId), eq(auditEvents.entity, stamp))).limit(1);
  if (!seen) {
    const open = await db.select().from(followups).where(and(eq(followups.clientId, a.client_id), eq(followups.status, "open")));
    for (const f of open) {
      if (f.dueMonth > a.month) continue;
      const cycles = f.cyclesOpen + 1;
      await db.update(followups).set({ cyclesOpen: cycles, status: cycles >= 2 ? "escalated" : "open" }).where(eq(followups.id, f.id));
    }
    await appendAudit(db, {
      firmId: ctx.firmId, clientId: a.client_id, actor: claude(ctx), action: "review.started", entity: stamp,
      payload: { month: a.month, playbook: bundle.playbook?.version, rules: bundle.semantic.length, followups: bundle.prospective.length },
    });
  }
  const after = await buildStartBundle(db, { firmId: ctx.firmId, clientId: a.client_id, vendorKeys: txns.map((x) => x.vendorKey) });
  return {
    review_id: review.id,
    review_url: reviewUrl(t, review.id),
    client: { name: client.name },
    csv_stats: {
      count: txns.length,
      total: Math.round(txns.reduce((s, x) => s + x.amount, 0) * 100) / 100,
      missing_receipts: txns.filter((x) => x.receiptStatus === "missing").length,
      injection_suspected: txns.filter((x) => x.injectionSuspected).map((x) => x.extId),
    },
    procedural: after.playbook ? { playbook_version: after.playbook.version, body: after.playbook.body } : null,
    semantic: after.semantic,
    prospective: after.prospective,
    rules_under_review: after.rules_under_review,
    token_budget_note: "Bundle capped near 2,000 tokens; top 20 rules ranked by vendor match in this month's CSV, recency, hit_count.",
  };
}

export type TxnFilter = {
  vendor?: string; category?: string; min_amount?: number; max_amount?: number;
  receipt?: "missing" | "attached"; date_from?: string; date_to?: string; ext_ids?: string[];
};

export async function queryTransactions(t: ToolCtx, a: { review_id: string; filter?: TxnFilter; limit?: number; cursor?: string }) {
  const r = await assertReview(t.db, t.ctx, a.review_id);
  const f = a.filter ?? {};
  const limit = Math.min(a.limit ?? 50, 50);
  const conds = [eq(transactions.reviewId, r.id), eq(transactions.clientId, r.clientId)];
  if (f.vendor) conds.push(ilike(transactions.merchant, `%${f.vendor.replace(/[%_]/g, "")}%`));
  if (f.category) conds.push(eq(transactions.category, f.category));
  if (f.min_amount != null) conds.push(gte(transactions.amount, f.min_amount));
  if (f.max_amount != null) conds.push(lte(transactions.amount, f.max_amount));
  if (f.receipt) conds.push(eq(transactions.receiptStatus, f.receipt));
  if (f.date_from) conds.push(gte(transactions.txnDate, f.date_from));
  if (f.date_to) conds.push(lte(transactions.txnDate, f.date_to));
  if (f.ext_ids?.length) conds.push(inArray(transactions.extId, f.ext_ids));
  const offset = a.cursor ? Number(a.cursor) || 0 : 0;
  const rows = await t.db.select().from(transactions).where(and(...conds)).orderBy(asc(transactions.extId)).limit(limit + 1).offset(offset);
  const page = rows.slice(0, limit);
  return {
    rows: page.map((x) => ({
      ext_id: x.extId, txn_date: x.txnDate, amount: x.amount, currency: x.currency, category: x.category,
      card_last4: x.cardLast4, employee: x.employee, department: x.department, receipt_status: x.receiptStatus,
      merchant: untrusted(x.merchant), notes: untrusted(x.notes), injection_suspected: x.injectionSuspected,
    })),
    next_cursor: rows.length > limit ? String(offset + limit) : null,
  };
}

export async function recall(t: ToolCtx, a: { client_id: string; vendor?: string; issue_type?: string; k?: number }) {
  await assertClient(t.db, t.ctx, a.client_id);
  return recallEpisodes(t.db, { clientId: a.client_id, vendor: a.vendor, issueType: a.issue_type, k: a.k });
}

export async function lookupReference(t: ToolCtx, a: { topic: string }) {
  const topic = a.topic.replace(/[%_]/g, "");
  const rows = await t.db.select().from(references)
    .where(and(eq(references.firmId, t.ctx.firmId), ilike(references.topic, `${topic}%`)))
    .orderBy(desc(references.version)).limit(5);
  return rows.map((r) => ({ topic: r.topic, version: r.version, body: r.body, source_url: r.sourceUrl, as_of: r.asOf }));
}

export async function submit(t: ToolCtx, a: { review_id: string; findings: FindingInput[] }) {
  const r = await assertReview(t.db, t.ctx, a.review_id, "review.run");
  const created = await submitFindings(t.db, {
    firmId: t.ctx.firmId, clientId: r.clientId, reviewId: r.id, actor: claude(t.ctx), items: a.findings,
  });
  return { created };
}

export async function memo(t: ToolCtx, a: { review_id: string; markdown: string }) {
  const r = await assertReview(t.db, t.ctx, a.review_id, "review.run");
  const m = await writeMemo(t.db, {
    firmId: t.ctx.firmId, clientId: r.clientId, reviewId: r.id, markdown: a.markdown, authorType: "claude", actor: claude(t.ctx),
  });
  return { memo_version: m.version };
}

export async function createFollowup(t: ToolCtx, a: { client_id: string; due_month: string; text: string; txn_ids?: string[] }) {
  await assertClient(t.db, t.ctx, a.client_id, "review.run");
  const [f] = await t.db.insert(followups).values({
    firmId: t.ctx.firmId, clientId: a.client_id, dueMonth: a.due_month, text: a.text, txnIds: a.txn_ids ?? [],
  }).returning();
  await appendAudit(t.db, {
    firmId: t.ctx.firmId, clientId: a.client_id, actor: claude(t.ctx), action: "followup.created",
    entity: `followup:${f.id}`, payload: { due: a.due_month },
  });
  return { followup_id: f.id };
}

export async function propose(t: ToolCtx, a: { client_id: string; type: "semantic" | "procedural"; key: string; content: string; evidence_ids: string[] }) {
  await assertClient(t.db, t.ctx, a.client_id, "review.run");
  const item = await proposeMemory(t.db, {
    firmId: t.ctx.firmId, clientId: a.client_id, type: a.type, key: a.key, content: a.content, evidenceIds: a.evidence_ids,
  });
  return { memory_id: item.id, status: "pending" };
}

export async function status(t: ToolCtx, a: { review_id: string }) {
  const r = await assertReview(t.db, t.ctx, a.review_id);
  return { status: r.status, findings: await reviewStatus(t.db, a.review_id) };
}
