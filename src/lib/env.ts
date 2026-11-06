/**
 * Deployment guards. Production fails closed: a missing secret or database is an error, never a quiet default.
 * DEMO_MODE=1 is the explicit switch for a public demo with synthetic data (open sign-in, OTP shown on screen).
 */
export const isProd = () => process.env.NODE_ENV === "production";
export const isDemo = () => process.env.DEMO_MODE === "1";

/** Dev/test may run unauthenticated-looking; a deployment may not. */
export const demoLoginEnabled = () => !isProd() || isDemo();

/** The key that signs sessions, share-link tokens and OTP sessions. */
export function secret(): string {
  const s = process.env.SIGNOFF_SECRET;
  if (s && s.length >= 32) return s;
  if (isProd()) {
    throw new Error("SIGNOFF_SECRET is missing or shorter than 32 characters. Generate one with: openssl rand -base64 48");
  }
  return s || "dev-only-secret-change-me-dev-only-secret";
}

/** Cookies are Secure in production so they never travel over plain HTTP. */
export const cookieSecure = () => isProd();
