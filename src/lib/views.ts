import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  clients, episodes, findings, findingVersions, followups, memoryItems, memos, reviews, shareLinks, sourceFiles, transactions,
} from "@/db/schema";
import type { Ctx } from "./rbac";
import { assertReview } from "./scope";

export async function loadReview(db: Db, ctx: Ctx, reviewId: string) {
  const review = await assertReview(db, ctx, reviewId);
  const [client] = await db.select().from(clients).where(eq(clients.id, review.clientId));
  const [memo] = await db.select().from(memos).where(eq(memos.reviewId, reviewId)).orderBy(desc(memos.version)).limit(1);
  const all = await db.select().from(findings).where(eq(findings.reviewId, reviewId)).orderBy(findings.createdAt);

  const txnIds = [...new Set(all.flatMap((f) => f.txnIds))];
  const txns = txnIds.length ? await db.select().from(transactions).where(inArray(transactions.id, txnIds)) : [];
  const txnById = new Map(txns.map((t) => [t.id, t]));
  const withTxns = all.map((f) => {
    const rows = f.txnIds.map((id) => txnById.get(id)).filter((t): t is NonNullable<typeof t> => Boolean(t));
    return { ...f, txns: rows, amount: rows.reduce((s, t) => s + t.amount, 0) };
  });

  // "Memory used": every rule and episode any finding relied on or was suppressed by.
  const refs = all.flatMap((f) => (f.memoryRefs as { kind: string; id: string }[]) ?? []);
  const ids = [...new Set([...refs.map((r) => r.id), ...all.map((f) => f.suppressedBy).filter((x): x is string => Boolean(x))])];
  const rules = ids.length ? await db.select().from(memoryItems).where(inArray(memoryItems.id, ids)) : [];
  const eps = ids.length ? await db.select().from(episodes).where(inArray(episodes.id, ids)) : [];
  const fus = await db.select().from(followups).where(and(eq(followups.clientId, client.id), inArray(followups.status, ["open", "escalated"])));

  const [source] = await db.select().from(sourceFiles)
    .where(and(eq(sourceFiles.reviewId, reviewId), eq(sourceFiles.superseded, false))).orderBy(desc(sourceFiles.createdAt)).limit(1);
  const links = await db.select().from(shareLinks).where(eq(shareLinks.reviewId, reviewId)).orderBy(desc(shareLinks.createdAt));
  const fids = all.map((f) => f.id);
  const versions = fids.length ? await db.select().from(findingVersions).where(inArray(findingVersions.findingId, fids)).orderBy(findingVersions.version) : [];
  const months = await db.select({ id: reviews.id, month: reviews.month }).from(reviews).where(eq(reviews.clientId, client.id)).orderBy(reviews.month);
  const idx = months.findIndex((m) => m.id === reviewId);
  const [{ n: pending }] = await db.select({ n: sql<number>`count(*)::int` }).from(memoryItems).where(and(eq(memoryItems.clientId, client.id), eq(memoryItems.status, "pending")));

  return {
    review, client, memo, source, findings: withTxns, rules, eps, followups: fus, links, versions,
    prev: months[idx - 1] ?? null, next: months[idx + 1] ?? null, pendingProposals: pending,
  };
}

export type ReviewData = Awaited<ReturnType<typeof loadReview>>;
