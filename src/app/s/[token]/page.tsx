import { cookies } from "next/headers";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { clients, comments, findings, firms, reviews, transactions } from "@/db/schema";
import { monthLabel } from "@/lib/format";
import { isDemo } from "@/lib/env";
import { resolveLink, sessionValid } from "@/lib/share";
import { SevChip, inr } from "@/components/ui";
import { decideAction, sendOtpAction, submitDecisionsAction, verifyOtpAction } from "../../actions";

export const dynamic = "force-dynamic";

const WHY = {
  invalid: "This link is not valid. Ask your accountant to send it again.",
  expired: "This link has expired. Ask your accountant for a new one.",
  revoked: "This link was revoked by your accountant.",
} as const;

const BTN = "inline-flex h-11 items-center gap-1.5 rounded-lg px-4 text-sm font-semibold cursor-pointer border";
const TONE = {
  approved: { border: "var(--ok)", background: "var(--ok-wash)", color: "var(--ok)" },
  disputed: { border: "var(--high)", background: "var(--high-wash)", color: "var(--high)" },
  needs_receipt: { border: "var(--medium)", background: "var(--medium-wash)", color: "var(--medium)" },
} as const;
const IDLE = { border: "var(--rule)", background: "var(--surface)", color: "var(--ink)" };

