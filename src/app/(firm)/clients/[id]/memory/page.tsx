import Link from "next/link";
import { and, desc, eq, inArray } from "drizzle-orm";
import { episodes, followups, memoryItems, playbooks, references, reviews } from "@/db/schema";
import { ago, monthLabel, titleCase } from "@/lib/format";
import { can, DENIED_REASON } from "@/lib/rbac";
import { assertClient } from "@/lib/scope";
import { requireSession } from "@/lib/session";
import { Banner, ClientChip, SourceChip } from "@/components/ui";
import { decideProposalAction, retireMemoryAction } from "../../../../actions";

export const dynamic = "force-dynamic";

const TABS = ["semantic", "episodic", "procedural", "prospective", "external"] as const;
type Tab = (typeof TABS)[number];
const BLURB: Record<Tab, string> = {
  semantic: "Lasting facts about this client. Only a person can make one active. Claude gets the top 20 at the start of every review.",
  episodic: "Past decisions, written by Signoff only when a person acts. Claude recalls them before raising the same flag. Kept 24 months, then summarised.",
  procedural: "How a review is done. Versioned; only people edit it. Claude may suggest a change, which lands here as a proposal.",
  prospective: "What is planned for a future review. Claude sees these first. Open items escalate after 2 reviews.",
  external: "The firm’s curated references. Every claim about a rate or rule should cite one, with its source and as-of date.",
};

