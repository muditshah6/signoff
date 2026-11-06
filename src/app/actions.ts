"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { reviews, shareLinks, users } from "@/db/schema";
import { appendAudit } from "@/lib/audit";
import { confirmSuppression, decideFinding, dropFinding, editFinding, mergeFindings, restoreFinding, writeMemo } from "@/lib/findings";
import { ingestFile } from "@/lib/ingest";
import { decideProposal, retireMemory } from "@/lib/memory";
import { can, DENIED_REASON, type Action } from "@/lib/rbac";
import { assertClient, assertReview, CodedError, ForbiddenError } from "@/lib/scope";
import { requireSession, sessionToken } from "@/lib/session";
import {
  createShareLink, issueOtp, resolveLink, revokeLink, sessionCookie, sessionValid, verifyOtp,
} from "@/lib/share";
import { rotateMcpToken } from "@/lib/tokens";
import { cookieSecure, demoLoginEnabled, isDemo, isProd } from "@/lib/env";
import { sendEmail } from "@/lib/mail";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const fail = (path: string, msg: string): never => redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(msg)}`);

/** Role check for actions that are not tied to one client. Friendly message, never a stack trace. */
async function need(action: Action, back: string) {
  const s = await requireSession();
  if (!can(s.ctx.role, action)) fail(back, DENIED_REASON[action] ?? "You do not have permission to do that");
  return s;
}

async function guard<T>(back: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof ForbiddenError) return fail(back, "You do not have access to that client");
    if (e instanceof Error && !("digest" in e)) return fail(back, e.message);
    throw e;
  }
}

/* ---------------- firm side ---------------- */

export async function loginAs(f: FormData) {
  // Enforced here, not just hidden in the UI: without DEMO_MODE a deployment has no open sign-in.
  if (!demoLoginEnabled()) redirect("/login");
  const db = await getDb();
  const [u] = await db.select().from(users).where(eq(users.id, str(f, "user_id"))).limit(1);
  if (!u || u.disabledAt) redirect("/login");
  (await cookies()).set("so_session", sessionToken(u.id), { httpOnly: true, sameSite: "lax", path: "/", secure: cookieSecure() });
  redirect("/clients");
}

export async function logout() {
  (await cookies()).delete("so_session");
  redirect("/login");
}

export async function uploadCsvAction(f: FormData) {
  const { db, ctx } = await need("csv.upload", "/clients");
  const file = f.get("csv");
  const clientId = str(f, "client_id"), month = str(f, "month");
  if (!(file instanceof File) || file.size === 0) fail("/clients", "Choose a CSV file");
  await guard("/clients", () => assertClient(db, ctx, clientId, "csv.upload"));
  let reviewId: string;
  try {
    reviewId = (await ingestFile(db, {
      firmId: ctx.firmId, clientId, month, text: await (file as File).text(), source: "upload", actor: { type: "user", id: ctx.name },
    })).reviewId;
  } catch (e) {
    if (e instanceof CodedError) return fail("/clients", e.message);
    throw e;
  }
  redirect(`/reviews/${reviewId}`);
}

export async function saveEditsAction(f: FormData) {
  const reviewId = str(f, "review_id");
  const back = `/reviews/${reviewId}/edit`;
  const { db, ctx } = await need("finding.edit", back);
  await guard(back, async () => {
    await assertReview(db, ctx, reviewId, "finding.edit");
    for (const id of f.getAll("id").map(String)) {
      const sev = str(f, `severity_${id}`);
      await editFinding(db, {
        firmId: ctx.firmId, findingId: id, actor: { type: "user", id: ctx.name },
        patch: {
          title: str(f, `title_${id}`) || undefined,
          suggestedAction: str(f, `action_${id}`) || undefined,
          owner: str(f, `owner_${id}`) || undefined,
          severity: sev === "low" || sev === "medium" || sev === "high" ? sev : undefined,
        },
      });
    }
  });
  revalidatePath(back);
  redirect(`${back}?saved=1`);
}

export async function mergeAction(f: FormData) {
  const reviewId = str(f, "review_id");
  const back = `/reviews/${reviewId}/edit`;
  const { db, ctx } = await need("finding.edit", back);
  await guard(back, async () => {
    await assertReview(db, ctx, reviewId, "finding.edit");
    await mergeFindings(db, { firmId: ctx.firmId, ids: f.getAll("select").map(String), actor: { type: "user", id: ctx.name } });
  });
  redirect(`${back}?saved=1`);
}

export async function removeFindingAction(f: FormData) {
  const reviewId = str(f, "review_id");
  const back = `/reviews/${reviewId}/edit`;
  const { db, ctx } = await need("finding.edit", back);
  await guard(back, async () => {
    await assertReview(db, ctx, reviewId, "finding.edit");
    if (str(f, "undo")) await restoreFinding(db, { firmId: ctx.firmId, findingId: str(f, "finding_id"), actor: { type: "user", id: ctx.name } });
    else await dropFinding(db, { firmId: ctx.firmId, findingId: str(f, "finding_id"), actor: { type: "user", id: ctx.name }, reason: str(f, "reason") || "false positive" });
  });
  redirect(`${back}?saved=1`);
}

export async function confirmSuppressionAction(f: FormData) {
  const reviewId = str(f, "review_id");
  const back = `/reviews/${reviewId}/edit`;
  const { db, ctx } = await need("finding.edit", back);
  await guard(back, async () => {
    await assertReview(db, ctx, reviewId, "finding.edit");
    await confirmSuppression(db, { firmId: ctx.firmId, findingId: str(f, "finding_id"), actor: { type: "user", id: ctx.name } });
  });
  redirect(`${back}?saved=1`);
}

export async function saveMemoAction(f: FormData) {
  const reviewId = str(f, "review_id");
  const back = `/reviews/${reviewId}/edit`;
  const { db, ctx } = await need("finding.edit", back);
  await guard(back, async () => {
    const r = await assertReview(db, ctx, reviewId, "finding.edit");
    await writeMemo(db, { firmId: ctx.firmId, clientId: r.clientId, reviewId: r.id, markdown: str(f, "markdown"), authorType: "user", actor: { type: "user", id: ctx.name } });
  });
  redirect(`${back}?saved=1`);
}

export async function createShareAction(f: FormData) {
  const reviewId = str(f, "review_id");
  const back = `/reviews/${reviewId}`;
  const { db, ctx } = await need("review.share", back);
  const out = await guard(back, async () => {
    const r = await assertReview(db, ctx, reviewId, "review.share");
    const { token, link } = await createShareLink(db, r.id, str(f, "email"), str(f, "approver") || undefined, ctx.name);
    await db.update(reviews).set({ status: "shared" }).where(eq(reviews.id, r.id));
    await appendAudit(db, {
      firmId: ctx.firmId, clientId: r.clientId, actor: { type: "user", id: ctx.name },
      action: "share_link.created", entity: `share_link:${link.id}`,
      payload: { expires: link.expiresAt.toISOString().slice(0, 10), otp_to: link.otpEmail },
    });
    return token;
  });
  redirect(`${back}?share=${encodeURIComponent(out)}`); // the token is only shown once, right after creation
}

export async function revokeShareAction(f: FormData) {
  const { db, ctx } = await requireSession();
  const [l] = await db.select().from(shareLinks).where(eq(shareLinks.id, str(f, "link_id"))).limit(1);
  if (!l) return;
  const back = `/reviews/${l.reviewId}`;
  await guard(back, async () => {
    if (!can(ctx.role, "review.share")) throw new Error(DENIED_REASON["review.share"]);
    const r = await assertReview(db, ctx, l.reviewId, "review.share");
    await revokeLink(db, l.id);
    await appendAudit(db, { firmId: ctx.firmId, clientId: r.clientId, actor: { type: "user", id: ctx.name }, action: "share_link.revoked", entity: `share_link:${l.id}` });
  });
  revalidatePath(back);
}

export async function decideProposalAction(f: FormData) {
  const back = str(f, "back") || "/clients";
  const { db, ctx } = await need("memory.decide", back);
  await guard(back, () => decideProposal(db, {
    firmId: ctx.firmId, itemId: str(f, "item_id"), decision: str(f, "decision") === "approve" ? "approve" : "reject",
    actor: { type: "user", id: ctx.name }, editedContent: str(f, "content") || undefined,
  }));
  redirect(`${back}${back.includes("?") ? "&" : "?"}decided=${str(f, "decision")}`);
}

export async function retireMemoryAction(f: FormData) {
  const back = str(f, "back") || "/clients";
  const { db, ctx } = await need("memory.retire", back);
  await guard(back, () => retireMemory(db, ctx.firmId, str(f, "item_id"), { type: "user", id: ctx.name }));
  revalidatePath(back);
}

export async function rotateTokenAction() {
  const { db, ctx } = await need("token.manage", "/connect");
  const token = await rotateMcpToken(db, ctx.firmId, ctx.userId);
  await appendAudit(db, { firmId: ctx.firmId, actor: { type: "user", id: ctx.name }, action: "mcp_token.rotated" });
  redirect(`/connect?token=${encodeURIComponent(token)}`);
}

/* ---------------- client approver (share page) ---------------- */

export async function sendOtpAction(f: FormData) {
  const db = await getDb();
  const token = str(f, "token");
  const st = await resolveLink(db, token);
  if (!st.ok) redirect(`/s/${token}`);
  else {
    const code = await issueOtp(db, st.link.id);
    const mail = await sendEmail({
      to: st.link.otpEmail, subject: "Your Signoff verification code",
      text: `Your code is ${code}. It expires in 10 minutes. If you did not expect this, ignore this email.`,
    });
    if (!isProd()) console.log(`[signoff] OTP for ${st.link.otpEmail}: ${code}`); // dev convenience only, never in production
    if (mail.sent || !isProd()) redirect(`/s/${token}?otp=sent`);
    else if (isDemo()) {
      // Public demo with no mail provider: show the code on the page (clearly labelled), synthetic data only.
      (await cookies()).set("so_demo_otp", `${st.link.id}:${code}`, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600, secure: cookieSecure() });
      redirect(`/s/${token}?otp=sent&demo=1`);
    } else redirect(`/s/${token}?otp=unavailable`);
  }
}

export async function verifyOtpAction(f: FormData) {
  const db = await getDb();
  const token = str(f, "token");
  const st = await resolveLink(db, token);
  if (!st.ok) redirect(`/s/${token}`);
  else if (!(await verifyOtp(db, st.link, str(f, "code")))) redirect(`/s/${token}?otp=sent&bad=1`);
  else {
    (await cookies()).set(`so_share_${st.link.id}`, sessionCookie(st.link.id), { httpOnly: true, sameSite: "lax", path: "/", maxAge: 86_400, secure: cookieSecure() });
    redirect(`/s/${token}`);
  }
}

export async function decideAction(f: FormData) {
  const db = await getDb();
  const token = str(f, "token");
  const st = await resolveLink(db, token);
  if (!st.ok) redirect(`/s/${token}`);
  else {
    if (!sessionValid((await cookies()).get(`so_share_${st.link.id}`)?.value, st.link.id)) redirect(`/s/${token}`);
    const [review] = await db.select().from(reviews).where(eq(reviews.id, st.link.reviewId)).limit(1);
    const decision = str(f, "decision");
    if (decision !== "approved" && decision !== "disputed" && decision !== "needs_receipt") return;
    try {
      await decideFinding(db, {
        firmId: review.firmId, reviewId: review.id, findingId: str(f, "finding_id"), decision,
        reason: str(f, "reason") || undefined, comment: str(f, "comment") || undefined,
        by: st.link.approverName ?? st.link.otpEmail,
      });
    } catch (e) {
      redirect(`/s/${token}?error=${encodeURIComponent((e as Error).message)}#f-${str(f, "finding_id")}`);
    }
    revalidatePath(`/s/${token}`);
    redirect(`/s/${token}#f-${str(f, "finding_id")}`);
  }
}

export async function submitDecisionsAction(f: FormData) {
  const db = await getDb();
  const token = str(f, "token");
  const st = await resolveLink(db, token);
  if (!st.ok) redirect(`/s/${token}`);
  else {
    if (!sessionValid((await cookies()).get(`so_share_${st.link.id}`)?.value, st.link.id)) redirect(`/s/${token}`);
    const [review] = await db.select().from(reviews).where(eq(reviews.id, st.link.reviewId)).limit(1);
    await appendAudit(db, {
      firmId: review.firmId, clientId: review.clientId, actor: { type: "client", id: st.link.approverName ?? st.link.otpEmail },
      action: "share_link.submitted", entity: `share_link:${st.link.id}`,
    });
    redirect(`/s/${token}?sent=1`);
  }
}
