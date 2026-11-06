import Link from "next/link";
import { initials } from "@/lib/format";
import { ROLE_LABEL } from "@/lib/rbac";
import { requireSession } from "@/lib/session";
import { isDemo } from "@/lib/env";
import { logout } from "../actions";
import { NavLink } from "@/components/nav-link";

export default async function FirmLayout({ children }: { children: React.ReactNode }) {
  const { user, firm, ctx } = await requireSession();
  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--rule)] bg-[var(--surface)] px-8 py-3.5">
        <div className="flex flex-wrap items-center gap-7">
          <Link href="/clients" className="flex items-center gap-2 text-[17px] font-bold tracking-tight no-underline" style={{ color: "var(--ink)" }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" /><path d="M8 12.5l2.6 2.6L16 9.5" /></svg>
            Signoff
          </Link>
          <nav aria-label="Main" className="flex flex-wrap gap-1">
            <NavLink href="/clients" match="/clients,/reviews">Clients</NavLink>
            <NavLink href="/audit">Audit trail</NavLink>
            <NavLink href="/connect">Connect Claude</NavLink>
          </nav>
        </div>
        <div className="flex items-center gap-3 muted">
          <span>{firm.name}</span>
          <span className="chip tone-low">{ROLE_LABEL[ctx.role]}</span>
          <form action={logout}>
            <button className="flex items-center gap-2 border-0 bg-transparent p-0" title={`${user.name} · sign out`}>
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--ink)] text-xs font-semibold text-[var(--paper)]">{initials(user.name)}</span>
            </button>
          </form>
        </div>
      </header>
      {isDemo() && (
        <div className="px-8 py-2 text-center text-xs font-semibold tone-medium" role="note">Demo workspace · synthetic data · shared by everyone with this link. Switch person by signing out.</div>
      )}
      {ctx.role === "auditor" && (
        <div className="px-8 py-2 text-center text-xs font-semibold tone-low" role="note">Read-only access: you can review everything and export, but not change anything.</div>
      )}
      {children}
    </>
  );
}
