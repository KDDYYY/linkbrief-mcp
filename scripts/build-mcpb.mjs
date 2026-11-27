// Builds dist/linkbrief.mcpb (Claude Desktop one-click extension): copies the published files,
// installs production dependencies into the bundle, then packs it with the official mcpb CLI.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
if (manifest.version !== pkg.version) throw new Error(`manifest.json version ${manifest.version} != package.json ${pkg.version}`);

const dist = path.join(root, "dist");
const stage = path.join(dist, "mcpb");
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const f of [...pkg.files, "package.json", "package-lock.json", "manifest.json", "LICENSE", "README.md"]) {
  fs.copyFileSync(path.join(root, f), path.join(stage, f));
}
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: "inherit", shell: true });
run("npm ci --omit=dev --no-audit --no-fund", stage);
const out = path.join(dist, "linkbrief.mcpb");
run(`npx -y @anthropic-ai/mcpb pack "${stage}" "${out}"`, root);
console.log(`Built ${path.relative(root, out)} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
