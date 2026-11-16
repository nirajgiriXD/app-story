#!/usr/bin/env node
// Starts Vitest from the real-cased path. Some Windows shells (e.g. Git Bash) report the
// drive letter in lowercase ("c:\..."), while npm's workspace links resolve to "C:\...".
// Vitest then loads itself twice under two paths and every test file fails to start.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const cwd = realpathSync.native(process.cwd());
const require = createRequire(`${cwd}/package.json`);
const bin = join(dirname(realpathSync.native(require.resolve("vitest/package.json"))), "vitest.mjs");
const result = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], { cwd, stdio: "inherit" });
process.exit(result.status ?? 1);
