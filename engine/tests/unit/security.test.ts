import { describe, expect, it } from "vitest";
import { ActionGuard, classifySensitive, isAllowedUrl, resolveUrl } from "@showrun/browser";
import { SafetyConfigSchema } from "@showrun/contracts";

const safety = SafetyConfigSchema.parse({});

describe("domain allow-list", () => {
  it("matches hosts, ports and wildcards", () => {
    expect(isAllowedUrl("https://demo.example.com/x", ["demo.example.com"])).toBe(true);
    expect(isAllowedUrl("https://evil.com/x", ["demo.example.com"])).toBe(false);
    expect(isAllowedUrl("https://demo.example.com.evil.com/", ["demo.example.com"])).toBe(false);
    expect(isAllowedUrl("https://a.b.example.com/", ["*.example.com"])).toBe(true);
    expect(isAllowedUrl("https://example.com/", ["*.example.com"])).toBe(true);
    expect(isAllowedUrl("https://notexample.com/", ["*.example.com"])).toBe(false);
    expect(isAllowedUrl("http://localhost:4310/p", ["localhost:4310"])).toBe(true);
    expect(isAllowedUrl("http://localhost:9999/p", ["localhost:4310"])).toBe(false);
  });

  it("rejects non-web schemes", () => {
    expect(isAllowedUrl("file:///etc/passwd", ["*"])).toBe(false);
    expect(isAllowedUrl("javascript:alert(1)", ["demo.example.com"])).toBe(false);
    expect(isAllowedUrl("about:blank", [])).toBe(true);
  });

  it("resolves paths against the base URL", () => {
    expect(resolveUrl("http://app.test/base", "/projects")).toBe("http://app.test/projects");
    expect(resolveUrl("http://app.test", "projects/new")).toBe("http://app.test/projects/new");
  });
});

describe("sensitive action guard", () => {
  it("classifies risky labels", () => {
    expect(classifySensitive("Delete workspace")).toBe("delete");
    expect(classifySensitive("Pay now")).toBe("payments");
    expect(classifySensitive("Send invoice")).toBe("emails");
    expect(classifySensitive("Publish post")).toBe("publishing");
    expect(classifySensitive("Invite member")).toBe("invite_users");
    expect(classifySensitive("Create project")).toBeNull();
    expect(classifySensitive("Playground")).toBeNull(); // no substring false positive on "pay"
  });

  it("blocks sensitive clicks by default and allows them when configured", () => {
    const guard = new ActionGuard(safety);
    const del = { role: "button", name: "Delete project", tag: "button" };
    expect(guard.check("click", del).allowed).toBe(false);
    const permissive = new ActionGuard(SafetyConfigSchema.parse({ allow: { delete: true } }));
    expect(permissive.check("click", del).allowed).toBe(true);
    expect(guard.check("click", { role: "button", name: "Create project", tag: "button" }).allowed).toBe(true);
  });

  it("does not block typing into a field just because of its label", () => {
    const guard = new ActionGuard(safety);
    expect(guard.check("fill", { role: "textbox", name: "Email", tag: "input" }).allowed).toBe(true);
  });

  it("honours extra blocked keywords", () => {
    const guard = new ActionGuard(SafetyConfigSchema.parse({ blocked_keywords: ["Restore"] }));
    expect(guard.check("click", { role: "button", name: "Restore backup", tag: "button" }).allowed).toBe(false);
  });

  it("read-only mode only allows navigation", () => {
    const guard = new ActionGuard(safety, "read_only");
    expect(guard.check("click", { role: "link", name: "Projects", tag: "a" }).allowed).toBe(true);
    expect(guard.check("click", { role: "tab", name: "Overview", tag: "button", type: "button" }).allowed).toBe(true);
    expect(guard.check("click", { role: "button", name: "Save", tag: "button", type: "submit" }).allowed).toBe(false);
    expect(guard.check("fill", { role: "textbox", name: "Search", tag: "input" }).allowed).toBe(false);
    expect(guard.check("press", undefined, "Escape").allowed).toBe(true);
    expect(guard.check("press", undefined, "Enter").allowed).toBe(false);
  });

  it("production environments are read-only unless production data is allowed", () => {
    const prod = new ActionGuard(SafetyConfigSchema.parse({ environment: "production" }));
    expect(prod.readOnly).toBe(true);
    const allowed = new ActionGuard(SafetyConfigSchema.parse({ environment: "production", allow: { production_data: true } }));
    expect(allowed.readOnly).toBe(false);
  });
});