export default async function SharePage({ params, searchParams }: PageProps<"/s/[token]">) {
  const { token } = await params;
  const sp = await searchParams;
  const db = await getDb();
  const st = await resolveLink(db, token);

  if (!st.ok) {
    return (
      <Shell>
        <div className="card mx-auto mt-16 max-w-md p-8 text-center" role="alert">
          <h1 className="h2">Link unavailable</h1>
          <p className="muted mt-2">{WHY[st.reason]}</p>
        </div>
      </Shell>
    );
  }
  const link = st.link;
  const [review] = await db.select().from(reviews).where(eq(reviews.id, link.reviewId));
  const [client] = await db.select().from(clients).where(eq(clients.id, review.clientId));
  const [firm] = await db.select().from(firms).where(eq(firms.id, review.firmId));
  const authed = sessionValid((await cookies()).get(`so_share_${link.id}`)?.value, link.id);
  const demoCookie = (await cookies()).get("so_demo_otp")?.value;
  const demoCode = isDemo() && sp.demo && demoCookie?.startsWith(`${link.id}:`) ? demoCookie.split(":")[1] : null;
  const masked = link.otpEmail.replace(/^(.).*(@.*)$/, "$1***$2");

  if (!authed) {
    return (
      <Shell firm={firm.name}>
        <div className="card mx-auto mt-14 w-full max-w-sm p-6">
          <h1 className="h2">Verify it is you</h1>
          <p className="muted mt-1 text-[13px]">{client.name} · {monthLabel(review.month)} review. We email a 6-digit code to <span className="mono">{masked}</span>.</p>
          {sp.otp === "unavailable" && (
            <p className="mt-3 rounded-md p-2.5 text-[13px] tone-high" role="alert">We could not send the code because email delivery is not configured. Ask your accountant to fix this, then try again.</p>
          )}
          {demoCode && (
            <p className="mt-3 rounded-md p-2.5 text-[13px] tone-accent" role="status">Demo mode: no email is sent. Your code is <strong className="mono">{demoCode}</strong>.</p>
          )}
          {sp.otp === "sent" ? (
            <form action={verifyOtpAction} className="mt-4 space-y-2">
              <input type="hidden" name="token" value={token} />
              <input className="input mono" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" required aria-label="6-digit code" />
              {sp.bad && <p className="text-[13px]" style={{ color: "var(--high)" }} role="alert">That code is wrong or expired.</p>}
              <button className="btn btn-primary w-full">Open review</button>
            </form>
          ) : (
            <form action={sendOtpAction} className="mt-4"><input type="hidden" name="token" value={token} /><button className="btn btn-primary w-full">Send code</button></form>
          )}
        </div>
      </Shell>
    );
  }

  const all = await db.select().from(findings).where(eq(findings.reviewId, review.id)).orderBy(findings.createdAt);
  const items = all.filter((f) => !["dropped", "suppressed"].includes(f.status));
  const txIds = items.flatMap((f) => f.txnIds);
  const txns = txIds.length ? await db.select().from(transactions).where(inArray(transactions.id, txIds)) : [];
  const cs = items.length ? await db.select().from(comments).where(inArray(comments.findingId, items.map((f) => f.id))) : [];
  const done = (s: string) => ["approved", "disputed", "needs_receipt"].includes(s);
  const decided = items.filter((f) => done(f.status)).length;
  const sum = (f: (typeof items)[number]) => txns.filter((t) => f.txnIds.includes(t.id)).reduce((a, t) => a + t.amount, 0);
  const total = items.reduce((a, f) => a + sum(f), 0);
  const preparer = link.createdBy ? link.createdBy.split("@")[0] : "your accountant";
  const dateLong = link.expiresAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  return (
    <Shell firm={firm.name} verified={`Verified as ${link.otpEmail} · link expires ${dateLong}`}>
      <div className="mx-auto w-full max-w-[760px] px-4 pb-16 pt-8">
        <div className="eyebrow">Monthly spend review</div>
        <h1 className="h1 mt-1">{client.name} · {monthLabel(review.month)}</h1>
        <p className="muted mt-2 leading-relaxed">Prepared by {firm.name} ({preparer}). Analysed with Claude, then checked and edited by your accountant. Each item needs one decision from you.</p>

        {sp.error && <p className="card mt-4 p-3 text-[13px]" style={{ borderColor: "var(--high)", color: "var(--high)" }} role="alert">{sp.error}</p>}
        {sp.sent && <p className="card mt-4 p-3 text-[13px]" style={{ borderColor: "var(--ok)", color: "var(--ok)" }} role="status">Sent. Your accountant has been notified of your decisions.</p>}

        <section className="card mt-6 p-4">
          <div className="flex items-baseline justify-between gap-3"><strong className="mono">{decided} of {items.length} decided</strong><span className="muted text-[13px]">Total under review <span className="mono" style={{ color: "var(--ink)" }}>{inr(total)}</span></span></div>
          <progress className="mt-3 h-2 w-full" value={decided} max={Math.max(items.length, 1)} aria-label={`${decided} of ${items.length} decided`} />
        </section>

        <div className="mt-5 space-y-4">
          {items.length === 0 && <p className="card p-8 text-center muted">Nothing needs your decision.</p>}
          {items.map((f) => {
            const rows = txns.filter((t) => f.txnIds.includes(t.id));
            const mine = cs.filter((c) => c.findingId === f.id);
            return (
              <article key={f.id} id={`f-${f.id}`} className="card p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2"><SevChip sev={f.severity} /><h2 className="h2">{f.title}</h2></div>
                  <div className="mono text-lg font-medium">{inr(sum(f))}</div>
                </div>
                <p className="mt-2 leading-relaxed" style={{ color: "var(--ink-2)" }}>{f.detail ?? f.suggestedAction}</p>
                {f.detail && f.suggestedAction && <p className="mt-1 text-[13px]">We suggest: {f.suggestedAction}</p>}
                <div className="muted mt-2 text-[13px]">{rows.map((t) => <div key={t.id}>{new Date(t.txnDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} · {t.merchant} · {t.employee} · card ••{t.cardLast4}</div>)}</div>
                {f.decisionReason && <p className="mt-2 rounded-md p-2.5 text-[13px] tone-low">You wrote: “{f.decisionReason}”</p>}
                {mine.map((c) => <p key={c.id} className="muted mt-1 text-[13px]">{c.body}</p>)}
                <form action={decideAction} className="mt-4 space-y-3">
                  <input type="hidden" name="token" value={token} /><input type="hidden" name="finding_id" value={f.id} />
                  <label className="block text-[13px] font-medium">Why are you disputing this? <span className="muted font-normal">(required to dispute)</span>
                    <textarea name="reason" rows={2} className="input mt-1" placeholder="e.g. This was pre-approved by the board" defaultValue={f.status === "disputed" ? f.decisionReason ?? "" : ""} /></label>
                  <div className="flex flex-wrap gap-2">
                    <button name="decision" value="approved" className={BTN} aria-pressed={f.status === "approved"} style={f.status === "approved" ? TONE.approved : IDLE}>{f.status === "approved" ? "✓ " : ""}Approve</button>
                    <button name="decision" value="disputed" className={BTN} aria-pressed={f.status === "disputed"} style={f.status === "disputed" ? TONE.disputed : IDLE}>{f.status === "disputed" ? "✓ " : ""}Dispute</button>
                    <button name="decision" value="needs_receipt" className={BTN} aria-pressed={f.status === "needs_receipt"} style={f.status === "needs_receipt" ? TONE.needs_receipt : IDLE}>{f.status === "needs_receipt" ? "✓ " : ""}Needs receipt</button>
                  </div>
                  {f.status === "needs_receipt" && <p className="muted text-[13px]">Your accountant will follow up on this receipt at next month’s review.</p>}
                </form>
              </article>
            );
          })}
        </div>

        <form action={submitDecisionsAction} className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <input type="hidden" name="token" value={token} />
          <span className="muted text-[13px]">Decisions are saved as you go. Sending notifies your accountant.</span>
          <button className="btn btn-primary" disabled={decided === 0}>{decided === items.length && items.length ? "Send decisions" : `Send ${decided} decision${decided === 1 ? "" : "s"}`}</button>
        </form>

        <p className="muted mt-8 text-xs leading-relaxed">You are seeing the findings only, not your full ledger. Card numbers show the last 4 digits. Every decision is recorded with your name and time in a tamper-evident audit log your accountant can export.</p>
      </div>
    </Shell>
  );
}

function Shell({ children, firm, verified }: { children: React.ReactNode; firm?: string; verified?: string }) {
  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--rule)] bg-[var(--surface)] px-8 py-3.5">
        <div className="flex items-center gap-2 font-bold">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" /><path d="M8 12.5l2.6 2.6L16 9.5" /></svg>
          Signoff{firm && <span className="muted font-normal">· shared by {firm}</span>}
        </div>
        {verified && <div className="muted text-[13px]">{verified}</div>}
      </header>
      {children}
    </>
  );
}
