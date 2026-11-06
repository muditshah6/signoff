import Link from "next/link";
import { can, DENIED_REASON } from "@/lib/rbac";
import { monthLabel, stamp, titleCase } from "@/lib/format";
import { appOrigin, requireSession } from "@/lib/session";
import { loadReview } from "@/lib/views";
import { AuthorBadge, Banner, BasisChip, ClientChip, inr, MemoryChip, SevChip, SourceChip, StatusPill } from "@/components/ui";
import { Md } from "@/components/md";
import { createShareAction, revokeShareAction } from "../../../actions";

export const dynamic = "force-dynamic";

export default async function ReviewPage({ params, searchParams }: PageProps<"/reviews/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const { db, ctx } = await requireSession();
  const d = await loadReview(db, ctx, id);
  const live = d.findings.filter((f) => f.status !== "dropped");
  const drafts = live.filter((f) => f.status === "ai_draft").length;
  const decided = live.filter((f) => ["approved", "disputed", "needs_receipt"].includes(f.status)).length;
  const countable = live.filter((f) => f.status !== "suppressed").length;
  const origin = await appOrigin();
  const shareToken = typeof sp.share === "string" ? sp.share : null;
  const error = typeof sp.error === "string" ? sp.error : null;
  const rejectedLines = (d.source?.rejected ?? []) as { line: number; error: string }[];
  const canEdit = can(ctx.role, "finding.edit");
  const canShare = can(ctx.role, "review.share");
  const sevCount = (s: string) => live.filter((f) => f.severity === s && f.status !== "suppressed").length;
  const total = d.findings.length ? new Set(live.flatMap((f) => f.txns.map((t) => t.id))).size : 0;
  const claudeFirst = d.findings.find((f) => f.authorType === "claude")?.createdAt;
  const epLabel = (e: (typeof d.eps)[number]) => `${e.month} ${titleCase(e.vendor)}${e.reason ? ` — “${e.reason}”` : ""}`;
  const epById = new Map(d.eps.map((e) => [e.id, e]));
  const nav = (r: { id: string; month: string } | null, dir: string) =>
    r ? <Link href={`/reviews/${r.id}`} aria-label={`${dir} month`} className="btn btn-sm no-underline" style={{ width: 32, padding: 0 }}>{dir === "Previous" ? "‹" : "›"}</Link>
        : <span className="btn btn-sm" aria-disabled="true" style={{ width: 32, padding: 0 }}>{dir === "Previous" ? "‹" : "›"}</span>;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--rule)] bg-[var(--surface)] px-8 py-4">
        <div className="flex flex-wrap items-center gap-4">
          <ClientChip name={d.client.name} color={d.client.color} />
          <div className="flex items-center gap-1">{nav(d.prev, "Previous")}<span className="px-2 font-semibold">{monthLabel(d.review.month)}</span>{nav(d.next, "Next")}</div>
          <StatusPill status={d.review.status} extra={d.review.status === "shared" ? `${decided} of ${countable} decided` : undefined} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/clients/${d.client.id}/memory`} className="btn no-underline" style={{ color: "var(--ink)" }}>Memory</Link>
          {canEdit
            ? <Link href={`/reviews/${id}/edit`} className="btn no-underline" style={{ color: "var(--ink)" }}>Edit findings</Link>
            : <span className="btn" aria-disabled="true" title={DENIED_REASON["finding.edit"]}>Edit findings</span>}
          <a href="#share" className="btn btn-primary no-underline" aria-disabled={!canShare}>Share with client</a>
        </div>
      </div>

      {d.source && (
        <div className="flex flex-wrap items-center gap-3 border-b border-[var(--rule)] bg-[var(--head)] px-8 py-2.5 text-[13px]">
          <span className="chip tone-low" title={`SHA-256 of the exact text received: ${d.source.sha256}`}>
            {d.source.source === "chat" ? "Attached in Claude" : "Uploaded in the app"} · {d.source.rowCount} rows · <span className="mono">{inr(d.source.total)}</span> · fingerprint <span className="mono">{d.source.sha256.slice(0, 4)}…</span>
          </span>
          <span className="muted">{stamp(d.source.createdAt)}{d.source.createdBy ? ` · ${d.source.createdBy}` : ""} · card numbers masked to the last 4 digits</span>
        </div>
      )}

      <main className="mx-auto w-full max-w-[1440px] px-8 py-6">
        {rejectedLines.length > 0 && (
          <Banner tone="medium">
            <span><strong>{rejectedLines.length} line{rejectedLines.length === 1 ? "" : "s"} of the file {rejectedLines.length === 1 ? "was" : "were"} left out.</strong> {rejectedLines.slice(0, 4).map((r) => `Line ${r.line}: ${r.error}`).join(" · ")}{rejectedLines.length > 4 ? ` · and ${rejectedLines.length - 4} more` : ""}</span>
          </Banner>
        )}
        {error && <Banner tone="high"><span>{error}</span></Banner>}
        {shareToken && (
          <Banner tone="ok">
            <span><strong>Share link created. Copy it now; it is shown only once.</strong><br /><span className="mono break-all">{origin}/s/{shareToken}</span></span>
            <span className="text-xs">Expires in 14 days. The client passes an email code first (printed in the server log in dev).</span>
          </Banner>
        )}
        {drafts > 0 && (
          <Banner>
            <div className="flex items-center gap-2.5">
              <span className="chip badge-ai">AI draft</span>
              <span>Claude drafted {drafts} finding{drafts === 1 ? "" : "s"}{d.memo?.authorType === "claude" ? " and a memo" : ""} through the MCP connector{claudeFirst ? ` at ${stamp(claudeFirst)}` : ""}. None reviewed by you yet.</span>
            </div>
            {d.pendingProposals > 0 && <Link href={`/clients/${d.client.id}/memory`} className="font-semibold">{d.pendingProposals} memory proposal{d.pendingProposals === 1 ? "" : "s"} waiting for approval →</Link>}
          </Banner>
        )}
        {drafts === 0 && d.pendingProposals > 0 && (
          <Banner><span>Claude proposed a lasting rule for {d.client.name}.</span><Link href={`/clients/${d.client.id}/memory`} className="font-semibold">{d.pendingProposals} waiting for approval →</Link></Banner>
        )}

        <div className="flex flex-wrap items-start gap-5">
          <div className="flex min-w-0 max-w-[420px] flex-[1_1_340px] flex-col gap-5">
            <section aria-label="Memo" className={d.memo?.authorType === "claude" ? "card-draft p-5" : "card p-5"}>
              <div className="mb-3.5 flex items-center justify-between gap-2">
                <h2 className="h2">Memo</h2>
                {d.memo && <span className="muted text-xs">v{d.memo.version} · {d.memo.authorType === "claude" ? "Claude" : "edited"} · {stamp(d.memo.createdAt)}</span>}
              </div>
              {d.memo ? <Md text={d.memo.markdown} /> : (
                <p className="muted">No memo yet. In Claude, say: “Use the monthly_review prompt for {d.client.name}, {d.review.month}”.</p>
              )}
            </section>

            <details open className="card p-5">
              <summary className="h2 cursor-pointer">Memory used</summary>
              <div className="mt-3 flex flex-col gap-3 text-[13px]">
                {d.rules.length + d.eps.length + d.followups.length === 0 && <p className="muted">No memory relied on yet.</p>}
                {d.rules.map((r) => <div key={r.id}><MemoryChip kind="rule" label={r.content.slice(0, 70)} href={`/clients/${d.client.id}/memory`} /> <span className="muted">{r.status}, used {r.hitCount}×</span></div>)}
                {d.eps.map((e) => <div key={e.id}><MemoryChip kind="episode" label={epLabel(e)} /></div>)}
                {d.followups.map((f) => <div key={f.id}><span className="chip tone-medium">Follow-up</span> {f.text} <span className="muted">· open {f.cyclesOpen} cycle{f.cyclesOpen === 1 ? "" : "s"}</span></div>)}
                <p className="muted text-xs">Claude’s built-in knowledge is never stored here. When it is used, the finding shows “Unverified”.</p>
              </div>
            </details>
          </div>

          <section aria-label="Findings" className="card min-w-0 flex-[999_1_560px] overflow-hidden">
            <div className="flex items-center justify-between border-b border-[var(--rule)] px-4 py-3.5">
              <h2 className="h2">Findings <span className="muted text-[13px] font-normal">· {countable} ({sevCount("high")} high, {sevCount("medium")} medium, {sevCount("low")} low) across {total} transactions</span></h2>
              <a href={`/api/export?kind=resolved&review=${id}`} className="btn btn-sm no-underline" style={{ color: "var(--ink)" }}>Export resolved CSV</a>
            </div>
            {live.length === 0 ? (
              <div className="p-10 text-center"><p className="font-semibold">No findings yet</p><p className="muted mt-1">Claude submits them through the MCP connection as AI drafts.</p></div>
            ) : (
              <div className="overflow-x-auto">
                <table className="tbl min-w-[760px]">
                  <thead><tr><th className="w-[84px]">Severity</th><th>Finding</th><th>Source</th><th className="text-right">Amount</th><th>Basis</th><th>Status</th></tr></thead>
                  <tbody>
                    {live.map((f) => {
                      const sup = f.status === "suppressed";
                      const ep = f.suppressedBy ? epById.get(f.suppressedBy) : undefined;
                      const rule = !ep && f.suppressedBy ? d.rules.find((r) => r.id === f.suppressedBy) : undefined;
                      return (
                        <tr key={f.id} className={sup ? "suppressed" : f.status === "ai_draft" ? "" : ""} style={f.status === "ai_draft" ? { background: "color-mix(in srgb, var(--accent-wash) 40%, transparent)" } : undefined}>
                          <td><SevChip sev={f.severity} /></td>
                          <td>
                            <div className="mb-0.5 font-semibold">{f.title}</div>
                            <div className="muted text-[13px] leading-snug">{f.detail ?? f.suggestedAction}</div>
                            {f.detail && f.suggestedAction && <div className="mt-1 text-[13px]">Suggested: {f.suggestedAction}</div>}
                            {sup && (ep || rule) && (
                              <div className="mt-2 rounded-md px-2.5 py-2 text-[12.5px] tone-low">
                                Suppressed by: {ep ? <>Episode {epLabel(ep)}</> : <>Rule “{rule!.content}”</>}
                              </div>
                            )}
                            {f.decisionReason && f.status !== "dropped" && <div className="mt-1 text-[13px]">“{f.decisionReason}”</div>}
                            {f.owner && <div className="muted mt-1 text-xs">Owner: {f.owner}</div>}
                          </td>
                          <td><div className="flex flex-wrap gap-1">{f.txns.map((t) => <SourceChip key={t.id} id={t.extId} />)}</div></td>
                          <td className="mono text-right">{inr(f.amount)}</td>
                          <td><BasisChip basis={f.basis} /></td>
                          <td><AuthorBadge f={f} editor={ctx.name.split(" ")[0]} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <section id="share" className="card mt-5 p-5">
          <h2 className="h2">Share with client</h2>
          <p className="muted mt-1 text-[13px]">A signed link, valid 14 days, scoped to this review. The approver sees findings only, never the ledger, and passes an email code first.</p>
          {canShare ? (
            <form action={createShareAction} className="mt-3 flex flex-wrap items-end gap-2">
              <input type="hidden" name="review_id" value={id} />
              <label className="min-w-[200px] flex-1 text-[13px] font-medium">Approver name<input className="input mt-1" name="approver" defaultValue={d.client.cfoEmail ? "" : ""} placeholder="Arjun Nair" /></label>
              <label className="min-w-[240px] flex-1 text-[13px] font-medium">Approver email<input className="input mt-1" type="email" name="email" defaultValue={d.client.cfoEmail ?? ""} required /></label>
              <button className="btn btn-primary" disabled={countable === 0}>Create link</button>
            </form>
          ) : <p className="mt-3 text-[13px]" style={{ color: "var(--medium)" }}>{DENIED_REASON["review.share"]}</p>}
          <ul className="mt-4 space-y-2 text-[13px]">
            {d.links.map((l) => {
              const state = l.revokedAt ? "revoked" : l.expiresAt < new Date() ? "expired" : "active";
              return (
                <li key={l.id} className="flex flex-wrap items-center gap-3">
                  <span className={`chip ${state === "active" ? "tone-ok" : "tone-high"}`}>{state}</span>
                  <span>{l.approverName ? `${l.approverName} · ` : ""}{l.otpEmail}</span>
                  <span className="mono muted">expires {l.expiresAt.toISOString().slice(0, 10)}</span>
                  {state === "active" && canShare && <form action={revokeShareAction} className="ml-auto"><input type="hidden" name="link_id" value={l.id} /><button className="btn btn-sm btn-danger">Revoke</button></form>}
                </li>
              );
            })}
          </ul>
        </section>
      </main>
    </>
  );
}
