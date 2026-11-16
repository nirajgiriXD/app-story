import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { storeFor } from "@app-story/core";
import { findWorkspaceRoot, workspaceAt } from "@app-story/shared";
import { buildProgram } from "../../cli/src/program";

describe("the user's project folder", () => {
  it("is the nearest folder upwards with products/ or .app-story/", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-ws-"));
    const deep = join(root, "app", "src", "deep");
    await mkdir(deep, { recursive: true });
    expect(findWorkspaceRoot(deep)).toBe(deep); // nothing yet: where it runs

    await mkdir(join(root, "app", "products"));
    expect(findWorkspaceRoot(deep)).toBe(join(root, "app"));
    await mkdir(join(root, "app", "src", ".app-story"));
    expect(findWorkspaceRoot(deep)).toBe(join(root, "app", "src"));
    expect(findWorkspaceRoot(deep, join(root, "elsewhere"))).toBe(join(root, "elsewhere")); // APP_STORY_HOME wins
  });

  it("keeps AppStory's records in .app-story/, out of git, and brings over an older database", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-ws-"));
    const ws = workspaceAt(root);
    await mkdir(join(root, "engine", "data"), { recursive: true });
    await writeFile(join(root, "engine", "data", "app-story.db"), "");

    const store = storeFor(ws.outputDir);
    expect(store.file).toBe(join(ws.dataDir, "app-story.db"));
    expect(existsSync(join(root, "engine", "data", "app-story.db"))).toBe(false);
    expect(await readFile(join(ws.dataDir, ".gitignore"), "utf8")).toMatch(/^\*$/m);
  });
});

it("the command reports the package's version", () => {
  const { version } = JSON.parse(readFileSync("engine/cli/package.json", "utf8")) as { version: string };
  expect(buildProgram().version()).toBe(version);
});
