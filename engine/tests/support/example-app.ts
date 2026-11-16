import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

/** Start the example Projectly app on a free-ish port for a test file. */
export async function startExampleApp(port: number): Promise<{ url: string; stop: () => void }> {
  const child: ChildProcess = spawn(process.execPath, [resolve("engine/data/example-app/server.mjs")], {
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  const url = `http://localhost:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return { url, stop: () => child.kill() };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill();
  throw new Error("example app did not start");
}
