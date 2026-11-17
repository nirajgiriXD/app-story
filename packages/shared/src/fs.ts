import { mkdir, readFile, writeFile, access, stat } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function writeText(path: string, text: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, text, "utf8");
}

export async function readJson<T = unknown>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function readJsonIfExists<T = unknown>(path: string): Promise<T | undefined> {
  if (!(await fileExists(path))) return undefined;
  return readJson<T>(path);
}

/** Convert an absolute path to a forward-slash path relative to `base` (for reports and the renderer). */
export function toPosixRelative(base: string, target: string): string {
  const b = base.replace(/\\/g, "/").replace(/\/$/, "");
  const t = target.replace(/\\/g, "/");
  return t.startsWith(`${b}/`) ? t.slice(b.length + 1) : t;
}
