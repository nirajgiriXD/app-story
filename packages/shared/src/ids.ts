import { randomBytes } from "node:crypto";

export function slugify(input: string, maxLength = 48): string {
  const slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (slug || "demo").slice(0, maxLength).replace(/-+$/g, "");
}

/** Sortable, unique job id, e.g. `20261115-191800-a1b2c3`. */
export function createJobId(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}
