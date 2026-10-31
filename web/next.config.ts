import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Monorepo root, so the standalone output lands at .next/standalone/web/server.js.
  outputFileTracingRoot: path.join(__dirname, ".."),
  transpilePackages: ["@orbit/shared"],
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
