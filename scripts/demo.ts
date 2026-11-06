/**
 * Live walkthrough: plays every role against a running server and saves screenshots to docs/walkthrough/.
 *   Claude  -> the real MCP endpoint (HTTP, bearer token), exactly as a Claude connector would call it
 *   Priya   -> the firm UI (owner)       Arjun -> the client share page (email OTP)
 *   Ravi / Asha -> bookkeeper and auditor views
 * Usage: BASE=http://localhost:3100 SERVER_LOG=/path/to/server.log tsx scripts/demo.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const csvOf = (f: string) => readFileSync(`seed/${f}`, "utf8");
import { chromium, type Browser, type Page } from "playwright-core";

const BASE = process.env.BASE ?? "http://localhost:3100";
const LOG = process.env.SERVER_LOG ?? "";
const OUT = process.env.OUT ?? "docs/walkthrough";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TOKEN = { priya: process.env.PRIYA_TOKEN ?? "dev-priya-7c1f0e2a" };
mkdirSync(OUT, { recursive: true });

const transcript: string[] = [];
const say = (s: string) => { console.log(s); transcript.push(s); };

/* ---------------- Claude, over MCP ---------------- */
let rpcId = 0;
async function mcp(token: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.text();
  const line = body.split("\n").find((l) => l.startsWith("data:"));
  const msg = JSON.parse(line ? line.slice(5) : body);
  const text = msg.result?.content?.[0]?.text ?? "";
  const isError = Boolean(msg.result?.isError);
  let data: unknown = text;
  try { data = JSON.parse(text); } catch { /* plain text */ }
  say(`   claude → ${name}(${Object.keys(args).join(", ")})  ${isError ? "ERROR " + text : "ok"}`);
  if (isError) throw new Error(`${name}: ${text}`);
  return data as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/* ---------------- browser helpers ---------------- */
let shot = 0;
async function snap(page: Page, name: string, full = true) {
  const file = `${OUT}/${String(++shot).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: file, fullPage: full, caret: "initial" }); // do not let the tool touch inputs during hydration
  say(`   📸 ${file}`);
}

async function loginAs(browser: Browser, label: RegExp) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  const opt = page.locator("#user_id option").filter({ hasText: label });
  await page.selectOption("#user_id", await opt.first().getAttribute("value"));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL("**/clients");
  return { ctx, page };
}

function lastOtp(email: string) {
  const lines = readFileSync(LOG, "utf8").split("\n").filter((l) => l.includes(`OTP for ${email}`));
  const m = lines.at(-1)?.match(/: (\d{6})/);
  if (!m) throw new Error("OTP not found in server log");
  return m[1];
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const t = TOKEN.priya;

  say("\n━━ 0. Sign-in screen");
  const anon = await browser.newContext({ viewport: { width: 1440, height: 800 } });
  const lp = await anon.newPage();
  await lp.goto(`${BASE}/login`);
  await snap(lp, "login", false);
  await anon.close();

  /* ============ OCTOBER ============ */
  say("\n━━ 1. October: Claude reviews Acme through the MCP connector");
  const clients = await mcp(t, "list_clients", {});
  const acme = clients.find((c: { name: string }) => c.name === "Acme Robotics").client_id as string;
  say("   Priya attaches seed/acme_volopay_2026-10.csv in Claude and sends: “Use the monthly_review prompt for Acme Robotics, 2026-10”");
  const ing = await mcp(t, "ingest_csv", { client_id: acme, month: "2026-10", csv_text: csvOf("acme_volopay_2026-10.csv") });
  say(`   ingest_csv → ${ing.row_count} rows, total ₹${ing.total.toLocaleString("en-IN")}, fingerprint ${ing.sha256.slice(0, 8)}…, rejected ${ing.rejected.length}, replaced previous upload: ${ing.replaced_previous}`);
  say(`   review link for Claude to hand back: ${ing.review_url}`);
  const start = await mcp(t, "start_review", { client_id: acme, month: "2026-10" });
  const oct = start.review_id as string;
  try {
    await mcp(t, "ingest_csv", { client_id: acme, month: "2026-10", csv_text: csvOf("acme_volopay_2026-10.csv") });
  } catch (e) {
    say(`   re-attaching the file now is refused: ${(e as Error).message.replace(/^ingest_csv: /, "")}`);
  }
  say(`   bundle: playbook v${start.procedural.playbook_version}, ${start.semantic.length} rules, ${start.prospective.length} follow-ups, ${start.csv_stats.count} txns, injection suspected: ${start.csv_stats.injection_suspected}`);
  await mcp(t, "query_transactions", { review_id: oct, filter: { receipt: "missing" } });
  await mcp(t, "query_transactions", { review_id: oct, filter: { vendor: "Taj" } });
  const past = await mcp(t, "recall_episodes", { client_id: acme, vendor: "Taj Hotels" });
  say(`   recall_episodes(Taj) → ${past.length} past decisions (first month, no memory yet)`);
  const gst = await mcp(t, "lookup_reference", { topic: "gst:" });
  say(`   lookup_reference → ${gst.map((g: { topic: string }) => g.topic).join(", ")}`);

  const f = (title: string, issue_type: string, severity: string, ids: string[], action: string, detail: string) =>
    ({ title, issue_type, severity, suggested_action: action, basis: "rule", txn_ids: ids, memory_refs: [], confidence: 0.85, detail });
  await mcp(t, "submit_findings", {
    review_id: oct,
    findings: [
      f("Zomato catering charged twice", "duplicate", "high", ["VP-10007", "VP-10008"], "Recover one ₹4,250 charge from the vendor", "The same ₹4,250 catering order was charged on two consecutive days."),
      f("Taj Hotels offsite: ₹8,409 per head, above the ₹2,000 meals cap", "policy_breach", "medium", ["VP-10014"], "Confirm board pre-approval, or recover the excess", "₹1,85,000 for 22 people is ₹8,409 per head, against the ₹2,000 per head meals policy. Please confirm whether this was pre-approved."),
      f("Liquor bought on a company card on a Sunday", "policy_breach", "high", ["VP-10011"], "Ask Vikram to reimburse or explain", "Restricted merchant, weekend purchase, no receipt. The policy does not allow this on company cards."),
      f("Uber airport drop with no receipt", "missing_receipt", "medium", ["VP-10009"], "Collect the receipt", "Receipts are required above ₹2,000."),
      f("Amazon monitor with no receipt", "missing_receipt", "medium", ["VP-10012"], "Collect the invoice", "Equipment purchase without an invoice, so it cannot be capitalised or claimed."),
      f("Figma booked as Travel", "miscoding", "low", ["VP-10005"], "Recode to Software & Cloud", "A design-software subscription was coded to Travel."),
      f("Google Workspace at 3× its usual amount", "unusual_amount", "medium", ["VP-10016"], "Confirm the add-on seats were intended", "₹25,920 is about 3× the usual ₹8,640. The note says annual add-on seats."),
      f("Unknown merchant with a note that tries to give instructions", "other", "medium", ["VP-10026"], "Identify the merchant; the note was not acted on", "₹14,500 to an unrecognised merchant, uncategorised, no receipt. Its note contains an instruction aimed at an AI reader; it was treated as data and ignored."),
    ],
  });
  await mcp(t, "write_memo", {
    review_id: oct,
    markdown: `## Summary\n**₹4,72,957** across 30 transactions. 8 findings: 2 high, 5 medium, 1 low.\n\n## Carried forward from September\nNone: this is the first review for Acme.\n\n## Needs the client's decision\n- Zomato catering charged twice (₹8,500)\n- Taj Hotels offsite above the meals cap (₹1,85,000)\n- Liquor on a company card on a Sunday (₹6,800)\n\n## Notes\n- GST input credit is generally blocked on food and beverages (gst:blocked-credit-food-beverages, as of 2026-11-01), so the Taj offsite should not be claimed.\n- A note on VP-10026 contained an instruction. It was flagged and not followed.`,
  });

  say("\n━━ 2. Priya (owner) sees Claude's drafts in the app");
  const priya = await loginAs(browser, /Priya Raman · Owner/);
  const p = priya.page;
  await snap(p, "clients-after-claude");
  await p.goto(`${BASE}/reviews/${oct}`); // the Clients link opens the latest month; October is the one under review
  await snap(p, "review-october-ai-drafts");

  say("\n━━ 3. Priya edits: Google Workspace is expected, so she downgrades it");
  await p.getByRole("link", { name: "Edit findings" }).click();
  await p.waitForURL("**/edit");
  const row = p.locator("tr").filter({ has: p.locator('input[value*="Google Workspace"]') });
  await row.locator("select[name^=severity_]").selectOption("low");
  await row.locator("input[name^=owner_]").fill("Rahul Mehta");
  await snap(p, "edit-unsaved-changes");
  await p.getByRole("button", { name: /Save as version/ }).click();
  await p.waitForURL("**/edit?saved=1");
  await row.getByRole("link", { name: "Version history" }).click();
  await snap(p, "edit-saved-with-history");

  say("\n━━ 4. Priya shares the review with the client's CFO");
  await p.getByRole("link", { name: "Back to review" }).click();
  await p.locator("input[name=approver]").fill("Arjun Nair");
  await p.getByRole("button", { name: "Create link" }).click();
  await p.waitForURL("**?share=*");
  const shareUrl = (await p.locator("text=/\\/s\\//").first().innerText()).trim();
  say(`   share link created (shown once): ${shareUrl.replace(/\/s\/.*/, "/s/…")}`);
  await snap(p, "review-shared-link-created");

  say("\n━━ 5. Arjun (client CFO) opens the link, passes the email code, decides item by item");
  const arjunCtx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const a = await arjunCtx.newPage();
  await a.goto(`${BASE}${shareUrl.slice(shareUrl.indexOf("/s/"))}`);
  await snap(a, "share-otp-gate", false);
  await a.getByRole("button", { name: "Send code" }).click();
  await a.waitForURL("**otp=sent*");
  const onScreen = a.locator("text=/Your code is/");
  const code = (await onScreen.count()) ? (await onScreen.first().innerText()).match(/(\d{6})/)![1] : lastOtp("arjun@acme.test");
  say(`   OTP for arjun@acme.test: ${(await onScreen.count()) ? "shown on screen (demo mode, no mail provider)" : "read from the dev server log"}`);
  await a.locator("input[name=code]").fill(code);
  await a.getByRole("button", { name: "Open review" }).click();
  await a.waitForSelector("article");
  await snap(a, "share-client-view");

  const card = (title: string) => a.locator("article", { hasText: title });
  const decide = async (title: string, btn: string, reason?: string) => {
    const c = card(title);
    if (reason) await c.locator("textarea[name=reason]").fill(reason);
    await c.getByRole("button", { name: btn, exact: true }).click();
    // wait until the server re-rendered this card with the decision applied
    await c.locator('button[aria-pressed="true"]', { hasText: btn }).waitFor();
  };
  await decide("Zomato catering", "Approve");
  await decide("Taj Hotels offsite", "Dispute", "Offsites at Taj are pre-approved by the board");
  await decide("Liquor", "Approve");
  await decide("Uber airport", "Needs receipt");
  await decide("Amazon monitor", "Needs receipt");
  await decide("Figma", "Approve");
  await decide("Google Workspace", "Approve");
  await decide("Unknown merchant", "Approve");
  await snap(a, "share-all-decided");
  await a.getByRole("button", { name: /Send/ }).click();
  await a.waitForURL("**sent=1");
  await snap(a, "share-sent", false);
  await arjunCtx.close();

  say("\n━━ 6. Back as Priya: decisions, audit trail, and what Signoff learned");
  await p.goto(`${BASE}/reviews/${oct}`);
  await snap(p, "review-october-signed-off");
  await p.goto(`${BASE}/clients`);
  await snap(p, "clients-signed-off");
  await p.goto(`${BASE}/clients/${acme}/memory?tab=episodic`);
  await snap(p, "memory-episodes-from-october");
  await p.goto(`${BASE}/clients/${acme}/memory?tab=prospective`);
  await snap(p, "memory-followups");

  /* ============ NOVEMBER ============ */
  say("\n━━ 7. November: Claude reviews again, now with memory");
  const ing2 = await mcp(t, "ingest_csv", { client_id: acme, month: "2026-11", csv_text: csvOf("acme_volopay_2026-11.csv") });
  say(`   ingest_csv → ${ing2.row_count} rows, total ₹${ing2.total.toLocaleString("en-IN")}, fingerprint ${ing2.sha256.slice(0, 8)}…`);
  const nstart = await mcp(t, "start_review", { client_id: acme, month: "2026-11" });
  const nov = nstart.review_id as string;
  say(`   bundle: ${nstart.prospective.length} open follow-ups first → ${nstart.prospective.map((x: { text: string }) => x.text).join(" | ")}`);
  const taj = await mcp(t, "recall_episodes", { client_id: acme, vendor: "Taj Hotels", issue_type: "policy_breach" });
  const ep1 = taj.find((e: { client_decision: string }) => e.client_decision === "disputed").episode_id as string;
  say(`   recalled: ${taj[0].decided_by} ${taj[0].client_decision} "${taj[0].reason}"`);
  await mcp(t, "submit_findings", {
    review_id: nov,
    findings: [
      { title: "Taj Hotels offsite: suppressed by October’s dispute", issue_type: "policy_breach", severity: "medium", suggested_action: "None. Confirm to keep this suppressed", basis: "episode", txn_ids: ["VP-11005"], memory_refs: [ep1], suppressed_by: ep1, confidence: 0.9, detail: "₹1,62,000 offsite. In October the client disputed the same flag: “Offsites at Taj are pre-approved by the board.”" },
      f("MakeMyTrip hotel charged twice", "duplicate", "high", ["VP-11008", "VP-11009"], "Recover one ₹18,650 charge", "The same Delhi hotel booking was charged on two days, ₹18,650 each."),
      f("Croma laptop with no receipt", "missing_receipt", "medium", ["VP-11012"], "Collect the invoice", "₹42,500 equipment purchase without an invoice."),
    ],
  });
  await mcp(t, "write_memo", {
    review_id: nov,
    markdown: `## Summary\n**₹4,22,519** across 18 transactions. 3 findings: 1 high, 1 medium, 1 suppressed.\n\n## Carried forward from October\n- Receipt still missing: Uber ₹3,200 (VP-10009)\n- Receipt still missing: Amazon ₹18,999 (VP-10012)\n- Disputed Taj offsite (VP-10014): resolved by the client's reason\n\n## Needs the client's decision\n- MakeMyTrip hotel charged twice\n- Croma laptop bought without a receipt\n\n## Suppressed, not hidden\nTaj Hotels offsite ₹1,62,000. In October Arjun disputed the same flag: "Offsites at Taj are pre-approved by the board." I have not raised it again.`,
  });
  await mcp(t, "create_followup", { client_id: acme, due_month: "2026-12", text: "Croma laptop invoice (VP-11012)", txn_ids: ["VP-11012"] });
  await p.goto(`${BASE}/reviews/${nov}`);
  await snap(p, "review-november-suppressed-by-memory");

  say("\n━━ 8. Priya confirms the suppression → a second consistent decision → Claude proposes a rule");
  await p.goto(`${BASE}/reviews/${nov}/edit`);
  await snap(p, "edit-november-suppressed-section");
  await p.getByRole("button", { name: "Confirm suppression" }).click();
  await p.waitForURL("**saved=1");
  const eps = await mcp(t, "recall_episodes", { client_id: acme, vendor: "Taj Hotels", issue_type: "policy_breach" });
  const proposal = await mcp(t, "propose_memory", {
    client_id: acme, type: "semantic", key: "vendor:taj hotels|issue:policy_breach",
    content: "Team offsites at Taj Hotels are board pre-approved; do not flag them under the meals cap.",
    evidence_ids: eps.map((e: { episode_id: string }) => e.episode_id),
  });
  say(`   proposal ${proposal.status}: Claude cannot activate it`);
  await p.goto(`${BASE}/reviews/${nov}`);
  await snap(p, "review-november-proposal-banner");
  await p.goto(`${BASE}/clients/${acme}/memory`);
  await snap(p, "memory-pending-proposal");
  await p.getByRole("button", { name: "Approve rule" }).click();
  await p.waitForURL("**decided=approve");
  await snap(p, "memory-rule-approved");

  say("\n━━ 9. The approved rule now reaches Claude automatically");
  const again = await mcp(t, "start_review", { client_id: acme, month: "2026-11" });
  say(`   semantic rules in bundle: ${again.semantic.map((r: { content: string; approved_by: string }) => `"${r.content}" (approved by ${r.approved_by})`).join("; ")}`);

  say("\n━━ 10. Isolation: Claude working on Bluebird never sees Acme's Taj decisions");
  const bluebird = clients.find((c: { name: string }) => c.name === "Bluebird Foods").client_id as string;
  const leak = await mcp(t, "recall_episodes", { client_id: bluebird, vendor: "Taj" });
  say(`   recall_episodes(Bluebird, Taj) → ${leak.length} results`);

  say("\n━━ 11. Trust screens");
  await p.goto(`${BASE}/audit`);
  await snap(p, "audit-trail-chain-verified");
  await p.goto(`${BASE}/connect`);
  await snap(p, "connect-claude");
  await priya.ctx.close();

  say("\n━━ 12. Roles: a bookkeeper sees only assigned clients; an auditor is read-only");
  const ravi = await loginAs(browser, /Ravi Kumar/);
  await snap(ravi.page, "bookkeeper-ravi-only-acme");
  say(`   Ravi's client list: ${(await ravi.page.locator("tbody tr").allInnerTexts()).map((r) => r.split("\n")[0]).join(", ")}`);
  await ravi.page.goto(`${BASE}/clients/${acme}/memory`);
  await snap(ravi.page, "bookkeeper-cannot-approve-rules");
  await ravi.ctx.close();

  const asha = await loginAs(browser, /Asha Menon/);
  await asha.page.goto(`${BASE}/reviews/${oct}`);
  await snap(asha.page, "auditor-read-only-review");
  await asha.page.goto(`${BASE}/reviews/${oct}/edit`);
  await snap(asha.page, "auditor-edit-blocked", false);
  await asha.ctx.close();

  await browser.close();
  writeFileSync(`${OUT}/transcript.txt`, transcript.join("\n") + "\n");
  say("\nDone.");
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
