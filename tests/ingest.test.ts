import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { auditEvents, reviews, sourceFiles, transactions } from "@/db/schema";
import { fingerprint, ingestVolopayCsv } from "@/lib/csv";
import { seed, type Seeded } from "@/lib/seed";
import * as t from "@/mcp/tools";

let db: Db;
let S: Seeded;
const as = (who: string): t.ToolCtx => ({ db, ctx: { ...S.ctx[who], actor: "claude" }, origin: "http://app.test" });
const oct = readFileSync("seed/acme_volopay_2026-10.csv", "utf8");
const HEAD = "Transaction ID,Transaction Date,Merchant,Amount,Currency,Category,Card Number,Employee,Department,Receipt,Notes";

beforeAll(async () => {
  db = await getDb();
  S = await seed(db);
});

describe("one ingest function, two doors", () => {
  it("chat path and app path give identical rows, totals and fingerprints", () => {
    const chat = ingestVolopayCsv(oct, { source: "chat" });
    const app = ingestVolopayCsv(oct, { source: "upload" });
    if (!chat.ok || !app.ok) throw new Error("expected both to parse");
    expect(chat.rows).toEqual(app.rows);
    expect(chat.stats.sha256).toBe(app.stats.sha256);
    expect(chat.stats.sha256).toBe(fingerprint(oct));
    expect(chat.stats.total).toBe(472957);
    expect(chat.stats.count).toBe(30);
  });

  it("Windows line endings give the same rows; the fingerprint differs, as it should", () => {
    const crlf = oct.replace(/\n/g, "\r\n");
    const a = ingestVolopayCsv(crlf, { source: "chat" }), b = ingestVolopayCsv(oct, { source: "chat" });
    if (!a.ok || !b.ok) throw new Error("expected both to parse");
    expect(a.rows).toEqual(b.rows);
    expect(fingerprint(crlf)).not.toBe(fingerprint(oct));
  });

  it("chat refuses big files and points to app upload; upload takes them", () => {
    const rows = Array.from({ length: 1001 }, (_, k) => `T${k},2026-10-01,M,1,INR,,,,,Yes,`).join("\n");
    const text = `${HEAD}\n${rows}\n`;
    expect(ingestVolopayCsv(text, { source: "chat" })).toMatchObject({ ok: false, fatal: expect.stringMatching(/Upload it in the app/) });
    expect(ingestVolopayCsv(text, { source: "upload" })).toMatchObject({ ok: true, stats: { count: 1001 } });
    const big = `${HEAD}\n${"x".repeat(301 * 1024)}\n`;
    expect(ingestVolopayCsv(big, { source: "chat" })).toMatchObject({ ok: false, fatal: expect.stringMatching(/300 KB/) });
  });
});

