import Link from "next/link";
import { can, DENIED_REASON } from "@/lib/rbac";
import { monthLabel, stamp } from "@/lib/format";
import { requireSession } from "@/lib/session";
import { loadReview } from "@/lib/views";
import { AuthorBadge, Banner, ClientChip, inr, SevChip, SourceChip } from "@/components/ui";
import { DirtyBar } from "@/components/dirty-bar";
import { confirmSuppressionAction, mergeAction, removeFindingAction, saveEditsAction, saveMemoAction } from "../../../../actions";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function EditPage({ params, searchParams }: PageProps<"/reviews/[id]/edit">) {
  const { id } = await params;
  const sp = await searchParams;
  const { db, ctx } = await requireSession();
  if (!can(ctx.role, "finding.edit")) redirect(`/reviews/${id}?error=${encodeURIComponent(DENIED_REASON["finding.edit"]!)}`);
  const d = await loadReview(db, ctx, id);
  const rows = d.findings.filter((f) => f.status !== "suppressed");
  const active = rows.filter((f) => f.status !== "dropped");
  const selected = active.find((f) => f.id === sp.f) ?? active[0];
  const hist = selected ? d.versions.filter((v) => v.findingId === selected.id) : [];
  const employees = [...new Set(d.findings.flatMap((f) => f.txns.map((t) => t.employee)).filter((e): e is string => Boolean(e)))];
  const original = (fid: string) => {
    const v1 = d.versions.find((v) => v.findingId === fid && v.version === 1)?.diffJson as { severity?: string } | undefined;
    return v1?.severity;
  };
  const error = typeof sp.error === "string" ? sp.error : null;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--rule)] bg-[var(--surface)] px-8 py-3.5">
        <div className="flex flex-wrap items-center gap-4">
          <Link href={`/reviews/${id}`}>← Back to review</Link>
          <ClientChip name={d.client.name} color={d.client.color} />
          <span className="font-semibold">{monthLabel(d.review.month)}</span>
          <span className="pill tone-accent">Editing</span>
        </div>
        <div className="muted text-[13px]">Claude’s drafts stay dashed until you change or confirm them</div>
      </div>

      <div className="mx-auto flex w-full max-w-[1440px] flex-wrap items-start gap-5 px-8 py-6">
        <div className="min-w-0 flex-[999_1_640px]">
          {error && <Banner tone="high"><span>{error}</span></Banner>}
          {sp.saved && <Banner tone="ok"><span>Saved. Each change is now a version, an audit event and a past decision Claude can recall next month.</span></Banner>}
          <section className="card overflow-hidden" aria-label="Findings">
            <form id="merge-form" action={mergeAction}><input type="hidden" name="review_id" value={id} /></form>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--rule)] px-4 py-3.5">
              <h2 className="h2">Findings · {active.length} {active.some((f) => f.authorType === "claude") ? "drafted by Claude" : ""}</h2>
              <button form="merge-form" className="btn btn-sm" title="Select two or more rows first">Merge selected</button>
            </div>
            <form id="edit-form" action={saveEditsAction}>
              <input type="hidden" name="review_id" value={id} />
              <datalist id="owners">{employees.map((e) => <option key={e} value={e} />)}</datalist>
              <div className="overflow-x-auto">
                <table className="tbl min-w-[860px]">
                  <thead><tr><th className="w-10"><span className="sr-only">Select</span></th><th className="w-[110px]">Severity</th><th>Finding and suggested action</th><th>Source</th><th className="w-[170px]">Owner</th><th>Author</th></tr></thead>
                  <tbody>
                    {rows.map((f) => {
                      const removed = f.status === "dropped";
                      const was = original(f.id);
                      return (
                        <tr key={f.id} style={f.status === "ai_draft" ? { outline: "1px dashed var(--accent)", outlineOffset: -1 } : undefined}>
                          <td>{!removed && <input type="checkbox" name="select" value={f.id} form="merge-form" aria-label={`Select ${f.title}`} />}</td>
                          <td>
                            {removed ? <SevChip sev={f.severity} /> : (
                              <>
                                {was && was !== f.severity && <div className="muted text-xs line-through">{was}</div>}
                                <input type="hidden" name="id" value={f.id} />
                                <select name={`severity_${f.id}`} data-row={f.id} data-initial={f.severity} defaultValue={f.severity} className="input" aria-label="Severity">
                                  <option>low</option><option>medium</option><option>high</option>
                                </select>
                              </>
                            )}
                          </td>
                          <td>
                            {removed ? (
                              <>
                                <div className="font-semibold line-through muted">{f.title}</div>
                                <div className="muted text-[13px]">Removed{f.decisionReason ? `: ${f.decisionReason}` : ""}</div>
                              </>
                            ) : (
                              <>
                                <input name={`title_${f.id}`} data-row={f.id} defaultValue={f.title} className="input font-semibold" aria-label="Title" />
                                <input name={`action_${f.id}`} data-row={f.id} defaultValue={f.suggestedAction ?? ""} className="input mt-1.5 text-[13px]" aria-label="Suggested action" />
                              </>
                            )}
                            <div className="mt-1.5"><Link href={`?f=${f.id}`} className="text-xs">Version history</Link></div>
                          </td>
                          <td>
                            <div className="flex flex-wrap gap-1">{f.txns.map((t) => <SourceChip key={t.id} id={t.extId} />)}</div>
                            <div className="mono mt-1.5 text-[13px]">{inr(f.amount)}</div>
                          </td>
                          <td>{!removed && <input name={`owner_${f.id}`} data-row={f.id} defaultValue={f.owner ?? ""} list="owners" placeholder="Assign owner" className="input" aria-label="Owner" />}</td>
                          <td>
                            <AuthorBadge f={f} editor={ctx.name.split(" ")[0]} />
                            {removed
                              ? <button form={`undo-${f.id}`} className="btn btn-sm mt-2">Undo remove</button>
                              : <button form={`rm-${f.id}`} className="btn btn-sm btn-danger mt-2">Remove</button>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {rows.length === 0 && <p className="muted p-8 text-center">Nothing to edit yet.</p>}
              <DirtyBar formId="edit-form" nextVersion={(hist.at(-1)?.version ?? 1) + 1} />
            </form>
            {rows.map((f) => f.status === "dropped"
              ? <form key={f.id} id={`undo-${f.id}`} action={removeFindingAction}><input type="hidden" name="review_id" value={id} /><input type="hidden" name="finding_id" value={f.id} /><input type="hidden" name="undo" value="1" /></form>
              : <form key={f.id} id={`rm-${f.id}`} action={removeFindingAction}><input type="hidden" name="review_id" value={id} /><input type="hidden" name="finding_id" value={f.id} /><input type="hidden" name="reason" value="false positive" /></form>)}
          </section>

          {d.findings.some((f) => f.status === "suppressed") && (
            <section className="card mt-5 p-5" aria-label="Suppressed by past decision">
              <h2 className="h2">Suppressed, not hidden</h2>
              <p className="muted mt-1 text-[13px]">Claude did not raise these as fresh flags because a past decision or an approved rule explains them. Confirm if you agree: your confirmation is a past decision Claude can recall (and, with two that agree, propose a lasting rule from).</p>
              <ul className="mt-3 divide-y divide-[var(--rule-soft)]">
                {d.findings.filter((f) => f.status === "suppressed").map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div><div className="font-semibold">{f.title}</div><div className="mt-1 flex flex-wrap items-center gap-1">{f.txns.map((t) => <SourceChip key={t.id} id={t.extId} />)}<span className="mono ml-1 text-[13px]">{inr(f.amount)}</span></div></div>
                    <form action={confirmSuppressionAction}><input type="hidden" name="review_id" value={id} /><input type="hidden" name="finding_id" value={f.id} /><button className="btn btn-sm">Confirm suppression</button></form>
                  </li>
                ))}
              </ul>
            </section>
          )}

                <section className="card mt-5 p-5">
            <h2 className="h2">Memo</h2>
            <form action={saveMemoAction} className="mt-3 space-y-2">
              <input type="hidden" name="review_id" value={id} />
              <textarea name="markdown" rows={9} className="input mono" defaultValue={d.memo?.markdown ?? ""} aria-label="Memo markdown" />
              <button className="btn btn-sm btn-primary">Save memo version</button>
            </form>
          </section>
        </div>

        <aside className="card min-w-0 flex-[1_1_300px] max-w-[380px] p-5" aria-label="Version history">
          <h2 className="h2">Version history</h2>
          {selected ? (
            <>
              <p className="muted mt-1 text-[13px]">{selected.title}</p>
              <ol className="mt-3 space-y-3 text-[13px]">
                {hist.map((v) => (
                  <li key={v.id} className="border-l-2 pl-3" style={{ borderColor: v.authorType === "claude" ? "var(--accent)" : "var(--ink)" }}>
                    <div className="flex justify-between gap-2"><strong>v{v.version} · {v.authorType === "claude" ? "Claude" : v.authorId ?? v.authorType}</strong><span className="muted">{stamp(v.createdAt)}</span></div>
                    <Diff json={v.diffJson as Record<string, unknown>} />
                  </li>
                ))}
              </ol>
            </>
          ) : <p className="muted mt-2 text-[13px]">Select a finding to see its history.</p>}
          <div className="mt-4 rounded-md p-3 text-[13px] tone-accent">
            <strong>What this teaches Claude</strong><br />
            Saving writes a past decision for {d.client.name}: the vendor, the issue, and what you changed. Next month Claude recalls it before flagging again. It does not become a lasting rule unless you approve one.
          </div>
        </aside>
      </div>
    </>
  );
}

function Diff({ json }: { json: Record<string, unknown> }) {
  if (json.created) return <div className="muted">Drafted: severity <strong>{String(json.severity)}</strong>.</div>;
  if (json.merged) return <div>Merged {(json.merged as string[]).length} finding(s) into this one.</div>;
  if (json.dropped) return <div>Removed{json.reason ? `: “${String(json.reason)}”` : ""}</div>;
  return (
    <div className="space-y-0.5">
      {Object.entries(json).map(([k, v]) => {
        const pair = v as { from?: unknown; to?: unknown } | null;
        if (pair && typeof pair === "object" && "to" in pair) return <div key={k}>{k}: <span className="muted line-through">{String(pair.from ?? "none")}</span> → <strong>{String(pair.to)}</strong></div>;
        return <div key={k}>{k}: {JSON.stringify(v)}</div>;
      })}
    </div>
  );
}
