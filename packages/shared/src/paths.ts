import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The user's project folder (the "workspace"): where `apps/`, `output/`, `.env` and
 * `.app-story/` live. AppStory's own files never hold user data, so it can be updated,
 * reinstalled or run from Docker without losing anything.
 *
 * It is `APP_STORY_HOME` when set; otherwise the nearest folder, from the current one
 * upwards, that has an `apps/` (or older `products/`) or `.app-story/` folder; otherwise
 * the current folder.
 */
export interface Workspace {
  root: string;
  /** The product files: `apps/`, or `products/` in a project made before the rename. */
  appsDir: string;
  outputDir: string;
  envFile: string;
  /** AppStory's records: the SQLite database, kept recordings and scratch folders. */
  dataDir: string;
}

/** The name of the data folder inside a workspace. It ignores itself in git. */
export const DATA_FOLDER = ".app-story";

/** The folder of product files. */
export const APPS_FOLDER = "apps";

/** What the folder was called before; a project that still has only this one keeps working. */
const LEGACY_APPS_FOLDER = "products";

let found: Workspace | undefined;

export function workspace(): Workspace {
  found ??= workspaceAt(findWorkspaceRoot(process.cwd(), process.env.APP_STORY_HOME));
  return found;
}

export function workspaceAt(root: string): Workspace {
  return {
    root,
    appsDir: appsDirAt(root),
    outputDir: join(root, "output"),
    envFile: join(root, ".env"),
    dataDir: join(root, DATA_FOLDER),
  };
}

/** `apps/`, unless only the older `products/` exists. */
export function appsDirAt(root: string): string {
  const apps = join(root, APPS_FOLDER);
  const legacy = join(root, LEGACY_APPS_FOLDER);
  return !isDir(apps) && isDir(legacy) ? legacy : apps;
}

export function findWorkspaceRoot(start: string, home?: string): string {
  if (home) return resolve(home);
  const first = resolve(start);
  for (let dir = first; ; dir = dirname(dir)) {
    if ([APPS_FOLDER, LEGACY_APPS_FOLDER, DATA_FOLDER].some((name) => isDir(join(dir, name)))) return dir;
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
