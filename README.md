# Signoff

Claude does the analysis; Signoff turns it into a signed, auditable work product. There is no AI inside the app: every model call happens in Claude, and the app stores, serves and records.

Built from `../signoff-kit` and updated to `../signoff-kit 2` (chat-first ingest). Contracts and design brief are copied to `docs/`.

## Run it

```bash
npm install
npm run seed     # wipes .data, loads the kit's seed (2 firms, 4 roles, 3 CSVs), prints the personal MCP tokens
npm run dev      # http://localhost:3000 → /login → pick a person
```

Local data is an embedded Postgres (PGlite) in `.data/`. One process at a time can open it, so stop the server before re-seeding. Set `DATABASE_URL` to use a real Postgres.

## Use it: one month, end to end

**Sign in as Priya Raman (Owner).** `/login` is a demo stub for the email magic link; switching person is how you see each role.

1. **Connect Claude** (`/connect`): copy the MCP URL and your personal token. In Claude: Customize › Connectors › Add › Custom › Web, paste the URL, Authentication "No sign in", request header `Authorization: Bearer <token>`. Seeded dev tokens: `dev-priya-7c1f0e2a` (owner), `dev-meera-3b9d41c7` (manager), `dev-ravi-5e02aa19` (bookkeeper).
2. **Start in Claude** (main path). On `/clients`, **Start in Claude** gives a copyable prompt. Attach the myPay CSV in Claude and send: *Use the monthly_review prompt for Acme Robotics, 2026-10.* Claude calls `ingest_csv` with the file text exactly as attached (up to 1,000 rows / 300 KB) and shows you the row count, total and SHA-256 fingerprint. Bad lines are left out and listed; Claude stops and asks unless you say to continue. Larger files: **Or upload here** (up to 5,000 rows); both doors call the same `ingestFile()`. Re-attaching replaces the rows only while the review is a draft (the old file is marked superseded); once the review has started it is refused.
   Then Claude calls `start_review`, pages `query_transactions`, calls `recall_episodes` and `lookup_reference`, then `submit_findings` and `write_memo`. Everything lands as a dashed **AI draft**. Claude cannot approve anything.
3. **Review** (`/clients` → Acme): a source-file chip under the header ("Attached in Claude · 30 rows · ₹4,72,957 · fingerprint 0d6a…"), memo on the left, findings on the right with source chips (`VP-10014`), basis chips (Rule, Past decision, Unverified) and a "Memory used" rail.
4. **Edit** (`Edit findings`): change severity or wording, assign an owner, merge, remove (with undo). The bar counts unsaved changes. Each save is a version with a diff, an audit event, and a past decision Claude can recall next month.
5. **Share:** enter the approver's name and email, *Create link*. The link is shown once; the approver passes an email code first (printed in the dev server log).
6. **Client decides** at `/s/<token>`: Approve, Dispute (reason required), or Needs receipt, per finding. They see findings only, never the ledger. Needs receipt creates a follow-up for next month.
7. **Month two:** ask Claude to review 2026-11. Open follow-ups come first. A repeat Taj flag is stored as a low-severity *suppressed* line citing October's dispute, never hidden. On the Edit screen, **Confirm suppression**: that is the second consistent decision.
8. **Learn:** Claude calls `propose_memory`. On **Memory** (`/clients/<id>/memory`) the proposal shows its evidence; **Approve rule** makes it durable (owner or manager only). It then reaches Claude in every future `start_review`.
9. **Prove:** `/audit` recomputes the hash chain ("Chain verified · N events") and exports CSV. Review has *Export resolved CSV*.

**Roles** (switch at `/login`): Owner and Manager do everything (only they approve rules). Bookkeeper sees assigned clients only (Ravi: Acme). Auditor is read-only. Claude acts with the role of whoever's token it holds.

## Watch it run

`docs/walkthrough/` holds 25 screenshots and `transcript.txt` from a scripted run that plays Claude (over real MCP), Priya, Arjun, Ravi and Asha. Reproduce it:

```bash
npm run seed && npm run dev -- -p 3100          # terminal 1 (redirect its output to a file)
BASE=http://localhost:3100 SERVER_LOG=<that file> npm run demo   # terminal 2
```

## Deploy to Vercel (public demo with synthetic data)

What this deployment is: a **demo**. `DEMO_MODE=1` opens sign-in to anyone with the link (they pick a seeded person) and shows the client's email code on screen when no mail provider is set. Do not put real client data in it. Real use needs email sign-in and invites, which are not built (see the end).

1. **Database.** Create a Neon project and copy the *pooled* connection string.
2. **Create the schema and seed it** from your machine (once):
   ```bash
   export DATABASE_URL="postgres://…-pooler…/neondb?sslmode=require"
   npm run db:push        # creates the tables
   npm run db:seed        # seeds the kit's demo data; prints RANDOM MCP tokens once, save them
   ```
   The seed refuses a database that already has data. `npm run db:reset` wipes it and reseeds (use it to reset the demo).
3. **Vercel.** Import this repo (the Next.js app is the repo root) and set these environment variables (see `.env.example`):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | the Neon pooled string (required) |
   | `SIGNOFF_SECRET` | `openssl rand -base64 48` (required, 32+ chars; without it, signing in and creating or opening share links fail with an error) |
   | `DEMO_MODE` | `1` |
   | `RESEND_API_KEY`, `MAIL_FROM` | optional: real OTP emails to client approvers |
   | `NEXT_PUBLIC_APP_URL` | optional: pin the public origin |

4. **Check it.** `https://<app>.vercel.app/api/health` should return `{"ok":true,"db":"up","mode":"demo"}`. If it says `DATABASE_URL is not set`, fix the variable and redeploy. The build itself does not need the secrets; a missing `SIGNOFF_SECRET` only shows up when someone signs in.
5. **Connect Claude** with `https://<app>.vercel.app/api/mcp` and a token from step 2 (see *Use it*, step 1).

Safety defaults in production: no `SIGNOFF_SECRET` or `DATABASE_URL` means it fails closed (no silent fallbacks); the repo's well-known dev tokens are never created on a real database; cookies are `Secure`; without `DEMO_MODE` there is no sign-in at all.

## Test the production path locally

No Postgres install needed: `pglite-socket` serves Postgres over the wire so the real driver (`postgres-js`) and `db:push` are exercised.

```bash
npm run pg:socket                                              # terminal 1
export DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5544/postgres?sslmode=disable"
npm run db:push && npx vitest run --no-file-parallelism        # whole suite through postgres-js
```

Known limit: this proves the driver and SQL, not Neon's pooler or true multi-connection concurrency. The audit chain uses an advisory lock plus a unique `(firm_id, seq)` constraint; the constraint guarantees a collision would fail loudly rather than fork the chain.

## Checks

`npm test` (38 tests: the kit's answer key, chat/upload ingest parity, limits, partial import, masking, roles, and the production guards), `npm run lint`, `npm run typecheck`, `npm run build`.

## Not built (see the kit's BUILD_PLAN)

Team page and `/try` sandboxes, receipt upload, playbook editing (button disabled), email sign-in and invites (the login picker is a demo stub; OTP email works if `RESEND_API_KEY` is set), per-visitor demo sandboxes (the demo database is shared), Postgres RLS and DB-computed audit hashes (the kit's `db/schema.sql`; here isolation and hashing are in app code and tested), Playwright e2e, OAuth 2.1, client deletion, memory decay job.
