import Link from "next/link";
import type { ReactNode } from "react";

/* Trust components from the design brief. Build once, reuse everywhere. */

export const inr = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);

const Icon = ({ d, size = 14 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);
export const CheckIcon = () => <Icon d="M5 12.5l4.5 4.5L19 7.5" />;
export const LockIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" role="img" aria-label="Isolated workspace"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></svg>;
export const AlertIcon = () => <Icon d="M12 8v5M12 17h.01M10.3 3.9L2.6 17.5A2 2 0 004.3 20.5h15.4a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />;

export function ClientChip({ name, color }: { name: string; color: string }) {
  return (
    <span title={`Isolated workspace: Claude and this screen only see ${name}`} className="inline-flex items-center gap-2 rounded-full border border-[var(--rule)] px-3 py-1.5 font-semibold">
      <span style={{ background: color }} className="h-2.5 w-2.5 rounded-[3px]" />
      {name}
      <span className="muted"><LockIcon /></span>
    </span>
  );
}

export function SevChip({ sev }: { sev: "low" | "medium" | "high" }) {
  return <span className={`chip sev-${sev}`}>{sev[0].toUpperCase() + sev.slice(1)}</span>;
}

type FindingLike = { status: string; authorType: string; decidedBy: string | null };
/** Who last touched a finding. Colour is never the only signal: every badge has words. */
export function AuthorBadge({ f, editor }: { f: FindingLike; editor?: string }) {
  if (f.status === "approved") return <span className="chip tone-ok"><CheckIcon />Approved by {first(f.decidedBy)}</span>;
  if (f.status === "disputed") return <span className="chip tone-high"><AlertIcon />Disputed by {first(f.decidedBy)}</span>;
  if (f.status === "needs_receipt") return <span className="chip tone-medium">Needs receipt</span>;
  if (f.status === "suppressed") return <span className="chip tone-low">Suppressed by past decision</span>;
  if (f.status === "dropped") return <span className="chip tone-low">Removed</span>;
  if (f.authorType === "user") return <span className="chip badge-human">Edited by {editor ?? "bookkeeper"}</span>;
  return <span className="chip badge-ai">AI draft</span>;
}
const first = (n: string | null) => (n ?? "client").split(/[ @]/)[0].replace(/^./, (c) => c.toUpperCase());

export function BasisChip({ basis, asOf }: { basis: string; asOf?: string }) {
  if (basis === "parametric") return <span className="chip tone-medium" title="Claude's built-in knowledge, not a firm rule or reference">Unverified (model knowledge)</span>;
  const label = basis === "rule" ? "Rule" : basis === "episode" ? "Past decision" : `Reference${asOf ? ` · as of ${asOf}` : ""}`;
  return <span className="chip tone-low">{label}</span>;
}

export function SourceChip({ id }: { id: string }) {
  return <span className="src" title="Source transaction (card number masked)">{id}</span>;
}

export function MemoryChip({ kind, label, href }: { kind: "rule" | "episode"; label: string; href?: string }) {
  const body = <span className="chip tone-accent" style={{ whiteSpace: "normal", textAlign: "left", maxWidth: "100%" }}>{kind === "rule" ? "Rule" : "Episode"}: {label}</span>;
  return href ? <Link href={href} className="no-underline">{body}</Link> : body;
}

export function ChainStatus({ ok, count, brokenAt, reason }: { ok: boolean; count: number; brokenAt?: number; reason?: string }) {
  return ok ? (
    <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: "var(--ok)" }}><CheckIcon />Chain verified · {count} events</span>
  ) : (
    <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: "var(--high)" }} title={reason}><AlertIcon />Chain broken at event {brokenAt}</span>
  );
}

export const REVIEW_STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "tone-low" },
  in_review: { label: "In review", cls: "tone-low" },
  shared: { label: "Shared with client", cls: "tone-accent" },
  closed: { label: "Signed off", cls: "tone-ok" },
};

export function StatusPill({ status, extra }: { status: string; extra?: string }) {
  const s = REVIEW_STATUS[status] ?? REVIEW_STATUS.draft;
  return <span className={`pill ${s.cls}`}>{status === "closed" && <CheckIcon />}{s.label}{extra ? ` · ${extra}` : ""}</span>;
}

export function Stat({ label, children, tone }: { label: string; children: ReactNode; tone?: string }) {
  return (
    <div className="card" style={{ padding: "16px 18px" }}>
      <div className="muted mb-1.5 text-xs">{label}</div>
      <div className="mono text-2xl font-medium" style={tone ? { color: tone } : undefined}>{children}</div>
    </div>
  );
}

export function Banner({ tone = "accent", children }: { tone?: "accent" | "high" | "ok" | "medium"; children: ReactNode }) {
  const style = tone === "accent"
    ? { border: "1px dashed var(--accent)", background: "var(--accent-wash)" }
    : { border: `1px solid var(--${tone})`, background: `var(--${tone}-wash)`, color: `var(--${tone})` };
  return <div role="status" className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg px-4 py-3" style={style}>{children}</div>;
}
