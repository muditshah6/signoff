import { createHash } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { auditEvents } from "@/db/schema";

export type Actor = {
  type: "claude" | "user" | "client" | "system";
  id?: string;
};

export const GENESIS = "0".repeat(64);

/** Deterministic JSON: keys sorted so hashing is stable across JSONB round-trips. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function computeHash(
  prevHash: string,
  e: {
    seq: number; clientId: string | null; actorType: string; actorId: string | null;
    action: string; entity: string | null; payload: unknown; createdAt: Date;
  },
): string {
  const body = canonical({
    seq: e.seq, clientId: e.clientId, actorType: e.actorType, actorId: e.actorId,
    action: e.action, entity: e.entity, payload: e.payload,
    createdAt: e.createdAt.toISOString(),
  });
  return createHash("sha256").update(prevHash + body).digest("hex");
}

/** Append one event to the firm's chain. Append-only: there is no update/delete path. */
export async function appendAudit(
  db: Db,
  p: {
    firmId: string; clientId?: string | null; actor: Actor;
    action: string; entity?: string | null; payload?: Record<string, unknown>;
  },
) {
  return db.transaction(async (tx) => {
    const [last] = await tx
      .select({ seq: auditEvents.seq, hash: auditEvents.hash })
      .from(auditEvents)
      .where(eq(auditEvents.firmId, p.firmId))
      .orderBy(desc(auditEvents.seq))
      .limit(1);
    const seq = (last?.seq ?? 0) + 1;
    const prevHash = last?.hash ?? GENESIS;
    const createdAt = new Date();
    const row = {
      seq, clientId: p.clientId ?? null, actorType: p.actor.type,
      actorId: p.actor.id ?? null, action: p.action, entity: p.entity ?? null,
      payload: p.payload ?? {}, createdAt,
    };
    const hash = computeHash(prevHash, row);
    await tx.insert(auditEvents).values({
      firmId: p.firmId, seq, clientId: row.clientId, actorType: row.actorType,
      actorId: row.actorId, action: row.action, entity: row.entity,
      payloadJson: row.payload, prevHash, hash, createdAt,
    });
    return { seq, hash };
  });
}

export type ChainStatus =
  | { ok: true; count: number }
  | { ok: false; count: number; brokenAtSeq: number; reason: string };

/** Recompute the whole chain; report the first broken link. */
export async function verifyChain(db: Db, firmId: string): Promise<ChainStatus> {
  const rows = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.firmId, firmId))
    .orderBy(asc(auditEvents.seq));
  let prev = GENESIS;
  let expectedSeq = 1;
  for (const r of rows) {
    if (r.seq !== expectedSeq) {
      return { ok: false, count: rows.length, brokenAtSeq: expectedSeq, reason: "missing event (sequence gap)" };
    }
    if (r.prevHash !== prev) {
      return { ok: false, count: rows.length, brokenAtSeq: r.seq, reason: "prev_hash does not match prior event" };
    }
    const h = computeHash(prev, {
      seq: r.seq, clientId: r.clientId, actorType: r.actorType, actorId: r.actorId,
      action: r.action, entity: r.entity, payload: r.payloadJson, createdAt: r.createdAt,
    });
    if (h !== r.hash) {
      return { ok: false, count: rows.length, brokenAtSeq: r.seq, reason: "event contents changed after write" };
    }
    prev = r.hash;
    expectedSeq++;
  }
  return { ok: true, count: rows.length };
}

export async function listAudit(db: Db, firmId: string, clientId?: string) {
  return db
    .select()
    .from(auditEvents)
    .where(clientId ? and(eq(auditEvents.firmId, firmId), eq(auditEvents.clientId, clientId)) : eq(auditEvents.firmId, firmId))
    .orderBy(desc(auditEvents.seq));
}
