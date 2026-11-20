// Installs the `app-story` command on this computer from this repository, with nothing
// downloaded from npm under AppStory's name: builds the package, installs it globally,
// then the Chromium that its own Playwright drives.
//
//   npm ci && npm run install:cli
//
// Run it again after `git pull` to update.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// The npm that started this script (`npm run` sets npm_execpath), run with this Node: no
// shell, which Windows would otherwise need for npm.cmd.
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this with npm: npm run install:cli");
const npm = (args: string[], cwd = root) => execFileSync(process.execPath, [npmCli, ...args], { cwd, stdio: ["inherit", "pipe", "inherit"], encoding: "utf8" });
const npmLoud = (args: string[], cwd = root) => execFileSync(process.execPath, [npmCli, ...args], { cwd, stdio: "inherit" });

npmLoud(["run", "build"]);
// --install-links copies the package in and installs its dependencies; without it, npm
// only links the folder and the command fails on its first import. Install scripts are not
// needed: the voice model's native parts ship prebuilt (the Dockerfile does the same).
npmLoud(["install", "--global", "--install-links", "--ignore-scripts", "./dist/app-story"]);
const globalRoot = npm(["root", "--global"]).trim();
npmLoud(["exec", "--", "playwright", "install", "chromium"], join(globalRoot, "app-story"));
console.log("\nInstalled. Run `app-story --help` from any project folder.");
