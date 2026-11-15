import type { ProductAdapter } from "@demoforge/products";

/**
 * Optional product adapter. This one resets Projectly's synthetic data before every
 * browser session, so the rehearsal and the recorded take start from the same state.
 * (Type-only import: the file loads from any folder without installing anything.)
 */
export default {
  async setup({ baseUrl, log }) {
    const res = await fetch(new URL("/api/reset", baseUrl), { method: "POST" }).catch(() => undefined);
    if (!res?.ok) log.warn("could not reset Projectly demo data (is the example app running?)");
  },
} satisfies ProductAdapter;
