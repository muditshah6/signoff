import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { clients, reviews } from "@/db/schema";

export class ForbiddenError extends Error {
  status = 403;
  constructor(msg = "Forbidden: client does not belong to this firm") {
    super(msg);
  }
}

/** Every MCP tool and server action calls this before touching client data. */
export async function assertClient(db: Db, firmId: string, clientId: string) {
  const [c] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.firmId, firmId)))
    .limit(1);
  if (!c) throw new ForbiddenError();
  return c;
}

export async function assertReview(db: Db, firmId: string, reviewId: string) {
  const [r] = await db
    .select()
    .from(reviews)
    .where(and(eq(reviews.id, reviewId), eq(reviews.firmId, firmId)))
    .limit(1);
  if (!r) throw new ForbiddenError("Forbidden: review does not belong to this firm");
  return r;
}
