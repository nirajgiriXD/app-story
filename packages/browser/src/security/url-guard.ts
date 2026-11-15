/**
 * Domain allow-list. Entries are hostnames with an optional port (`demo.example.com`,
 * `localhost:4310`) or a wildcard for subdomains (`*.example.com`).
 */
export function isAllowedUrl(url: string, allowedDomains: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "about:" || parsed.protocol === "data:" || parsed.protocol === "blob:") return true;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  const host = parsed.hostname.toLowerCase();
  const hostWithPort = parsed.port ? `${host}:${parsed.port}` : host;
  return allowedDomains.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(2);
      return host === suffix || host.endsWith(`.${suffix}`);
    }
    return entry.includes(":") ? entry === hostWithPort : entry === host;
  });
}

/** Resolve a workflow `url` (path or absolute) against the product base URL. */
export function resolveUrl(baseUrl: string, pathOrUrl: string): string {
  return new URL(pathOrUrl, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}
