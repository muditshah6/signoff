import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";

afterEach(() => vi.unstubAllEnvs());

describe("database guard", () => {
  // Only meaningful with the embedded DB; against a real DATABASE_URL the guard is not reachable.
  it.skipIf(Boolean(process.env.DATABASE_URL))("production without DATABASE_URL fails loudly instead of using an ephemeral disk, and the failure is not cached", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("ALLOW_EPHEMERAL_DB", "");
    await expect(getDb()).rejects.toThrow(/DATABASE_URL is not set/);
    // fix the config; the same process must recover rather than stay poisoned
    vi.stubEnv("ALLOW_EPHEMERAL_DB", "1");
    vi.stubEnv("PGLITE_DIR", "memory://");
    await expect(getDb()).resolves.toBeTruthy();
  });
});
