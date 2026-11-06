import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pages read the session cookie on every request, so they are dynamic by design.
  cacheComponents: false,
  // Keep DB drivers and the dev-only schema pusher out of the bundle.
  serverExternalPackages: ["drizzle-kit", "@electric-sql/pglite", "postgres", "pg"],
  // Embedded-DB and schema-tooling packages are dev-only. Keep them out of the serverless bundle.
  outputFileTracingExcludes: {
    "/*": ["node_modules/drizzle-kit/**", "node_modules/@esbuild/**", "node_modules/esbuild/**", "node_modules/@electric-sql/**", "node_modules/playwright-core/**", "node_modules/vitest/**"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
