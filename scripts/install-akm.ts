#!/usr/bin/env bun

import path from "node:path";
import { spawnSync } from "node:child_process";

const AKM_CLI_VERSION = "0.0.22";
const repoRoot = path.resolve(import.meta.dir, "..");

const result = spawnSync("bun", ["add", "--dev", "--exact", "--no-save", `akm-cli@${AKM_CLI_VERSION}`], {
  cwd: repoRoot,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
