import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / non-bundleable server-side packages. Next must not try to bundle these
  // through Webpack/Turbopack: better-sqlite3 loads a .node binary via `bindings`,
  // and the Prisma client/adapter rely on dynamic requires.
  serverExternalPackages: [
    "@prisma/client",
    "@prisma/adapter-better-sqlite3",
    "@prisma/driver-adapter-utils",
    "better-sqlite3",
  ],

  // In dev mode Next 16 blocks cross-origin requests to /_next/* assets unless the
  // origin is whitelisted. Without this, hitting the dev server from a non-localhost
  // host (LAN IP, phone, etc.) renders HTML fine but never loads client JS chunks,
  // so onClick handlers never attach. Only applies to `next dev`.
  allowedDevOrigins: ["192.168.0.215", "192.168.*.*", "*.local"],
};

export default nextConfig;
