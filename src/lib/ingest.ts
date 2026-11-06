import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { reviews, sourceFiles, transactions } from "@/db/schema";
import { appendAudit, type Actor } from "./audit";
import { ingestVolopayCsv, type Rejected, type Source } from "./csv";
import { CodedError } from "./scope";

/**
 * The single door data enters through. Chat (`ingest_csv`) and app upload both call this.
 * Callers must already have checked the actor may edit this client.
 *
 * Valid rows are kept; bad lines are listed in `rejected`. A second file for the same client-month
 * replaces the rows only while the review is a draft (the old file is marked superseded).
 */
export async function ingestFile(
  db: Db,
  p: { firmId: string; clientId: string; month: string; text: string; source: Source; actor: Actor },
) {
  if (!/^\d{4}-\d{2}$/.test(p.month)) throw new CodedError("bad_month", "month must be YYYY-MM");
  const parsed = ingestVolopayCsv(p.text, { source: p.source });
  if (!parsed.ok) throw new CodedError("rejected_file", parsed.fatal);

  // rows dated outside the month are left out and reported, not silently imported
  const rejected: Rejected[] = [...parsed.rejected];
  const rows = parsed.rows.filter((r) => {
    if (r.txnDate.startsWith(p.month)) return true;
    rejected.push({ line: r.line, error: `${r.extId} is dated ${r.txnDate}, outside ${p.month}` });
    return false;
  });
  rejected.sort((a, b) => a.line - b.line);
  if (rows.length === 0) {
    throw new CodedError("nothing_imported", `No valid rows to import. ${rejected.slice(0, 3).map((r) => `Line ${r.line}: ${r.error}`).join(" · ")}`);
  }

  const [existing] = await db.select().from(reviews).where(and(eq(reviews.clientId, p.clientId), eq(reviews.month, p.month))).limit(1);
  if (existing && existing.status !== "draft") {
    throw new CodedError("review_started", "Start a new review or ask a manager");
  }
  const review = existing ?? (await db.insert(reviews).values({ firmId: p.firmId, clientId: p.clientId, month: p.month }).returning())[0];

  let replaced = false;
  if (existing) {
    await db.delete(transactions).where(eq(transactions.reviewId, review.id));
    const prior = await db.update(sourceFiles).set({ superseded: true })
      .where(and(eq(sourceFiles.reviewId, review.id), eq(sourceFiles.superseded, false))).returning({ id: sourceFiles.id });
    replaced = prior.length > 0;
  }

  await db.insert(transactions).values(rows.map(({ line: _line, ...r }) => {
    void _line;
    return { ...r, firmId: p.firmId, reviewId: review.id, clientId: p.clientId };
  }));
  const s = parsed.stats;
  const total = Math.round(rows.reduce((a, r) => a + r.amount, 0) * 100) / 100;
  await db.insert(sourceFiles).values({
    firmId: p.firmId, clientId: p.clientId, reviewId: review.id, source: p.source, sha256: s.sha256, bytes: s.bytes,
    rowCount: rows.length, total, rejected, maskedText: parsed.maskedText, createdBy: p.actor.id,
  });
  await appendAudit(db, {
    firmId: p.firmId, clientId: p.clientId, actor: p.actor, action: "ingest.completed", entity: `review:${review.id}`,
    payload: {
      source: p.source, month: p.month, rows: rows.length, total, rejected: rejected.length,
      sha256: s.sha256.slice(0, 12), replacedPrevious: replaced, cardsMasked: true,
      injectionSuspected: rows.filter((r) => r.injectionSuspected).length,
    },
  });

  return {
    reviewId: review.id, source: p.source, sha256: s.sha256, rowCount: rows.length, total, currency: s.currency,
    missingReceipts: rows.filter((r) => r.receiptStatus === "missing").length, rejected,
    injectionSuspected: rows.filter((r) => r.injectionSuspected).map((r) => r.extId), replacedPrevious: replaced,
  };
}
