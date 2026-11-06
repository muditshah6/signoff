import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { auditEvents, findings, followups, memoryItems, shareLinks, transactions } from "@/db/schema";
import { verifyChain } from "@/lib/audit";
import { confirmSuppression, decideFinding, dropFinding, editFinding, listFindings } from "@/lib/findings";
import { decideProposal } from "@/lib/memory";
import { seed, type Seeded } from "@/lib/seed";
import { createShareLink, resolveLink, revokeLink } from "@/lib/share";
import { rateLimited, resolveToken, rotateMcpToken } from "@/lib/tokens";
import { can } from "@/lib/rbac";
import * as t from "@/mcp/tools";

let db: Db;
let S: Seeded;
const as = (who: string): t.ToolCtx => ({ db, ctx: { ...S.ctx[who], actor: "claude" } });

beforeAll(async () => {
  db = await getDb();
  S = await seed(db);
});

const ids = async (rev: string, vendor: string) =>
  (await t.queryTransactions(as("priya"), { review_id: rev, filter: { vendor } })).rows.map((r) => r.ext_id);

describe("ingest + injection", () => {
  it("masks cards to last 4 and never stores a full PAN", async () => {
    const rows = await db.select().from(transactions).where(eq(transactions.reviewId, S.review["acme:2026-10"]));
    expect(rows).toHaveLength(30);
    expect(rows.every((r) => r.cardLast4?.length === 4)).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/4111 1111/);
  });

  it("flags VP-10026, wraps free text as untrusted_text, and never writes it to memory", async () => {
    const start = await t.startReview(as("priya"), { client_id: S.client.acme.id, month: "2026-10" });
    expect(start.csv_stats.injection_suspected).toEqual(["VP-10026"]);
    const r = await t.queryTransactions(as("priya"), { review_id: start.review_id, filter: { ext_ids: ["VP-10026"] } });
    expect(r.rows[0].notes.untrusted_text).toMatch(/ignore all previous instructions/i);
    expect(r.rows[0].injection_suspected).toBe(true);
    expect(JSON.stringify(await db.select().from(memoryItems))).not.toMatch(/ignore all previous/i);
  });
});

describe("roles, tokens and isolation", () => {
  it("cross-firm: another firm's token cannot reach Acme, and the denial is audited", async () => {
    await expect(t.startReview(as("intruder"), { client_id: S.client.acme.id, month: "2026-10" })).rejects.toMatchObject({ status: 403 });
    const denied = await db.select().from(auditEvents).where(eq(auditEvents.action, "access.denied"));
    expect(denied.length).toBeGreaterThan(0);
  });

  it("a bookkeeper only sees assigned clients", async () => {
    const mine = await t.listClients(as("ravi"));
    expect(mine.map((c) => c.name)).toEqual(["Acme Robotics"]);
    await expect(t.startReview(as("ravi"), { client_id: S.client.bluebird.id, month: "2026-10" })).rejects.toMatchObject({ status: 403 });
    expect((await t.listClients(as("priya"))).map((c) => c.name)).toEqual(["Acme Robotics", "Bluebird Foods"]);
  });

  it("recall_episodes for Bluebird never returns Acme episodes", async () => {
    const eps = await t.recall(as("priya"), { client_id: S.client.bluebird.id, vendor: "taj" });
    expect(eps).toEqual([]);
  });

  it("auditors read but cannot edit, and get no Claude token; revoked tokens stop working", async () => {
    expect(can("auditor", "finding.edit")).toBe(false);
    expect(can("auditor", "audit.read")).toBe(true);
    expect(can("bookkeeper", "memory.decide")).toBe(false);
    expect(can("manager", "memory.decide")).toBe(true);
    expect(await resolveToken(db, "dev-priya-7c1f0e2a")).toMatchObject({ role: "owner", actor: "claude" });
    expect(await resolveToken(db, "not-a-token")).toBeNull();
    const fresh = await rotateMcpToken(db, S.ctx.meera.firmId, S.ctx.meera.userId);
    expect(await resolveToken(db, "dev-meera-3b9d41c7")).toBeNull();
    expect(await resolveToken(db, fresh)).toMatchObject({ role: "manager" });
  });

  it("rate limits at 60 calls per minute", () => {
    const now = Date.now();
    expect(Array.from({ length: 61 }, () => rateLimited("u-x", 60, now)).filter(Boolean)).toHaveLength(1);
  });
});

