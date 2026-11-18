// Builds the npm package `app-story` into dist/app-story/, ready for `npm pack` or `npm publish`.
//
//   npm run build
//   npm publish ./dist/app-story
//
// The engine's own packages are bundled into one file; everything from npm stays a
// normal dependency. The render page and the AI prompts are shipped next to it, so the
// package needs neither TypeScript nor a bundler at run time.
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { bundleRenderPage } from "@app-story/video";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "app-story");
const dist = join(out, "dist");

/** Only needed to build: the render page is bundled ahead of time. */
const BUILD_ONLY = new Set(["tsx", "esbuild", "react", "react-dom"]);

/** Bundle the engine's own packages; leave everything from npm to be installed. */
const npmPackagesStayExternal: Plugin = {
  name: "npm-packages-stay-external",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) =>
      isAbsolute(args.path) || args.path.startsWith("@app-story/") ? undefined : { path: args.path, external: true },
    );
  },
};

await rm(out, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [join(root, "cli", "src", "index.ts")],
  outfile: join(dist, "cli.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  plugins: [npmPackagesStayExternal],
  logLevel: "warning",
});
await writeFile(join(dist, "render-page.js"), await bundleRenderPage());
await cp(join(root, "packages", "ai", "src", "prompts"), join(dist, "prompts"), { recursive: true, filter: (f) => !f.endsWith(".ts") });
// The recorded sound effects (clicks, key presses).
await cp(join(root, "packages", "video", "assets", "sfx"), join(dist, "sfx"), { recursive: true });
// The Chatterbox voice's Python helper.
await cp(join(root, "packages", "narration", "python"), join(dist, "python"), { recursive: true });

// The package's dependencies: what the engine's packages use from npm.
const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const cli = await readJson(join(root, "cli", "package.json"));
const manifests = [cli, ...(await Promise.all((await readdir(join(root, "packages"))).map((p) => readJson(join(root, "packages", p, "package.json")))))];
const dependencies: Record<string, string> = {};
for (const manifest of manifests) {
  for (const [name, range] of Object.entries<string>(manifest.dependencies ?? {})) {
    if (name.startsWith("@app-story/") || BUILD_ONLY.has(name)) continue;
    if (dependencies[name] && dependencies[name] !== range) throw new Error(`${name} is required as ${dependencies[name]} and as ${range}; use one range.`);
    dependencies[name] = range;
  }
}
const bundled = await readFile(join(dist, "cli.mjs"), "utf8");
for (const name of BUILD_ONLY) {
  if (new RegExp(`from ["']${name}["']|import\\(["']${name}["']\\)`).test(bundled) && name !== "esbuild") {
    throw new Error(`The bundle imports ${name} at run time; it would be missing from the package.`);
  }
}

const rootManifest = await readJson(join(root, "package.json"));
const manifest = {
  name: "app-story",
  version: cli.version,
  description: "Make product demo videos of your web app with AI: it plans the clicks, records a real browser, narrates and renders an MP4.",
  keywords: ["demo", "video", "playwright", "ai", "screen-recording", "product-demo"],
  license: rootManifest.license,
  repository: { type: "git", url: "git+https://github.com/nirajgiriXD/app-story.git" },
  homepage: "https://github.com/nirajgiriXD/app-story#readme",
  bugs: "https://github.com/nirajgiriXD/app-story/issues",
  type: "module",
  bin: { "app-story": "dist/cli.mjs" },
  files: ["dist"],
  engines: rootManifest.engines,
  dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))),
};
await writeFile(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await copyFile(join(root, "README.md"), join(out, "README.md"));
await copyFile(join(root, "LICENSE"), join(out, "LICENSE"));
console.log(`Built ${manifest.name}@${manifest.version} in ${out}`);
