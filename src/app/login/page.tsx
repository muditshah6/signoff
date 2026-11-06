import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { firms, users } from "@/db/schema";
import { ROLE_LABEL } from "@/lib/rbac";
import { demoLoginEnabled, isDemo } from "@/lib/env";
import { loginAs } from "../actions";

export const dynamic = "force-dynamic";

export default async function Login() {
  if (!demoLoginEnabled()) {
    return (
      <main className="mx-auto mt-20 w-full max-w-md px-4">
        <h1 className="h2">Signoff</h1>
        <div className="card mt-6 p-5" role="note">
          <p className="font-semibold">Sign-in is not available</p>
          <p className="muted mt-1 text-[13px]">This deployment has no email sign-in configured. Set DEMO_MODE=1 for a demo with synthetic data.</p>
        </div>
      </main>
    );
  }
  const db = await getDb();
  const rows = await db.select({ u: users, f: firms.name }).from(users).innerJoin(firms, eq(firms.id, users.firmId)).orderBy(asc(firms.name), asc(users.name));
  return (
    <main className="mx-auto mt-20 w-full max-w-md px-4">
      <div className="flex items-center gap-2 text-xl font-bold">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" /><path d="M8 12.5l2.6 2.6L16 9.5" /></svg>
        Signoff
      </div>
      <p className="muted mt-1">Claude does the analysis; Signoff turns it into a signed, auditable work product.</p>
      <div className="card mt-6 p-5">
        {rows.length === 0 ? (
          <p className="muted">No users yet. Run <span className="mono">npm run seed</span>.</p>
        ) : (
          <form action={loginAs} className="space-y-3">
            <label className="block text-[13px] font-medium" htmlFor="user_id">Demo sign-in: choose who you are
              <select id="user_id" name="user_id" className="input mt-1">
                {rows.map(({ u, f }) => <option key={u.id} value={u.id}>{u.name} · {ROLE_LABEL[u.role]} · {f}</option>)}
              </select>
            </label>
            <button className="btn btn-primary w-full">Continue</button>
            <p className="muted text-xs">{isDemo() ? "Demo workspace with synthetic data: anyone with this link can sign in as any person." : "Development stub for the email magic link."} Switching person is how you see each role: an auditor cannot edit, a bookkeeper only sees assigned clients, only a manager approves rules.</p>
          </form>
        )}
      </div>
    </main>
  );
}