describe("ingest_csv tool", () => {
  it("replaces a draft month, supersedes the old file, and returns what Claude must show the user", async () => {
    const r = await t.ingestCsv(as("priya"), { client_id: S.client.acme.id, month: "2026-10", csv_text: oct });
    expect(r).toMatchObject({
      source: "chat", row_count: 30, total: 472957, currency: "INR", missing_receipts: 4, rejected: [],
      injection_suspected: ["VP-10026"], replaced_previous: true, sha256: fingerprint(oct),
      review_url: expect.stringMatching(/^http:\/\/app\.test\/reviews\//),
    });
    expect(r.review_id).toBe(S.review["acme:2026-10"]);
    const files = await db.select().from(sourceFiles).where(eq(sourceFiles.reviewId, r.review_id));
    expect(files.map((f) => [f.source, f.superseded]).sort()).toEqual([["chat", false], ["upload", true]]);
    expect(await db.select().from(transactions).where(eq(transactions.reviewId, r.review_id))).toHaveLength(30);
  });

  it("keeps a masked copy only: no card number in source_files or the audit log", async () => {
    const files = await db.select().from(sourceFiles);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f.maskedText).not.toMatch(/4111 1111|\d{4} \d{4} \d{4} \d{4}/);
      expect(f.maskedText).toMatch(/\*\*\*\* \d{4}/);
    }
    expect(JSON.stringify(await db.select().from(auditEvents))).not.toMatch(/4111/);
  });

  it("writes an ingest.completed audit event for both doors", async () => {
    const ev = await db.select().from(auditEvents).where(eq(auditEvents.action, "ingest.completed"));
    expect(ev.some((e) => e.actorType === "claude")).toBe(true);
    expect(ev.some((e) => e.actorType === "user")).toBe(true);
    expect(JSON.stringify(ev[0].payloadJson)).toMatch(/sha256/);
  });

  it("keeps valid rows and reports rejected lines; out-of-month rows are left out too", async () => {
    const text = [
      HEAD,
      "N1,2026-12-02,Alpha,100,INR,Misc,4111 1111 1111 1111,A,Ops,Yes,",
      "N2,not-a-date,Beta,50,INR,Misc,,A,Ops,Yes,",
      "N3,2026-12-03,Gamma,abc,INR,Misc,,A,Ops,Yes,",
      "N1,2026-12-04,Dup,10,INR,Misc,,A,Ops,Yes,",
      "N5,2026-11-30,Early,20,INR,Misc,,A,Ops,Yes,",
      "N6,2026-12-05,Delta,200,INR,Misc,,A,Ops,No,",
    ].join("\n");
    const r = await t.ingestCsv(as("priya"), { client_id: S.client.bluebird.id, month: "2026-12", csv_text: text });
    expect(r.row_count).toBe(2);
    expect(r.total).toBe(300);
    expect(r.replaced_previous).toBe(false);
    expect(r.rejected.map((x: { line: number }) => x.line)).toEqual([3, 4, 5, 6]);
    expect(r.rejected[0].error).toMatch(/bad date/);
    expect(r.rejected[3].error).toMatch(/outside 2026-12/);
    expect(r.next).toMatch(/stop unless they say to continue/);
  });

  it("imports nothing and says why when no line is valid", async () => {
    const text = `${HEAD}\nX1,bad,M,1,INR,,,,,Yes,\n`;
    await expect(t.ingestCsv(as("priya"), { client_id: S.client.bluebird.id, month: "2027-01", csv_text: text }))
      .rejects.toMatchObject({ code: "nothing_imported" });
    const [rv] = await db.select().from(reviews).where(and(eq(reviews.clientId, S.client.bluebird.id), eq(reviews.month, "2027-01")));
    expect(rv).toBeUndefined();
  });

  it("refuses to replace rows once the review has started", async () => {
    const start = await t.startReview(as("priya"), { client_id: S.client.acme.id, month: "2026-10" });
    expect(start.review_url).toBe(`http://app.test/reviews/${start.review_id}`);
    await expect(t.ingestCsv(as("priya"), { client_id: S.client.acme.id, month: "2026-10", csv_text: oct }))
      .rejects.toMatchObject({ code: "review_started", message: "Start a new review or ask a manager" });
    expect(await db.select().from(transactions).where(eq(transactions.reviewId, start.review_id))).toHaveLength(30);
  });

  it("start_review explains both ways in when nothing was ingested", async () => {
    await expect(t.startReview(as("priya"), { client_id: S.client.acme.id, month: "2027-05" }))
      .rejects.toThrow(/ingested \(chat\) or uploaded \(app\)/);
  });
});

describe("who may ingest", () => {
  it("an auditor, a bookkeeper on an unassigned client, and another firm are all refused", async () => {
    const csv = `${HEAD}\nZ1,2027-03-01,M,1,INR,,,,,Yes,\n`;
    const args = { client_id: S.client.acme.id, month: "2027-03", csv_text: csv };
    await expect(t.ingestCsv(as("asha"), args)).rejects.toMatchObject({ status: 403 });
    await expect(t.ingestCsv(as("ravi"), { ...args, client_id: S.client.bluebird.id })).rejects.toMatchObject({ status: 403 });
    await expect(t.ingestCsv(as("intruder"), args)).rejects.toMatchObject({ status: 403 });
    await expect(t.ingestCsv(as("ravi"), args)).resolves.toMatchObject({ row_count: 1 }); // assigned: allowed
  });
});
