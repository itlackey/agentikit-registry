#!/usr/bin/env bun

import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dir, "..");
const akmBin = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "akm.cmd" : "akm");

const result = spawnSync(akmBin, ["registry", "build-index", ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: "inherit",
});

if (result.error && "code" in result.error && result.error.code === "ENOENT") {
  console.error("akm-cli is not installed. Run `bun run install:akm` first.");
  process.exit(1);
}

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
