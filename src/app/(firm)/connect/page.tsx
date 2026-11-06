import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { auditEvents, mcpTokens } from "@/db/schema";
import { ago, daysAgo } from "@/lib/format";
import { can, ROLE_LABEL } from "@/lib/rbac";
import { appOrigin, requireSession } from "@/lib/session";
import { Banner } from "@/components/ui";
import { rotateTokenAction } from "../../actions";
import { CopyButton } from "@/components/copy-button";

export const dynamic = "force-dynamic";

const SEE: [string, string][] = [
  ["Date, amount, currency, category", "Yes"], ["Card number", "Last 4 only"], ["Merchant name, notes", "As untrusted text"],
  ["Employee, department", "Yes"], ["Other clients’ data", "Never"], ["Client comments", "Only when asked"],
];
const CANNOT = ["Approve or dispute a finding", "Delete a finding or undo your edit", "Make its own memory active", "Export the full ledger"];

export default async function ConnectPage({ searchParams }: PageProps<"/connect">) {
  const sp = await searchParams;
  const { db, ctx, user } = await requireSession();
  const fresh = typeof sp.token === "string" ? sp.token : null;
  const origin = await appOrigin();
  const [tok] = await db.select().from(mcpTokens).where(and(eq(mcpTokens.userId, ctx.userId), isNull(mcpTokens.revokedAt))).orderBy(desc(mcpTokens.createdAt)).limit(1);
  const week = daysAgo(7);
  const denied = await db.select({ id: auditEvents.id }).from(auditEvents)
    .where(and(eq(auditEvents.firmId, ctx.firmId), eq(auditEvents.action, "access.denied"), gte(auditEvents.createdAt, week)));
  const canManage = can(ctx.role, "token.manage") && ctx.role !== "auditor";

  return (
    <main className="mx-auto w-full max-w-[1100px] p-8">
      <h1 className="h1">Connect Claude</h1>
      <p className="muted mt-1 mb-6">Claude does the analysis through this connector. Signoff stores the record; it runs no AI of its own.</p>

      {ctx.role === "auditor" ? (
        <Banner tone="medium"><span>Auditors read the record but do not get a Claude token.</span></Banner>
      ) : (
        <div className="flex flex-wrap items-start gap-6">
          <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-5">
            <section className="card p-5">
              <h2 className="h2 mb-4">Connector details</h2>
              <label htmlFor="mcp-url" className="text-[13px] font-medium">MCP server URL</label>
              <div className="mt-1 mb-4 flex gap-2"><input id="mcp-url" readOnly className="input mono" value={`${origin}/api/mcp`} /><CopyButton text={`${origin}/api/mcp`} /></div>
              <label htmlFor="mcp-token" className="text-[13px] font-medium">Your personal token, {user.name.split(" ")[0]} · {ROLE_LABEL[ctx.role]} <span className="muted font-normal">(send as header Authorization: Bearer …)</span></label>
              <div className="mt-1 flex gap-2">
                <input id="mcp-token" readOnly className="input mono" value={fresh ?? "sgn_••••••••••••••••••••••••"} />
                {fresh ? <CopyButton text={fresh} /> : null}
                {canManage && <form action={rotateTokenAction}><button className="btn">Rotate token</button></form>}
              </div>
              <p className="mt-2 text-[13px]" style={{ color: fresh ? "var(--medium)" : "var(--muted)" }}>
                {fresh ? "New token shown once. Copy it now; the old token stopped working." : "Stored as a hash. Signoff cannot show it again; rotate to get a new one."}
              </p>
              <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-[var(--rule-soft)] pt-4 text-[13px]">
                <div><dt className="muted">Last used</dt><dd className="font-medium">{tok?.lastUsedAt ? `${ago(tok.lastUsedAt)} · Claude on your behalf` : "never"}</dd></div>
                <div><dt className="muted">Rate limit</dt><dd className="font-medium">60 calls per minute</dd></div>
                <div><dt className="muted">Claude acts as</dt><dd className="font-medium">{ROLE_LABEL[ctx.role]}{ctx.role === "bookkeeper" ? ", assigned clients only" : ""}</dd></div>
                <div><dt className="muted">Denied requests (7 days)</dt><dd className="font-medium">{denied.length} · <a href="/audit?action=Access">see audit</a></dd></div>
              </dl>
            </section>

            <section className="card p-5">
              <h2 className="h2 mb-4">Add it in Claude</h2>
              <ol className="space-y-4">
                {[
                  ["Open Customize › Connectors › Add › Custom › Web", "On Team or Enterprise, an admin adds it under Organization settings › Connectors."],
                  ["Paste the URL. Authentication: No sign in. Request header: Authorization = Bearer + your token", "Claude gets exactly your role and clients. Each teammate creates their own token; never share yours."],
                  [`Ask: “Use the monthly_review prompt for Acme Robotics, 2026-10”`, "Findings arrive here as AI drafts for you to edit."],
                ].map(([a, b], i) => (
                  <li key={i} className="flex gap-3"><span className="mono flex h-6 w-6 flex-none items-center justify-center rounded-full tone-accent text-xs font-semibold">{i + 1}</span>
                    <div><div className="font-medium">{a}</div><div className="muted text-[13px]">{b}</div></div></li>
                ))}
              </ol>
            </section>
          </div>

          <aside className="flex min-w-0 flex-[1_1_300px] flex-col gap-5">
            <section className="card p-5">
              <h2 className="h2">What Claude can see</h2>
              <p className="muted mb-3 text-[13px]">Per call, for one client at a time</p>
              <ul className="space-y-2 text-[13px]">{SEE.map(([k, v]) => <li key={k} className="flex justify-between gap-3"><span>{k}</span><strong>{v}</strong></li>)}</ul>
            </section>
            <section className="card p-5">
              <h2 className="h2 mb-3">What Claude cannot do</h2>
              <ul className="list-disc space-y-1.5 pl-5 text-[13px]">{CANNOT.map((c) => <li key={c}>{c}</li>)}</ul>
            </section>
          </aside>
        </div>
      )}
    </main>
  );
}
