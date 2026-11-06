import { secret } from "./env";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { firms, users } from "@/db/schema";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Ctx } from "./rbac";

const SECRET = secret;
const sign = (uid: string) => createHmac("sha256", SECRET()).update(`user:${uid}`).digest("base64url");

export const sessionToken = (uid: string) => `${uid}.${sign(uid)}`;

/**
 * v1 firm login: signed cookie. The login page is a dev stub (pick a seeded user);
 * swap it for an email magic link before exposing a real deployment.
 */
export async function getSession() {
  const raw = (await cookies()).get("so_session")?.value;
  const [uid, sig] = (raw ?? "").split(".");
  if (!uid || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(sign(uid));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const db = await getDb();
  const [user] = await db.select().from(users).where(eq(users.id, uid)).limit(1);
  if (!user || user.disabledAt) return null; // re-resolved every request, so a disable takes effect immediately
  const [firm] = await db.select().from(firms).where(eq(firms.id, user.firmId)).limit(1);
  const ctx: Ctx = { firmId: user.firmId, userId: user.id, role: user.role, actor: "user", name: user.name };
  return { db, user, firm, ctx };
}

export async function requireSession() {
  const s = await getSession();
  if (!s) redirect("/login");
  return s;
}

/** The public origin for links shown to users: env override, else the host this request came in on. */
export async function appOrigin() {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const { headers } = await import("next/headers");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
