import { and, desc, eq } from "drizzle-orm";
import { auditEvents, clients } from "@/db/schema";
import { verifyChain } from "@/lib/audit";
import { stamp } from "@/lib/format";
import { requireSession } from "@/lib/session";
import { visibleClientIds } from "@/lib/scope";
import { ChainStatus } from "@/components/ui";

export const dynamic = "force-dynamic";

const ACTOR_GROUP = (t: string) => (t === "claude" ? "Claude" : t === "client" ? "Clients" : t === "system" ? "System" : "Team");
const ACTION_GROUP: Record<string, (a: string) => boolean> = {
  Findings: (a) => a.startsWith("finding.") || a.startsWith("memo.") || a.startsWith("ingest.") || a.startsWith("csv.") || a.startsWith("review."),
  Memory: (a) => a.startsWith("memory.") || a.startsWith("followup."),
  Access: (a) => a.startsWith("access.") || a.startsWith("mcp_token."),
  "Share links": (a) => a.startsWith("share_link."),
};

function detail(a: string, p: Record<string, unknown>): string {
  const bits = Object.entries(p).filter(([, v]) => v != null && typeof v !== "object").map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`);
  return bits.join(" · ");
}

export default async function AuditPage({ searchParams }: PageProps<"/audit">) {
  const sp = await searchParams;
  const { db, ctx } = await requireSession();
  const actor = typeof sp.actor === "string" ? sp.actor : "";
  const client = typeof sp.client === "string" ? sp.client : "";
  const group = typeof sp.action === "string" ? sp.action : "";
  const verified = typeof sp.verify === "string";

  const chain = await verifyChain(db, ctx.firmId);
  const visible = await visibleClientIds(db, ctx);
  const cs = await db.select().from(clients).where(eq(clients.firmId, ctx.firmId));
  const mine = cs.filter((c) => visible.includes(c.id));
  const name = (id: string | null) => cs.find((c) => c.id === id)?.name ?? "—";
  const all = await db.select().from(auditEvents)
    .where(client ? and(eq(auditEvents.firmId, ctx.firmId), eq(auditEvents.clientId, client)) : eq(auditEvents.firmId, ctx.firmId))
    .orderBy(desc(auditEvents.seq)).limit(500);
  const events = all
    .filter((e) => ctx.role !== "bookkeeper" || !e.clientId || visible.includes(e.clientId))
    .filter((e) => !actor || ACTOR_GROUP(e.actorType) === actor)
    .filter((e) => !group || ACTION_GROUP[group]?.(e.action))
    .slice(0, 200);

  return (
    <main className="mx-auto w-full max-w-[1280px] p-8">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="h1">Audit trail</h1>
          <p className="muted mt-1">Every action by Claude, your team and your clients. Append-only; each event is chained to the one before it.</p>
        </div>
        <a href="/api/export?kind=audit" className="btn no-underline" style={{ color: "var(--ink)" }}>Export CSV</a>
      </div>

      <section className="card mb-5 flex flex-wrap items-center justify-between gap-3 p-4"
        style={chain.ok ? undefined : { borderColor: "var(--high)", background: "var(--high-wash)" }} role={chain.ok ? "status" : "alert"}>
        <div>
          <div className="text-base"><ChainStatus ok={chain.ok} count={chain.count} brokenAt={chain.ok ? undefined : chain.brokenAtSeq} reason={chain.ok ? undefined : chain.reason} /></div>
          <div className="muted mt-0.5 text-[13px]">
            {chain.ok ? (verified ? "Checked just now: every hash recomputed from the first event." : "Recomputed on every page load from the first event.")
              : `${chain.reason}. Every event from this point on cannot be trusted.`}
          </div>
        </div>
        <a href="/audit?verify=1" className="btn btn-sm no-underline" style={{ color: "var(--ink)" }}>Verify chain</a>
      </section>

      <form className="mb-4 flex flex-wrap items-center gap-3" aria-label="Filters">
        <label className="text-[13px]">Actor <select name="actor" defaultValue={actor} className="input ml-1 inline-block w-auto"><option value="">All actors</option>{["Claude", "Team", "Clients", "System"].map((a) => <option key={a}>{a}</option>)}</select></label>
        <label className="text-[13px]">Client <select name="client" defaultValue={client} className="input ml-1 inline-block w-auto"><option value="">All clients</option>{mine.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="text-[13px]">Action <select name="action" defaultValue={group} className="input ml-1 inline-block w-auto"><option value="">All actions</option>{Object.keys(ACTION_GROUP).map((a) => <option key={a}>{a}</option>)}</select></label>
        <button className="btn btn-sm">Apply</button>
      </form>

      <section className="card overflow-hidden">
        {events.length === 0 ? <p className="muted p-10 text-center">No events match.</p> : (
          <div className="overflow-x-auto"><table className="tbl min-w-[860px]">
            <thead><tr><th>#</th><th>Time</th><th>Actor</th><th>Action</th><th>Client</th><th>Hash</th></tr></thead>
            <tbody>
              {events.map((e) => {
                const bad = !chain.ok && e.seq === chain.brokenAtSeq;
                const after = !chain.ok && e.seq > chain.brokenAtSeq;
                const actorCls = e.actorType === "claude" ? "badge-ai" : e.actorType === "client" ? "tone-ok" : e.actorType === "system" ? "tone-low" : "badge-human";
                return (
                  <tr key={e.id} style={bad ? { background: "var(--high-wash)" } : after ? { opacity: 0.55 } : undefined}>
                    <td className="mono muted">{e.seq}</td>
                    <td className="mono whitespace-nowrap text-[13px]">{stamp(e.createdAt)}</td>
                    <td><span className={`chip ${actorCls}`}>{e.actorType === "claude" ? "Claude · MCP" : e.actorType === "client" ? `${e.actorId ?? "Client"} · client` : e.actorType === "system" ? "System" : `${e.actorId ?? "User"} · team`}</span></td>
                    <td><span className="chip tone-low mono">{e.action}</span><div className="muted mt-1 text-[13px]">{detail(e.action, e.payloadJson as Record<string, unknown>)}</div></td>
                    <td>{name(e.clientId)}</td>
                    <td className="mono muted text-xs" title={e.hash}>{e.hash.slice(0, 4)}…{e.hash.slice(-4)}{bad && <div style={{ color: "var(--high)" }}>first broken link</div>}</td>
                  </tr>
                );
              })}
            </tbody></table></div>
        )}
      </section>
      <p className="muted mt-4 text-[13px]">Each hash = sha256(previous hash + event). Changing any past event breaks every link after it.</p>
    </main>
  );
}
