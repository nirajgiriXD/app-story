/*
 * Words and addresses the video shows. Pure: used by the Node side and the render page.
 */

/** The end card's call to action when the product file sets none; `{host}` is the website's address. */
export const DEFAULT_CTA = "Try it at {host}";

/**
 * The address the video's browser bar shows for `url`. The demo runs on a staging or local
 * copy of the app; with a public `website`, its pages are shown under that address instead,
 * so the video never advertises `staging.acme.com` or `localhost:3000`.
 */
export function shownUrl(url: string, appUrl: string, website?: string): string {
  if (!website) return url;
  try {
    const page = new URL(url);
    if (page.origin !== new URL(appUrl).origin) return url;
    const site = new URL(website);
    return `${site.origin}${page.pathname}${page.search}${page.hash}`;
  } catch {
    return url;
  }
}
