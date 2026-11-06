import { secret } from "./env";
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { shareLinks } from "@/db/schema";

const SECRET = secret;
export const LINK_TTL_DAYS = 14;
const OTP_TTL_MS = 10 * 60 * 1000;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Token = <random>.<hmac(random + reviewId)>; only its hash is stored. */
export function mintToken(reviewId: string) {
  const rand = randomBytes(24).toString("base64url");
  const sig = createHmac("sha256", SECRET()).update(`${rand}.${reviewId}`).digest("base64url");
  return `${rand}.${sig}`;
}

export function tokenMatchesReview(token: string, reviewId: string) {
  const [rand, sig] = token.split(".");
  if (!rand || !sig) return false;
  const want = createHmac("sha256", SECRET()).update(`${rand}.${reviewId}`).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createShareLink(db: Db, reviewId: string, otpEmail: string, approverName?: string, createdBy?: string) {
  const token = mintToken(reviewId);
  const expiresAt = new Date(Date.now() + LINK_TTL_DAYS * 86_400_000);
  const [row] = await db
    .insert(shareLinks)
    .values({ reviewId, tokenHash: sha256(token), expiresAt, otpEmail, approverName, createdBy })
    .returning();
  return { token, link: row };
}

export type LinkState =
  | { ok: true; link: typeof shareLinks.$inferSelect }
  | { ok: false; reason: "invalid" | "expired" | "revoked" };

export async function resolveLink(db: Db, token: string): Promise<LinkState> {
  const [link] = await db.select().from(shareLinks).where(eq(shareLinks.tokenHash, sha256(token))).limit(1);
  if (!link || !tokenMatchesReview(token, link.reviewId)) return { ok: false, reason: "invalid" };
  if (link.revokedAt) return { ok: false, reason: "revoked" };
  if (link.expiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" };
  return { ok: true, link };
}

/** Issue an OTP for the link's email. Returned so the caller can deliver it (logged in dev). */
export async function issueOtp(db: Db, linkId: string) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db
    .update(shareLinks)
    .set({ otpHash: sha256(`${linkId}:${code}`), otpExpiresAt: new Date(Date.now() + OTP_TTL_MS) })
    .where(eq(shareLinks.id, linkId));
  return code;
}

export async function verifyOtp(db: Db, link: typeof shareLinks.$inferSelect, code: string) {
  if (!link.otpHash || !link.otpExpiresAt || link.otpExpiresAt.getTime() < Date.now()) return false;
  const a = Buffer.from(link.otpHash), b = Buffer.from(sha256(`${link.id}:${code.trim()}`));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Signed session cookie value proving this browser passed the OTP for this link. */
export function sessionCookie(linkId: string) {
  const exp = Date.now() + 24 * 3_600_000;
  const sig = createHmac("sha256", SECRET()).update(`${linkId}.${exp}`).digest("base64url");
  return `${linkId}.${exp}.${sig}`;
}

export function sessionValid(cookie: string | undefined, linkId: string) {
  if (!cookie) return false;
  const [id, exp, sig] = cookie.split(".");
  if (id !== linkId || Number(exp) < Date.now()) return false;
  const want = createHmac("sha256", SECRET()).update(`${id}.${exp}`).digest("base64url");
  const a = Buffer.from(sig ?? ""), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function revokeLink(db: Db, linkId: string) {
  await db.update(shareLinks).set({ revokedAt: new Date() }).where(eq(shareLinks.id, linkId));
}
