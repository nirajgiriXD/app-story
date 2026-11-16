import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fixed locations, relative to the repository (not to the folder a command is run from).
 * They are deliberately not configurable: users always find their products and videos
 * in the same place.
 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const PRODUCTS_DIR = join(REPO_ROOT, "products");
export const OUTPUT_DIR = join(REPO_ROOT, "output");
export const ROOT_ENV_FILE = join(REPO_ROOT, ".env");
