import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileExists, isDemoForgeError } from "@demoforge/shared";
import { readProductConfig } from "./loader";

export interface ProductListing {
  id: string;
  name?: string;
  base_url?: string;
  ai_provider?: string;
  valid: boolean;
  error?: string;
}

export async function listProducts(productsDir: string): Promise<ProductListing[]> {
  if (!(await fileExists(productsDir))) return [];
  const entries = await readdir(productsDir, { withFileTypes: true });
  const listings: ProductListing[] = [];
  for (const entry of entries) {
    // Folders starting with `_` or `.` are not products (drafts, tooling, hidden files).
    if (!entry.isDirectory() || /^[_.]/.test(entry.name)) continue;
    const file = join(productsDir, entry.name, "product.yaml");
    if (!(await fileExists(file))) continue;
    try {
      const config = await readProductConfig(file);
      listings.push({
        id: entry.name,
        name: config.product.name,
        base_url: config.product.base_url,
        ai_provider: config.providers.ai.provider,
        valid: true,
      });
    } catch (error) {
      listings.push({ id: entry.name, valid: false, error: isDemoForgeError(error) ? error.message : String(error) });
    }
  }
  return listings.sort((a, b) => a.id.localeCompare(b.id));
}
