#!/usr/bin/env node
// Starts Vitest from the repository root, using engine/vitest.config.ts.
//
// It also fixes the drive-letter case: some Windows shells (e.g. Git Bash) report
// "c:\...", while npm's workspace links resolve to "C:\...". Vitest would then load
// itself twice under two paths and every test file would fail to start.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync.native(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const require = createRequire(join(root, "package.json"));
const bin = join(dirname(realpathSync.native(require.resolve("vitest/package.json"))), "vitest.mjs");
const args = [bin, ...process.argv.slice(2), "--config", join(root, "engine", "vitest.config.ts")];
const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
