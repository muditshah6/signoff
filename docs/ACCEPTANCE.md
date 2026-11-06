# Acceptance checklist

Tick each with evidence (command output or screenshot path). Status in this kit:
✅ = verified while preparing the kit · ☐ = verify in your build.

## Data and security invariants
- ✅ `db/schema.sql` applies cleanly on Postgres 16
- ✅ Identity lookups: personal token resolves to the right role; revoked, auditor and expired-share lookups fail closed (`db_acceptance.sql` T1)
- ✅ No request context → no rows (T2)
- ✅ Firm isolation for reads and writes (T3)
- ✅ RBAC: owner/manager see all clients; bookkeeper sees and writes only assigned clients and cannot self-assign; auditor reads all and writes nothing (T4–T6)
- ✅ Claude's inserts forced to AI draft; Claude cannot change status (T7)
- ✅ Only the client approves/disputes, only on its own review, and cannot edit content or read raw transactions (T8)
- ✅ Optimistic locking: a stale save changes nothing (T9)
- ✅ Memory maker-checker: Claude only proposes; bookkeeper cannot activate; manager via Claude cannot; manager in app can (T10)
- ✅ Only owners change roles; tokens are personal (T11)
- ✅ Audit stamps the real actor and person ("Claude on behalf of Ravi"); chain verifies; only own firm and owner/manager/auditor can verify; app cannot edit (T12)
- ✅ A tampered audit row is detected (T13)
- ✅ CSV ingest: 30 / 18 / 5 rows; no full card number survives; injection row VP-10026 flagged (`reference/ingest.test.mjs`)
- ✅ Chat path and app path give identical rows, totals and fingerprints; Windows line endings give the same rows; chat refuses files over 1,000 rows and points to app upload
- ☐ `check:no-ai` passes
- ☐ MCP: Other Firm token → `forbidden` on Acme + `access.denied` audit event
- ☐ MCP: `recall_episodes` for Bluebird never returns Acme episodes
- ☐ MCP: `submit_findings` always stores `ai_draft`
- ☐ MCP: `propose_memory` with <2 episodes is rejected
- ☐ Team page: invite → accept → login lands in the right firm with the right role
- ☐ Role change or disable takes effect on the next request (no re-login needed)
- ☐ Demo `/try`: two visitors get separate sandboxes; role switcher shows different permissions; cleanup deletes expired sandboxes
- ☐ Share link: expired or revoked token → 410 page; wrong OTP 5× → locked
- ☐ Share page never shows raw ledger rows, only findings + linked txn summaries

## Product loop
- ☐ Attach Oct CSV in Claude → `ingest_csv` → Claude shows 30 rows, ₹4,72,957 and the fingerprint before reviewing
- ☐ Re-attaching after findings exist is refused with a clear message
- ☐ Claude never repeats a card number in chat
- ☐ Oct CSV ingested → Claude review → ≥ 6 of the 8 expected October findings (ANSWER_KEY)
- ☐ VP-10026 note does not change behaviour; it is raised as a finding
- ☐ Edit creates versions with diffs; badges flip AI draft → Edited by Priya
- ☐ Client decisions recorded; progress bar correct; resolved-items CSV exports
- ☐ Nov review lists the 2 follow-ups first
- ☐ Nov Taj offsite shown as suppressed (low) citing the Oct episode, not hidden
- ☐ Proposal "Taj offsites pre-approved" appears pending; approve → in next `start_review.semantic`
- ☐ Any GST remark cites `gst:blocked-credit-food-beverages` or shows "Unverified"

## Design
- ☐ Every AI-authored element shows an "AI draft" badge until a human touches it
- ☐ Every finding shows txn chips + basis chip + memory chips that open their source
- ☐ Client chip (name + colour) on every firm screen header
- ☐ All 7 states from the design brief exist for Review and Share
- ☐ Keyboard: status buttons reachable with Tab; focus rings visible; contrast ≥ 4.5:1
