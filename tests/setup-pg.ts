import { beforeAll } from "vitest";

// When the suite runs against a real database (DATABASE_URL set), every test file starts from empty tables.
// Locally (embedded in-memory DB) each file already gets a fresh database, so this does nothing.
beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  const { getDb } = await import("@/db/client");
  const { resetDatabase } = await import("@/lib/seed");
  await resetDatabase(await getDb());
});
