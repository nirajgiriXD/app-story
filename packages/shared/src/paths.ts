import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The user's project folder (the "workspace"): where `products/`, `output/`, `.env` and
 * `.app-story/` live. AppStory's own files never hold user data, so it can be updated,
 * reinstalled or run from npm or Docker without losing anything.
 *
 * It is `APP_STORY_HOME` when set; otherwise the nearest folder, from the current one
 * upwards, that has a `products/` or `.app-story/` folder; otherwise the current folder.
 */
export interface Workspace {
  root: string;
  productsDir: string;
  outputDir: string;
  envFile: string;
  /** AppStory's records: the SQLite database, kept recordings and scratch folders. */
  dataDir: string;
}

/** The name of the data folder inside a workspace. It ignores itself in git. */
export const DATA_FOLDER = ".app-story";

let found: Workspace | undefined;

export function workspace(): Workspace {
  found ??= workspaceAt(findWorkspaceRoot(process.cwd(), process.env.APP_STORY_HOME));
  return found;
}

export function workspaceAt(root: string): Workspace {
  return {
    root,
    productsDir: join(root, "products"),
    outputDir: join(root, "output"),
    envFile: join(root, ".env"),
    dataDir: join(root, DATA_FOLDER),
  };
}

export function findWorkspaceRoot(start: string, home?: string): string {
  if (home) return resolve(home);
  const first = resolve(start);
  for (let dir = first; ; dir = dirname(dir)) {
    if (isDir(join(dir, "products")) || isDir(join(dir, DATA_FOLDER))) return dir;
    if (dirname(dir) === dir) return first;
  }
}

/**
 * The data folder that belongs to an output folder: `<parent>/.app-story`. For the
 * workspace's `output/` that is its data folder; tests use temporary folders laid out the same way.
 */
export function dataDirFor(outputDir: string): string {
  return join(dirname(outputDir), DATA_FOLDER);
}

function isDir(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}
