// Bundles the agent into a single ESM file (dist/orbit-agent.mjs) that the hub serves for install + self-update.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const version = process.env.ORBIT_AGENT_VERSION ?? `${pkg.version}+${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12)}`;

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/orbit-agent.mjs",
  define: { __AGENT_VERSION__: JSON.stringify(version) },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  external: ["node:*"],
  logLevel: "info",
});

const sha256 = createHash("sha256").update(readFileSync("dist/orbit-agent.mjs")).digest("hex");
writeFileSync("dist/version.json", JSON.stringify({ version, sha256 }, null, 2));
console.log(`orbit-agent ${version} ${sha256}`);
