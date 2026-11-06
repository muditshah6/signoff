import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { clientAssignments, clients, reviews } from "@/db/schema";
import { appendAudit } from "./audit";
import { can, type Action, type Ctx } from "./rbac";

export class ForbiddenError extends Error {
  status = 403;
  constructor(msg = "Forbidden: you do not have access to this client") {
    super(msg);
  }
}

/** A refusal the caller can act on, surfaced to Claude as { code, message }. */
export class CodedError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

async function deny(db: Db, ctx: Ctx, what: string, clientId?: string): Promise<never> {
  await appendAudit(db, {
    firmId: ctx.firmId, clientId: clientId ?? null,
    actor: { type: ctx.actor, id: ctx.name }, action: "access.denied", payload: { what, role: ctx.role },
  });
  throw new ForbiddenError();
}

/** Clients this person may see: everyone's for owner/manager/auditor, assigned ones for bookkeepers. */
export async function visibleClientIds(db: Db, ctx: Ctx): Promise<string[]> {
  const all = await db.select({ id: clients.id }).from(clients).where(eq(clients.firmId, ctx.firmId));
  if (ctx.role !== "bookkeeper") return all.map((c) => c.id);
  const mine = await db.select({ id: clientAssignments.clientId }).from(clientAssignments).where(eq(clientAssignments.userId, ctx.userId));
  const set = new Set(mine.map((m) => m.id));
  return all.filter((c) => set.has(c.id)).map((c) => c.id);
}

/** Every tool and server action calls this before touching client data. Denials are audited. */
export async function assertClient(db: Db, ctx: Ctx, clientId: string, action: Action = "client.read") {
  const [c] = await db.select().from(clients).where(and(eq(clients.id, clientId), eq(clients.firmId, ctx.firmId))).limit(1);
  if (!c) return deny(db, ctx, `client ${clientId}`);
  if (!can(ctx.role, action)) return deny(db, ctx, action, clientId);
  if (ctx.role === "bookkeeper" && !(await visibleClientIds(db, ctx)).includes(clientId)) return deny(db, ctx, `client ${c.name}`, clientId);
  return c;
}

export async function assertReview(db: Db, ctx: Ctx, reviewId: string, action: Action = "client.read") {
  const [r] = await db.select().from(reviews).where(and(eq(reviews.id, reviewId), eq(reviews.firmId, ctx.firmId))).limit(1);
  if (!r) return deny(db, ctx, `review ${reviewId}`);
  await assertClient(db, ctx, r.clientId, action);
  return r;
}
