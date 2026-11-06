import Link from "next/link";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { auditEvents, clients, findings, followups, reviews } from "@/db/schema";
import { verifyChain } from "@/lib/audit";
import { ago, monthLabel, titleCase } from "@/lib/format";
import { can } from "@/lib/rbac";
import { visibleClientIds } from "@/lib/scope";
import { requireSession } from "@/lib/session";
import { Banner, ChainStatus, Stat, StatusPill } from "@/components/ui";
import { StartInClaude } from "@/components/start-in-claude";
import { uploadCsvAction } from "../../actions";

export const dynamic = "force-dynamic";

const ACTION_TEXT: Record<string, string> = {
  "finding.created": "Claude submitted findings", "finding.disputed": "disputed an item", "finding.approved": "approved an item",
  "finding.needs_receipt": "asked for a receipt", "finding.edited": "edited a finding", "finding.merged": "merged findings",
  "csv.uploaded": "uploaded a CSV", "share_link.created": "shared the review", "review.started": "Claude started the review",
  "memory.approved": "approved a rule", "memory.proposed": "Claude proposed a rule", "review.closed": "review signed off",
  "memo.written": "memo written", "ingest.completed": "imported a file", "finding.dropped": "removed a finding",
};

export default async function Clients({ searchParams }: PageProps<"/clients">) {
  const { db, ctx } = await requireSession();
  const sp = await searchParams;
  const ids = await visibleClientIds(db, ctx);
  const cs = ids.length ? await db.select().from(clients).where(inArray(clients.id, ids)).orderBy(clients.name) : [];
  const thisMonth = new Date().toISOString().slice(0, 7);

  const rows = await Promise.all(cs.map(async (c) => {
    const all = await db.select().from(reviews).where(eq(reviews.clientId, c.id)).orderBy(desc(reviews.month));
    // the month being worked on: the newest review that has started, else the newest draft
    const latest = all.find((r) => r.status !== "draft") ?? all[0];
    const fs = latest ? await db.select().from(findings).where(eq(findings.reviewId, latest.id)) : [];
    const live = fs.filter((f) => !["dropped", "suppressed"].includes(f.status));
    const decided = live.filter((f) => ["approved", "disputed", "needs_receipt"].includes(f.status)).length;
    const awaiting = live.length - decided;
    const [fu] = await db.select({ n: sql<number>`count(*)::int`, late: sql<number>`count(*) filter (where ${followups.dueMonth} <= ${latest?.month ?? thisMonth})::int` })
      .from(followups).where(and(eq(followups.clientId, c.id), inArray(followups.status, ["open", "escalated"])));
    const [last] = await db.select().from(auditEvents).where(eq(auditEvents.clientId, c.id)).orderBy(desc(auditEvents.seq)).limit(1);
    return { c, latest, live: live.length, decided, awaiting, fu, last, drafts: fs.some((f) => f.status === "ai_draft") };
  }));

  const signed = rows.filter((r) => r.latest?.status === "closed").length;
  const awaitingTotal = rows.reduce((s, r) => s + (r.latest?.status === "shared" ? r.awaiting : 0), 0);
  const overdue = rows.reduce((s, r) => s + r.fu.late, 0);
  const chain = await verifyChain(db, ctx.firmId);
  const canUpload = can(ctx.role, "csv.upload");
  const error = typeof sp.error === "string" ? sp.error : null;

  return (
    <main className="mx-auto w-full max-w-[1280px] p-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="muted mb-1 text-[13px]">Monthly close</div>
          <h1 className="h1">Clients</h1>
        </div>
      </div>

      {error && <Banner tone="high"><span><strong>Upload failed.</strong> {error}</span></Banner>}

      <section aria-label="This month at a glance" className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Signed off">{signed} <span className="muted text-sm">of {rows.length}</span></Stat>
        <Stat label="Findings awaiting a client decision">{awaitingTotal}</Stat>
        <Stat label="Follow-ups overdue" tone={overdue ? "var(--medium)" : undefined}>{overdue}</Stat>
        <div className="card" style={{ padding: "16px 18px" }}>
          <div className="muted mb-1.5 text-xs">Audit chain</div>
          <div className="mt-1 text-base">
            <ChainStatus ok={chain.ok} count={chain.count} brokenAt={chain.ok ? undefined : chain.brokenAtSeq} reason={chain.ok ? undefined : chain.reason} />
          </div>
        </div>
      </section>

      <div className="flex flex-wrap items-start gap-6">
      <section aria-label="Client list" className="card min-w-0 flex-[999_1_640px] overflow-hidden">
        {rows.length === 0 ? (
          <div className="p-10 text-center">
            <p className="font-semibold">No clients yet</p>
            <p className="muted mt-1">{ctx.role === "bookkeeper" ? "Ask a manager to assign you a client." : "Attach a myPay export in Claude to start."}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl min-w-[760px]">
              <thead><tr>
                <th>Client</th><th>Source</th><th>Review</th>
                <th className="text-right">Open findings</th><th className="text-right">Follow-ups</th><th>Last activity</th>
              </tr></thead>
              <tbody>
                {rows.map(({ c, latest, live, decided, awaiting, fu, last, drafts }) => (
                  <tr key={c.id} className="row56">
                    <td>
                      <Link href={latest ? `/reviews/${latest.id}` : `/clients/${c.id}/memory`} className="inline-flex items-center gap-2 font-semibold no-underline" style={{ color: "var(--ink)" }}>
                        <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: c.color }} />{c.name}
                      </Link>
                      <div><Link href={`/clients/${c.id}/memory`} className="text-xs">Memory</Link></div>
                    </td>
                    <td className="muted">{c.sourceTools.map(titleCase).join(", ")}</td>
                    <td>
                      {!latest ? <span className="pill tone-low">No CSV yet</span>
                        : drafts && latest.status !== "shared" ? <span className="pill badge-ai">AI draft · not reviewed</span>
                        : <StatusPill status={latest.status} extra={latest.status === "shared" ? `${decided} of ${live} decided` : undefined} />}
                      {latest && <div className="muted mt-0.5 text-xs">{monthLabel(latest.month)}</div>}
                    </td>
                    <td className="mono text-right">{awaiting}</td>
                    <td className="mono text-right" style={fu.late ? { color: "var(--medium)" } : undefined}>{fu.late ? `${fu.late} overdue` : fu.n}</td>
                    <td className="muted">{last ? `${ACTION_TEXT[last.action] ?? last.action} · ${ago(last.createdAt)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canUpload && cs.length > 0 && (
        <aside className="flex min-w-0 flex-[1_1_320px] max-w-[400px] flex-col gap-4" aria-label="Start a review">
          <section className="card p-5">
            <h2 className="h2">Start in Claude</h2>
            <p className="muted mb-4 mt-1 text-[13px] leading-relaxed">Attach the myPay export in Claude and send this prompt. Claude passes the file to Signoff untouched and shows you the row count, total and fingerprint before it reviews.</p>
            <StartInClaude clients={cs.map((c) => ({ id: c.id, name: c.name }))} defaultMonth={thisMonth} />
            <p className="muted mt-3 text-xs leading-relaxed">Up to 1,000 rows through chat. Findings arrive here as AI drafts; editing and client sign-off happen here.</p>
          </section>
          <details className="card p-5">
            <summary className="cursor-pointer font-semibold">Or upload here <span className="muted font-normal">· large files</span></summary>
            <form action={uploadCsvAction} className="mt-4 space-y-3">
              <label className="block text-[13px] font-medium">Client
                <select name="client_id" className="input mt-1" required>{cs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
              </label>
              <label className="block text-[13px] font-medium">Month
                <input name="month" className="input mono mt-1" defaultValue={thisMonth} pattern="\d{4}-\d{2}" required />
              </label>
              <label className="block text-[13px] font-medium">myPay export (.csv)
                <input type="file" name="csv" accept=".csv,text/csv" required className="mt-1 block w-full text-[13px]" />
              </label>
              <button className="btn btn-primary w-full">Upload and validate</button>
              <p className="muted text-xs">Up to 5,000 rows. Card numbers are reduced to the last 4 digits before anything is stored. Bad lines are left out and listed on the review.</p>
            </form>
          </details>
        </aside>
      )}
      </div>
    </main>
  );
}