describe("answer key: October decisions change November", () => {
  let oct: string, nov: string, tajFinding: string, tajEp: string;

  it("Claude submits drafts; status is forced to ai_draft and unknown txn ids are rejected", async () => {
    const start = await t.startReview(as("priya"), { client_id: S.client.acme.id, month: "2026-10" });
    oct = start.review_id;
    expect(start.procedural?.playbook_version).toBe(1);
    await expect(t.submit(as("priya"), { review_id: oct, findings: [{
      title: "x", issue_type: "other", severity: "low", suggested_action: "x", basis: "rule", txn_ids: ["VP-99999"], memory_refs: [], confidence: 0.5 }] }))
      .rejects.toThrow(/Unknown txn_ids/);
    const { created } = await t.submit(as("priya"), { review_id: oct, findings: [
      { title: "Zomato catering charged twice", issue_type: "duplicate", severity: "high", suggested_action: "Recover one charge", basis: "rule", txn_ids: ["VP-10007", "VP-10008"], memory_refs: [], confidence: 0.9 },
      { title: "Taj Hotels offsite above the meals cap", issue_type: "policy_breach", severity: "medium", suggested_action: "Confirm pre-approval", basis: "rule", txn_ids: ["VP-10014"], memory_refs: [], confidence: 0.8 },
      { title: "Uber with no receipt", issue_type: "missing_receipt", severity: "medium", suggested_action: "Get receipt", basis: "rule", txn_ids: ["VP-10009"], memory_refs: [], confidence: 0.9 },
    ] });
    expect(created).toHaveLength(3);
    const fs = await listFindings(db, oct);
    expect(fs.every((f) => f.status === "ai_draft" && f.authorType === "claude")).toBe(true);
    tajFinding = fs.find((f) => f.title.startsWith("Taj"))!.id;
  });

  it("Priya's edit writes a version with a diff and an episode", async () => {
    await editFinding(db, { firmId: S.ctx.priya.firmId, findingId: tajFinding, actor: { type: "user", id: "Priya" }, patch: { severity: "low", owner: "Karan Malhotra" } });
    const [f] = await db.select().from(findings).where(eq(findings.id, tajFinding));
    expect(f).toMatchObject({ status: "edited", severity: "low" });
  });

  it("Arjun disputes Taj and marks receipts; the app writes episodes and follow-ups with VP ids", async () => {
    const fs = await listFindings(db, oct);
    const by = (s: string) => fs.find((f) => f.title.startsWith(s))!.id;
    const common = { firmId: S.ctx.priya.firmId, reviewId: oct, by: "Arjun Nair" };
    await decideFinding(db, { ...common, findingId: by("Zomato"), decision: "approved" });
    await decideFinding(db, { ...common, findingId: tajFinding, decision: "disputed", reason: "Offsites at Taj are pre-approved by the board" });
    await decideFinding(db, { ...common, findingId: by("Uber"), decision: "needs_receipt" });
    const fu = await db.select().from(followups).where(eq(followups.clientId, S.client.acme.id));
    expect(fu.map((f) => f.dueMonth)).toEqual(["2026-11", "2026-11"]);
    expect(fu.flatMap((f) => f.txnIds).sort()).toEqual(["VP-10009", "VP-10014"]);
    const eps = await t.recall(as("priya"), { client_id: S.client.acme.id, vendor: "Taj Hotels" });
    expect(eps[0]).toMatchObject({ client_decision: "disputed", reason: expect.stringContaining("pre-approved") });
    tajEp = eps[0].episode_id;
  });

  it("a dispute without a reason is refused", async () => {
    const [f] = await db.insert(findings).values({ firmId: S.ctx.priya.firmId, reviewId: oct, clientId: S.client.acme.id, title: "x", issueType: "x", basis: "rule" }).returning();
    await expect(decideFinding(db, { firmId: S.ctx.priya.firmId, findingId: f.id, reviewId: oct, decision: "disputed", by: "Arjun" })).rejects.toThrow(/reason/);
  });

  it("November: follow-ups come first, Taj is suppressed by the October episode, one proposal needs 2 episodes", async () => {
    const start = await t.startReview(as("priya"), { client_id: S.client.acme.id, month: "2026-11" });
    nov = start.review_id;
    expect(start.prospective.map((p) => p.text).join(" ")).toMatch(/Receipt needed: Uber/);
    const out = await t.submit(as("priya"), { review_id: nov, findings: [{
      title: "Taj offsite (suppressed by past dispute)", issue_type: "policy_breach", severity: "medium", suggested_action: "none",
      basis: "episode", txn_ids: await ids(nov, "Taj"), memory_refs: [tajEp], confidence: 0.9, suppressed_by: tajEp }] });
    const [f] = await db.select().from(findings).where(eq(findings.id, out.created[0]));
    expect(f).toMatchObject({ status: "suppressed", severity: "low", suppressedBy: tajEp });

    // only one episode so far -> rejected
    await expect(t.propose(as("priya"), { client_id: S.client.acme.id, type: "semantic", key: "vendor:taj hotels|issue:policy_breach",
      content: "Team offsites at Taj Hotels are board pre-approved", evidence_ids: [tajEp, tajEp] })).rejects.toThrow(/2 or more/);
  });

  it("a second consistent decision allows a proposal; only a manager/owner activates; it then suppresses automatically", async () => {
    const [n] = await listFindings(db, nov);
    await confirmSuppression(db, { firmId: S.ctx.priya.firmId, findingId: n.id, actor: { type: "user", id: "Priya Raman" } });
    const eps = await t.recall(as("priya"), { client_id: S.client.acme.id, vendor: "Taj Hotels" });
    expect(eps.length).toBeGreaterThanOrEqual(2);
    const p = await t.propose(as("priya"), { client_id: S.client.acme.id, type: "semantic", key: "vendor:taj hotels|issue:policy_breach",
      content: "Team offsites at Taj Hotels are board pre-approved; do not flag under the meals cap", evidence_ids: eps.map((e) => e.episode_id) });
    expect(p.status).toBe("pending");
    expect((await db.select().from(memoryItems).where(eq(memoryItems.id, p.memory_id)))[0].status).toBe("pending");
    await decideProposal(db, { firmId: S.ctx.priya.firmId, itemId: p.memory_id, decision: "approve", actor: { type: "user", id: "Priya Raman" } });
    const [m] = await db.select().from(memoryItems).where(eq(memoryItems.id, p.memory_id));
    expect(m).toMatchObject({ status: "active", approvedBy: "Priya Raman" });

    // a future flag on Taj is now suppressed by the rule
    const again = await t.submit(as("priya"), { review_id: nov, findings: [{
      title: "Taj again", issue_type: "policy_breach", severity: "high", suggested_action: "x", basis: "parametric",
      txn_ids: await ids(nov, "Taj"), memory_refs: [], confidence: 0.5 }] });
    const [g] = await db.select().from(findings).where(eq(findings.id, again.created[0]));
    expect(g).toMatchObject({ status: "suppressed", severity: "low" });
    const start = await t.startReview(as("priya"), { client_id: S.client.acme.id, month: "2026-11" });
    expect(start.semantic.some((r) => r.content.includes("Taj"))).toBe(true);
  });

  it("dropping a false positive keeps the row and history", async () => {
    const fs = await listFindings(db, oct);
    await dropFinding(db, { firmId: S.ctx.priya.firmId, findingId: fs[0].id, actor: { type: "user", id: "Priya" }, reason: "false positive" });
    const [f] = await db.select().from(findings).where(eq(findings.id, fs[0].id));
    expect(f.status).toBe("dropped");
  });
});

