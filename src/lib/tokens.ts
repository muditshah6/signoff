import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { mcpTokens, users } from "@/db/schema";
import type { Ctx } from "./rbac";
import { sha256 } from "./share";

/** Personal MCP bearer token. Only its hash is stored; the plain token is shown once. */
export const newMcpToken = () => `sgn_${randomBytes(24).toString("base64url")}`;

export async function issueToken(db: Db, p: { firmId: string; userId: string; token?: string }) {
  const token = p.token ?? newMcpToken();
  await db.insert(mcpTokens).values({ firmId: p.firmId, userId: p.userId, tokenHash: sha256(token) });
  return token;
}

/** Revokes the person's current tokens and issues a fresh one. */
export async function rotateMcpToken(db: Db, firmId: string, userId: string) {
  await db.update(mcpTokens).set({ revokedAt: new Date() }).where(and(eq(mcpTokens.userId, userId), isNull(mcpTokens.revokedAt)));
  return issueToken(db, { firmId, userId });
}

/**
 * token -> acting context. No match (unknown, revoked, disabled user, auditor) -> null -> HTTP 401.
 * Claude gets exactly the role and client assignments of the person who connected it.
 */
export async function resolveToken(db: Db, token: string): Promise<Ctx | null> {
  const [row] = await db
    .select({ t: mcpTokens, u: users })
    .from(mcpTokens).innerJoin(users, eq(users.id, mcpTokens.userId))
    .where(and(eq(mcpTokens.tokenHash, sha256(token)), isNull(mcpTokens.revokedAt))).limit(1);
  if (!row || row.u.disabledAt || row.u.role === "auditor") return null;
  await db.update(mcpTokens).set({ lastUsedAt: new Date() }).where(eq(mcpTokens.id, row.t.id));
  return { firmId: row.u.firmId, userId: row.u.id, role: row.u.role, actor: "claude", name: row.u.name };
}

/** Fixed-window limiter: 60 calls/minute per token holder (in-memory; swap for Redis if scaled out). */
const windows = new Map<string, { start: number; n: number }>();
export function rateLimited(key: string, limit = 60, now = Date.now()) {
  const w = windows.get(key);
  if (!w || now - w.start >= 60_000) {
    windows.set(key, { start: now, n: 1 });
    return false;
  }
  w.n++;
  return w.n > limit;
}
