# Design brief — Signoff

**Feel:** a well-kept ledger. Calm, dense, exact. Trust comes from showing sources, not from decoration.
Anti-goals: gradients, glassmorphism, robot/sparkle AI iconography, purple-everything.

## Tokens
| Token | Value | Use |
|---|---|---|
| `--paper` | `#FAFAF7` | page background |
| `--surface` | `#FFFFFF` | cards, tables |
| `--ink` | `#14161A` | primary text |
| `--muted` | `#6B6F76` | secondary text |
| `--rule` | `#E6E4DE` | borders, dividers |
| `--accent` | `#3F3DBC` | primary actions, links, AI-draft outline |
| `--accent-wash` | `#EEEEFB` | selected rows, AI-draft fill |
| `--high` | `#B42318` | high severity, disputed, chain broken |
| `--medium` | `#B54708` | medium severity, needs receipt, unverified |
| `--low` | `#475467` | low severity |
| `--ok` | `#067647` | approved, chain verified |
| radius | 8px cards, 6px chips | |
| type | Inter 13/14/16/20/28; **IBM Plex Mono** tabular for amounts, txn ids, hashes | |
| spacing | 4px grid; table rows 44px; page gutter 32px | |

Colour never carries meaning alone: every status also has an icon and a word.

## Trust components (build once, reuse everywhere)
- **AuthorBadge**: `AI draft` (dashed accent border, accent-wash fill) · `Edited by Priya` (solid) · `Approved by Arjun` (ok) · `Disputed by Arjun` (high)
- **SourceChip**: `VP-10014` (mono) → opens a drawer with the masked row
- **BasisChip**: `Rule` · `Past decision` · `Reference · as of 1 Nov 2026` · `Unverified (model knowledge)` in medium colour
- **MemoryChip**: `Rule: Taj offsites pre-approved` / `Episode: Sep 2026 dispute` → opens the memory item with evidence
- **ClientChip**: colour dot + client name, top-left on every firm screen ("Isolated workspace" tooltip)
- **ChainStatus**: `Chain verified · 142 events` (ok) or `Chain broken at event 87` (high)
- **SuppressedRow**: greyed finding row with `Suppressed by: Episode Oct 2026 — "pre-approved by board"`, never hidden

## Screens
1. **Clients** — table: client, tools, this month's status (Draft / In review / Shared / Signed off), open findings, overdue follow-ups, last activity. Side panel: "Start in Claude" as the main path (attach the export in Claude, copy the prompt) and "Upload here" as the fallback for files over 1,000 rows. Empty state: "Attach a myPay export in Claude to start".
2. **Review** — header: ClientChip, month switcher, status, Share button. Under the header: source file chip ("Attached in Claude · 30 rows · ₹4,72,957 · fingerprint 9c1e…"). Left 40%: memo (markdown, AuthorBadge, version). Right 60%: findings table — severity, title, txn chips, suggested action, basis chip, status, owner. Right rail (collapsible): **Memory used** — rules, episodes, follow-ups, references this review cited, grouped by memory type.
3. **Edit** — same table, inline editable; AI drafts dashed; row actions: merge, remove (reason), assign owner; bottom bar "3 unsaved changes · Save version"; diff drawer shows before/after per field with author and time.
4. **Share (client)** — no firm chrome. Header: "Acme Robotics · October 2026 review", "Prepared by Priya Raman (Ledgerly), analysed with Claude". Progress "7 of 12 decided". One card per finding: what, why, amount, txn summary, then three buttons Approve / Dispute / Needs receipt, comment box (required for Dispute), receipt upload. Footer: "You are seeing findings only, not your full ledger. Link expires 20 Nov 2026."
5. **Memory inspector** — ClientChip header, explainer line: "What Signoff remembers about Acme, and why." Banner: "2 proposals waiting for your approval". Tabs: Semantic · Episodic · Procedural · Prospective · External. Each item: content, status pill, evidence (episodes), author, approved by, hit count, last used, Retire. Proposal card: Claude's proposed rule + 2 evidence episodes + Approve / Edit / Reject. Side note box explains Parametric: "Claude's built-in knowledge is never stored here and is shown as Unverified when used."
6. **Audit trail** — ChainStatus + Verify button; filters (actor type, client, action); rows: time, actor badge (Claude / Priya / Arjun / System), action, entity link, short hash (mono). Export CSV.
7. **Connect Claude** — MCP URL with copy, token (masked, rotate, last used), 3 steps to add a custom connector in Claude, "Fields Claude can see" list (masked card, merchant as untrusted text, etc.).

8. **Team** (owner/manager) — members table: name, email, role (dropdown for owner), assigned clients, status, last active; Invite button; a read-only "What each role can do" panel mirroring the PRD matrix. Demo sandboxes show a top banner: "Demo workspace · viewing as Owner ▾ · resets in 6 days".
Every firm screen: hide actions the role cannot do; where hiding would confuse, show the control disabled with a one-line reason ("Only a manager can approve rules").

## States to design
empty · uploading/ingest errors per line · AI draft not reviewed · partially decided · fully signed off · share link expired · chain broken

## Sample content (use real-looking data from seed/)
Acme Robotics, October 2026, ₹4,72,957 across 30 transactions, 8 findings: Zomato duplicate ₹4,250 (high), Taj offsite ₹1,85,000 for 22 people (medium), The Bottle Shop ₹6,800 (high), Uber ₹3,200 no receipt (medium), Amazon ₹18,999 no receipt (medium), Figma coded as Travel (low), Google Workspace 3× (low), unknown merchant with suspicious note (medium).