export default async function MemoryPage({ params, searchParams }: PageProps<"/clients/[id]/memory">) {
  const { id } = await params;
  const sp = await searchParams;
  const tab: Tab = TABS.includes(sp.tab as Tab) ? (sp.tab as Tab) : "semantic";
  const { db, ctx } = await requireSession();
  const client = await assertClient(db, ctx, id, "memory.read");
  const back = `/clients/${id}/memory${sp.tab ? `?tab=${tab}` : ""}`;

  const items = await db.select().from(memoryItems).where(eq(memoryItems.clientId, id)).orderBy(desc(memoryItems.createdAt));
  const pending = items.filter((i) => i.status === "pending");
  const eps = await db.select().from(episodes).where(eq(episodes.clientId, id)).orderBy(desc(episodes.decidedAt));
  const fus = await db.select().from(followups).where(eq(followups.clientId, id)).orderBy(desc(followups.createdAt));
  const pbs = await db.select().from(playbooks).where(eq(playbooks.firmId, ctx.firmId)).orderBy(desc(playbooks.version));
  const refs = await db.select().from(references).where(eq(references.firmId, ctx.firmId));
  const [latest] = await db.select().from(reviews).where(eq(reviews.clientId, id)).orderBy(desc(reviews.month)).limit(1);
  const epById = new Map(eps.map((e) => [e.id, e]));
  const lasting = items.filter((i) => i.type === "semantic" && i.status !== "pending");
  const counts: Record<Tab, number> = { semantic: lasting.length, episodic: eps.length, procedural: pbs.length, prospective: fus.length, external: refs.length };
  const canDecide = can(ctx.role, "memory.decide");
  const decided = typeof sp.decided === "string" ? sp.decided : null;
  const error = typeof sp.error === "string" ? sp.error : null;
  const open = await db.select({ n: followups.id }).from(followups).where(and(eq(followups.clientId, id), inArray(followups.status, ["open", "escalated"])));

  return (
    <main className="mx-auto w-full max-w-[1100px] p-8">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <ClientChip name={client.name} color={client.color} />
          <h1 className="h1 mt-3">Memory</h1>
          <p className="muted mt-1">What Signoff remembers about {client.name}, why, and who allowed it.</p>
        </div>
        {latest && <Link href={`/reviews/${latest.id}`}>Back to {monthLabel(latest.month)} review</Link>}
      </div>

      {error && <Banner tone="high"><span>{error}</span></Banner>}
      {decided === "approve" && <Banner tone="ok"><span><strong>Rule approved.</strong> Active for {client.name} from now. Claude will receive it in the next review. Logged in the audit trail.</span></Banner>}
      {decided === "reject" && <Banner tone="medium"><span><strong>Proposal rejected.</strong> Claude will still recall the past decisions, but no lasting rule exists.</span></Banner>}

      {pending.length > 0 && <p className="mb-3 font-semibold">{pending.length} proposal{pending.length === 1 ? "" : "s"} waiting for your approval</p>}
      {pending.map((p) => (
        <section key={p.id} className="card-draft mb-5 p-5" aria-label="Pending proposal">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="chip badge-ai">Proposed by Claude</span>
            <span className="muted">{p.type === "semantic" ? "Semantic rule" : "Procedural"} · {client.name} only</span>
            <span className="muted">· {ago(p.createdAt)} · not active</span>
          </div>
          <form action={decideProposalAction} className="space-y-3">
            <input type="hidden" name="item_id" value={p.id} />
            <input type="hidden" name="back" value={back} />
            <textarea name="content" rows={2} className="input text-base" defaultValue={p.content} aria-label="Rule wording" disabled={!canDecide} />
            <div className="eyebrow">Evidence · {p.evidenceIds.length} past decisions agree</div>
            <div className="space-y-1.5 text-[13px]">
              {p.evidenceIds.map((eid) => {
                const e = epById.get(eid);
                return e ? (
                  <div key={eid} className="flex flex-wrap gap-2"><span className="muted mono w-[72px]">{e.month}</span>
                    <span>{e.decidedBy} {e.clientDecision ?? e.humanChange ?? "changed"} <strong>{titleCase(e.vendor)}</strong>{e.reason ? <>: “{e.reason}”</> : null}</span></div>
                ) : null;
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button name="decision" value="approve" className="btn btn-primary" disabled={!canDecide} title={canDecide ? undefined : DENIED_REASON["memory.decide"]}>Approve rule</button>
              <button name="decision" value="reject" className="btn btn-danger" disabled={!canDecide}>Reject</button>
              <span className="muted text-xs">{canDecide ? "Approving logs an audit event. You can retire it any time. Edit the wording above first if needed." : `${DENIED_REASON["memory.decide"]}. Ask a manager.`}</span>
            </div>
          </form>
        </section>
      ))}

      <section className="card overflow-hidden">
        <div className="flex flex-wrap gap-1 border-b border-[var(--rule)] p-2" role="tablist">
          {TABS.map((t) => (
            <Link key={t} role="tab" aria-selected={t === tab} href={`/clients/${id}/memory?tab=${t}`} className="rounded-md px-3 py-2 no-underline"
              style={t === tab ? { background: "var(--accent-wash)", color: "var(--accent)", fontWeight: 600 } : { color: "var(--ink-2)" }}>
              {t[0].toUpperCase() + t.slice(1)} <span className="mono text-xs">{counts[t]}</span>
            </Link>
          ))}
        </div>
        <div className="p-5">
          <p className="muted mb-4 text-[13px]">{BLURB[tab]}</p>

          {tab === "semantic" && (lasting.length === 0 ? <Empty text="No lasting rules yet. They appear here once Claude proposes one and you approve it." /> : (
            <div className="divide-y divide-[var(--rule-soft)]">
              {lasting.map((i) => (
                <div key={i.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div>
                    <div className="font-semibold">{i.content}</div>
                    <div className="muted mt-0.5 text-[13px]">{i.approvedBy ? `Approved by ${i.approvedBy}` : `Added by ${i.author}`} · {i.evidenceIds.length} evidence decisions · used {i.hitCount}× · last used {i.lastUsedAt ? ago(i.lastUsedAt) : "never"}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`chip ${i.status === "active" ? "tone-ok" : i.status === "under_review" ? "tone-medium" : "tone-low"}`}>{i.status === "under_review" ? "Under review" : i.status[0].toUpperCase() + i.status.slice(1)}</span>
                    {(i.status === "active" || i.status === "under_review") && (
                      <form action={retireMemoryAction}><input type="hidden" name="item_id" value={i.id} /><input type="hidden" name="back" value={back} />
                        <button className="btn btn-sm" disabled={!can(ctx.role, "memory.retire")} title={can(ctx.role, "memory.retire") ? undefined : DENIED_REASON["memory.retire"]}>Retire</button></form>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}

          {tab === "episodic" && (eps.length === 0 ? <Empty text="No past decisions yet. They are written when you edit a finding or the client decides." /> : (
            <div className="overflow-x-auto"><table className="tbl min-w-[640px]">
              <thead><tr><th>Month</th><th>Vendor · issue</th><th>Claude said</th><th>Human decision</th><th>By</th></tr></thead>
              <tbody>{eps.map((e) => (
                <tr key={e.id}><td className="mono">{e.month}</td><td><strong>{titleCase(e.vendor) || "—"}</strong> · {e.issueType}</td><td>{e.aiSaid}</td>
                  <td>{e.clientDecision ?? e.humanChange}{e.reason ? <div className="muted text-[13px]">“{e.reason}”</div> : null}</td><td>{e.decidedBy}</td></tr>
              ))}</tbody></table></div>
          ))}

          {tab === "procedural" && pbs.map((p) => (
            <div key={p.id} className="mb-4">
              <div className="mb-2 flex items-center justify-between"><strong>Monthly spend review playbook · v{p.version}</strong>
                <button className="btn btn-sm" disabled title={can(ctx.role, "playbook.edit") ? "Playbook editing is not built yet" : "Only a manager can edit the playbook"}>Create version {p.version + 1}</button></div>
              <pre className="whitespace-pre-wrap rounded-md bg-[var(--head)] p-4 font-sans text-[13px] leading-relaxed">{p.body}</pre>
            </div>
          ))}

          {tab === "prospective" && (fus.length === 0 ? <Empty text="Nothing planned. Follow-ups appear when the client marks Needs receipt." /> : (
            <div className="divide-y divide-[var(--rule-soft)]">
              {fus.map((f) => (
                <div key={f.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div><div className="font-semibold">{f.text}</div><div className="mt-1 flex flex-wrap gap-1">{f.txnIds.map((t) => <SourceChip key={t} id={t} />)}</div></div>
                  <div className="flex items-center gap-2"><span className="mono muted text-xs">due {f.dueMonth} · open {f.cyclesOpen} cycle{f.cyclesOpen === 1 ? "" : "s"}</span>
                    <span className={`chip ${f.status === "escalated" ? "tone-high" : f.status === "done" ? "tone-ok" : "tone-medium"}`}>{f.status === "escalated" ? "Escalated" : f.status === "done" ? "Done" : "Open"}</span></div>
                </div>
              ))}
              <p className="muted pt-3 text-xs">{open.length} open</p>
            </div>
          ))}

          {tab === "external" && (
            <div className="space-y-4">
              {refs.map((r) => (
                <div key={r.id}><div className="flex flex-wrap items-center gap-2"><span className="chip tone-low">v{r.version}</span><strong className="mono text-[13px]">{r.topic}</strong></div>
                  <p className="mt-1">{r.body}</p><p className="mono muted text-xs">{r.sourceUrl} · as of {r.asOf}</p></div>
              ))}
            </div>
          )}
        </div>
      </section>

      <p className="muted mt-4 text-[13px]">Claude’s built-in knowledge (parametric memory) is never stored here. When it is used, the finding is marked “Unverified”.</p>
    </main>
  );
}

const Empty = ({ text }: { text: string }) => <p className="muted py-6 text-center">{text}</p>;
