/**
 * A function to run inside the browser page (`page.evaluate`, `locator.evaluate`).
 *
 * Playwright sends a function's source text to the page. When AppStory runs from source
 * (tsx), every inner function in that text is wrapped in `__name(...)`, a helper that exists
 * in Node but not in the page, so the call fails there. This gives the page a stand-in.
 * The function itself is unchanged: same arguments, same result.
 */
export function inPage<F extends (...args: never[]) => unknown>(fn: F): F {
  return new Function(`return (...args) => { var __name = (f) => f; return (${fn.toString()})(...args); }`)() as F;
}
