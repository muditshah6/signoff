import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { auditEvents, firms } from "@/db/schema";
import { appendAudit, verifyChain } from "@/lib/audit";
import { cookieSecure, demoLoginEnabled, secret } from "@/lib/env";
import { sendEmail } from "@/lib/mail";
import { resetDatabase, seed } from "@/lib/seed";
import { resolveToken } from "@/lib/tokens";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("production fails closed", () => {
  it("refuses to run without a real signing secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SIGNOFF_SECRET", "");
    expect(() => secret()).toThrow(/SIGNOFF_SECRET/);
    vi.stubEnv("SIGNOFF_SECRET", "too-short");
    expect(() => secret()).toThrow(/32 characters/);
    vi.stubEnv("SIGNOFF_SECRET", "x".repeat(48));
    expect(secret()).toBe("x".repeat(48));
  });

  it("dev falls back to a local secret, but never the old public default", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SIGNOFF_SECRET", "");
    expect(secret().length).toBeGreaterThanOrEqual(32);
  });

  it("open sign-in exists in dev, and in production only with DEMO_MODE=1", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(demoLoginEnabled()).toBe(true);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEMO_MODE", "");
    expect(demoLoginEnabled()).toBe(false);
    vi.stubEnv("DEMO_MODE", "1");
    expect(demoLoginEnabled()).toBe(true);
  });

  it("cookies are Secure in production only", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(cookieSecure()).toBe(true);
    vi.stubEnv("NODE_ENV", "development");
    expect(cookieSecure()).toBe(false);
  });
});

describe("remote seed and reset", () => {
  let db: Db;
  beforeAll(async () => { db = await getDb(); });

  it("random tokens: the repo's well-known dev tokens are never live", async () => {
    const s = await seed(db, { devTokens: false });
    expect(Object.keys(s.token).sort()).toEqual(["intruder", "meera", "priya", "ravi"]);
    for (const dev of ["dev-priya-7c1f0e2a", "dev-meera-3b9d41c7", "dev-ravi-5e02aa19", "dev-otherfirm-91ab33d0"]) {
      expect(await resolveToken(db, dev)).toBeNull();
    }
    expect(s.token.priya).toMatch(/^sgn_[A-Za-z0-9_-]{30,}$/);
    expect(await resolveToken(db, s.token.priya)).toMatchObject({ role: "owner" });
  });

  it("reset wipes everything and the seed works again from empty", async () => {
    await resetDatabase(db);
    expect(await db.select().from(firms)).toHaveLength(0);
    expect(await db.select().from(auditEvents)).toHaveLength(0);
    const s = await seed(db, { devTokens: true });
    expect(await resolveToken(db, "dev-priya-7c1f0e2a")).toMatchObject({ userId: s.user.priya.id });
  });
});

describe("audit chain under concurrency", () => {
  // NOTE: PGlite is a single connection, so this passes with or without the advisory lock (checked by removing it).
  // It proves the chain stays gapless and verifiable; it cannot prove the lock. On real Postgres the lock plus the
  // unique(firm_id, seq) constraint guard it: a collision would fail one request loudly, never fork the chain.
  it("25 simultaneous writers produce one gapless, verifiable chain", async () => {
    const db = await getDb();
    const [firm] = await db.insert(firms).values({ name: "Concurrent LLP" }).returning();
    await Promise.all(Array.from({ length: 25 }, (_, i) => appendAudit(db, {
      firmId: firm.id, actor: { type: "system" }, action: "test.write", payload: { i },
    })));
    const rows = await db.select().from(auditEvents).where(eq(auditEvents.firmId, firm.id));
    expect(rows.map((r) => r.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(await verifyChain(db, firm.id)).toEqual({ ok: true, count: 25 });
  });
});

describe("OTP email delivery", () => {
  it("says not sent when no provider is configured, so the app never claims it emailed", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("MAIL_FROM", "");
    expect(await sendEmail({ to: "a@b.test", subject: "s", text: "t" })).toMatchObject({ sent: false });
  });

  it("posts to the provider with a bearer key and reports success", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("MAIL_FROM", "Signoff <no@reply.test>");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendEmail({ to: "arjun@acme.test", subject: "code", text: "Your code is 123456" })).toEqual({ sent: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_test_key");
    expect(JSON.parse(init.body as string)).toMatchObject({ to: ["arjun@acme.test"], from: "Signoff <no@reply.test>" });
  });

  it("reports failure without leaking the key when the provider errors or is unreachable", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_secret_key");
    vi.stubEnv("MAIL_FROM", "x@y.test");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 422 })));
    const bad = await sendEmail({ to: "a@b.test", subject: "s", text: "t" });
    expect(bad).toMatchObject({ sent: false, reason: "mail provider returned 422" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("getaddrinfo ENOTFOUND"); }));
    const down = await sendEmail({ to: "a@b.test", subject: "s", text: "t" });
    expect(down.sent).toBe(false);
    expect(JSON.stringify([bad, down])).not.toContain("re_secret_key");
  });
});
