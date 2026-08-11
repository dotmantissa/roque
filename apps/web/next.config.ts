import type { NextConfig } from "next";
import path from "node:path";

/**
 * Roque's web app leans on two workspace packages that ship TypeScript source
 * rather than built output, so Next has to transpile them alongside the app.
 * That is deliberate: one implementation of the backend logic, imported the same
 * way whether it runs in a serverless route here or the standalone relayer.
 */
const nextConfig: NextConfig = {
  transpilePackages: ["@roque/core", "@roque/shared"],
  // We live two levels down from the workspace root. Point Next at that root so
  // it traces files against the real monorepo instead of guessing from whichever
  // lockfile it stumbles on first, which keeps the workspace packages in the
  // serverless bundle when this deploys.
  outputFileTracingRoot: path.join(__dirname, "../../"),
  reactStrictMode: true,
  eslint: {
    // The monorepo lints as a whole; the Next build should not second-guess it.
    ignoreDuringBuilds: true,
  },
  webpack: (config) => {
    // @roque/core is written in NodeNext style, so its relative imports carry a
    // `.js` suffix that points at a `.ts` file on disk. Node and tsx resolve that
    // mapping natively; webpack needs to be told, or it looks for a real `.js`
    // that never shipped. This alias lets the same source compile in both worlds.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js", ".jsx"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    return config;
  },
};

export default nextConfig;
