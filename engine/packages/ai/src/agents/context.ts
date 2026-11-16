export interface ProductContext {
  name: string;
  description: string;
  baseUrl: string;
  instructions?: string;
  knowledge: { file: string; content: string }[];
}

const MAX_KNOWLEDGE_CHARS = 40_000;

/** Product facts for prompts. This is operator-provided (trusted) content, unlike page snapshots. */
export function formatProductContext(product: ProductContext): string {
  let budget = MAX_KNOWLEDGE_CHARS;
  const docs = product.knowledge
    .map((doc) => {
      const text = doc.content.slice(0, Math.max(0, budget));
      budget -= text.length;
      return text ? `## ${doc.file}\n${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
  return [
    `# Product\nName: ${product.name}\nDescription: ${product.description}\nBase URL: ${product.baseUrl}`,
    product.instructions ? `# Product instructions\n${product.instructions.trim()}` : "",
    docs ? `# Product knowledge\n${docs}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
