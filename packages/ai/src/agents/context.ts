export interface ProductContext {
  name: string;
  description: string;
  baseUrl: string;
  /** The public website viewers are sent to, when it differs from the app the demo runs on. */
  website?: string;
  /** The product file's text (below its settings block): description, tips, release notes. */
  brief?: string;
}

const MAX_BRIEF_CHARS = 40_000;

/** Product facts for prompts. This is operator-provided (trusted) content, unlike page snapshots. */
export function formatProductContext(product: ProductContext): string {
  const brief = product.brief?.trim().slice(0, MAX_BRIEF_CHARS);
  return [
    `# Product\nName: ${product.name}\nDescription: ${product.description}\nBase URL: ${product.baseUrl}${
      product.website ? `\nPublic website (the address to give viewers; the demo itself runs at the base URL): ${product.website}` : ""
    }`,
    brief ? `# Product file (from the team that owns the product)\n${brief}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