describe("share links", () => {
  it("resolve, expire and revoke", async () => {
    const { token, link } = await createShareLink(db, S.review["acme:2026-10"], "arjun@acme.test", "Arjun Nair", "ravi@ledgerly.test");
    expect((await resolveLink(db, token)).ok).toBe(true);
    expect(await resolveLink(db, token + "x")).toMatchObject({ ok: false, reason: "invalid" });
    await db.update(shareLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(shareLinks.id, link.id));
    expect(await resolveLink(db, token)).toMatchObject({ ok: false, reason: "expired" });
    await db.update(shareLinks).set({ expiresAt: new Date(Date.now() + 86_400_000) }).where(eq(shareLinks.id, link.id));
    await revokeLink(db, link.id);
    expect(await resolveLink(db, token)).toMatchObject({ ok: false, reason: "revoked" });
  });
});

describe("audit chain", () => {
  it("verifies end to end, then detects tampering at the first broken link", async () => {
    const firmId = S.ctx.priya.firmId;
    const ok = await verifyChain(db, firmId);
    expect(ok.ok).toBe(true);
    expect(ok.count).toBeGreaterThan(15);
    const [victim] = await db.select().from(auditEvents).where(eq(auditEvents.firmId, firmId)).limit(1);
    await db.update(auditEvents).set({ payloadJson: { tampered: true } }).where(eq(auditEvents.id, victim.id));
    expect(await verifyChain(db, firmId)).toMatchObject({ ok: false, brokenAtSeq: victim.seq });
  });
});
