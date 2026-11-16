// Projectly — a tiny, dependency-free web app with synthetic data, used to test AppStory.
// Run: npm run example-app  (or node engine/data/example-app/server.mjs)   (PORT defaults to 4310)
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const PORT = Number(process.env.PORT ?? 4310);
const USER = process.env.EXAMPLE_APP_USER ?? "demo@example.com";
const PASSWORD = process.env.EXAMPLE_APP_PASSWORD ?? "demo1234";
const TEAM = ["Ava Chen", "Marcus Lee", "Priya Patel", "Diego Alvarez"];

const seed = () => [
  { id: 1, name: "Website Redesign", description: "Refresh the marketing site.", status: "In progress", owner: "Ava Chen", created: "2026-10-02" },
  { id: 2, name: "Mobile App Beta", description: "Ship the beta to 50 testers.", status: "Planning", owner: "Marcus Lee", created: "2026-10-14" },
  { id: 3, name: "Customer Onboarding", description: "New onboarding emails and checklist.", status: "On hold", owner: "Priya Patel", created: "2026-10-21" },
];
let projects = seed();
let nextId = 4;
const sessions = new Set();

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const CSS = `
*{box-sizing:border-box}body{margin:0;font-family:Inter,"Segoe UI",Roboto,system-ui,sans-serif;color:#0f172a;background:#f8fafc}
a{color:inherit;text-decoration:none}.app{display:flex;min-height:100vh}
.side{width:248px;background:#0f172a;color:#cbd5e1;padding:24px 16px;display:flex;flex-direction:column;gap:4px}
.brand{display:flex;align-items:center;gap:10px;color:#fff;font-weight:700;font-size:20px;padding:4px 12px 24px}
.logo{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#6366f1,#4f46e5)}
.nav a{display:block;padding:10px 12px;border-radius:8px;font-weight:500}.nav a:hover{background:#1e293b;color:#fff}
.nav a.active{background:#1e293b;color:#fff}
main{flex:1;padding:36px 48px;max-width:1280px}
.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px}
h1{font-size:28px;margin:0;letter-spacing:-.01em}.sub{color:#64748b;margin-top:6px}
.btn{display:inline-flex;align-items:center;gap:8px;background:#4f46e5;color:#fff;border:0;border-radius:10px;padding:11px 18px;font-weight:600;font-size:15px;cursor:pointer;font-family:inherit}
.btn:hover{background:#4338ca}.btn.ghost{background:#fff;color:#334155;border:1px solid #e2e8f0}.btn.danger{background:#dc2626}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 1px 2px rgba(15,23,42,.04)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:16px 20px;border-bottom:1px solid #f1f5f9;font-size:15px}
th{color:#64748b;font-weight:600;font-size:13px;text-transform:uppercase;letter-spacing:.04em}
tr.new td{background:#eef2ff}td a{font-weight:600}td a:hover{color:#4f46e5}
.badge{display:inline-block;padding:4px 10px;border-radius:999px;font-size:13px;font-weight:600}
.b-Planning{background:#e0f2fe;color:#0369a1}.b-In.progress,.b-In{background:#dcfce7;color:#15803d}.b-On{background:#fef3c7;color:#b45309}
.toast{display:flex;align-items:center;gap:10px;background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46;padding:14px 18px;border-radius:12px;margin-bottom:20px;font-weight:500}
form.card{padding:28px;max-width:720px}label{display:block;font-weight:600;font-size:14px;margin:0 0 8px}
.field{margin-bottom:20px}input,textarea,select{width:100%;padding:11px 14px;border:1px solid #cbd5e1;border-radius:10px;font-size:15px;font-family:inherit;background:#fff}
input:focus,textarea:focus,select:focus{outline:2px solid #c7d2fe;border-color:#6366f1}textarea{min-height:96px}
.row{display:flex;gap:16px}.row .field{flex:1}.actions{display:flex;gap:12px;margin-top:8px}
.error{color:#b91c1c;font-size:14px;margin-top:6px}
.login{min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 20% 20%,#e0e7ff,transparent 50%),#f8fafc}
.login form{width:420px}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px}
.stat{padding:18px 20px}.stat b{display:block;font-size:26px;margin-top:4px}.stat span{color:#64748b;font-size:14px}
dl{display:grid;grid-template-columns:160px 1fr;gap:12px 24px;padding:28px;margin:0}dt{color:#64748b}dd{margin:0;font-weight:500}
`;

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · Projectly</title><style>${CSS}</style></head><body>${body}</body></html>`;

const shell = (active, content) =>
  page(
    active,
    `<div class="app"><aside class="side"><div class="brand"><div class="logo"></div>Projectly</div><nav class="nav" aria-label="Main">
${[["Projects", "/projects"], ["Team", "/team"], ["Settings", "/settings"]].map(([l, h]) => `<a href="${h}" class="${l === active ? "active" : ""}">${l}</a>`).join("")}
</nav></aside><main>${content}</main></div>`,
  );

const projectsPage = (createdId) => {
  const created = projects.find((p) => p.id === createdId);
  const counts = ["Planning", "In progress", "On hold"].map((s) => [s, projects.filter((p) => p.status === s).length]);
  return shell(
    "Projects",
    `<div class="top"><div><h1>Projects</h1><div class="sub">Everything your team is working on.</div></div><a class="btn" href="/projects/new">+ New project</a></div>
${created ? `<div class="toast" role="status">✓ Project “${esc(created.name)}” created</div>` : ""}
<div class="stats">${counts.map(([s, n]) => `<div class="card stat"><span>${s}</span><b>${n}</b></div>`).join("")}</div>
<div class="card"><table><thead><tr><th>Name</th><th>Status</th><th>Owner</th><th>Created</th></tr></thead><tbody>
${projects.map((p) => `<tr class="${p.id === createdId ? "new" : ""}"><td><a href="/projects/${p.id}">${esc(p.name)}</a></td><td><span class="badge b-${esc(p.status.split(" ")[0])}">${esc(p.status)}</span></td><td>${esc(p.owner)}</td><td>${p.created}</td></tr>`).join("")}
</tbody></table></div>`,
  );
};

const newProjectPage = (error = "", values = {}) =>
  shell(
    "Projects",
    `<div class="top"><div><h1>New project</h1><div class="sub">Give your project a name and an owner.</div></div></div>
<form class="card" method="post" action="/projects">
<div class="field"><label for="name">Project name</label><input id="name" name="name" placeholder="e.g. Q3 Product Launch" value="${esc(values.name ?? "")}">${error ? `<div class="error" role="alert">${esc(error)}</div>` : ""}</div>
<div class="field"><label for="description">Description</label><textarea id="description" name="description" placeholder="What is this project about?">${esc(values.description ?? "")}</textarea></div>
<div class="row"><div class="field"><label for="status">Status</label><select id="status" name="status">${["Planning", "In progress", "On hold"].map((s) => `<option>${s}</option>`).join("")}</select></div>
<div class="field"><label for="owner">Owner</label><select id="owner" name="owner">${TEAM.map((t) => `<option>${t}</option>`).join("")}</select></div></div>
<div class="actions"><button class="btn" type="submit">Create project</button><a class="btn ghost" href="/projects">Cancel</a></div></form>`,
  );

const projectPage = (p) =>
  shell(
    "Projects",
    `<div class="top"><div><h1>${esc(p.name)}</h1><div class="sub">${esc(p.description || "No description")}</div></div><a class="btn ghost" href="/projects">Back to projects</a></div>
<div class="card"><dl><dt>Status</dt><dd><span class="badge b-${esc(p.status.split(" ")[0])}">${esc(p.status)}</span></dd><dt>Owner</dt><dd>${esc(p.owner)}</dd><dt>Created</dt><dd>${p.created}</dd></dl></div>`,
  );

const loginPage = (error = "") =>
  page(
    "Sign in",
    `<div class="login"><form class="card" method="post" action="/login" style="padding:36px">
<div class="brand" style="color:#0f172a;padding:0 0 20px"><div class="logo"></div>Projectly</div>
<div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username"></div>
<div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password"></div>
${error ? `<div class="error" role="alert">${esc(error)}</div>` : ""}
<button class="btn" type="submit" style="width:100%;justify-content:center;margin-top:8px">Sign in</button></form></div>`,
  );

const readBody = (req) =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(data))));
  });

const send = (res, status, html, headers = {}) => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  res.end(html);
};
const redirect = (res, location, headers = {}) => {
  res.writeHead(303, { location, ...headers });
  res.end();
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const cookie = /(?:^|;\s*)session=([a-f0-9]+)/.exec(req.headers.cookie ?? "")?.[1];
  const authed = cookie && sessions.has(cookie);

  if (req.method === "POST" && url.pathname === "/api/reset") {
    projects = seed();
    nextId = 4;
    res.writeHead(204);
    return res.end();
  }
  if (url.pathname === "/health") return send(res, 200, "ok");
  if (url.pathname === "/login") {
    if (req.method === "POST") {
      const body = await readBody(req);
      if (body.email === USER && body.password === PASSWORD) {
        // Every login starts from the same demo data, so the AI's practice run and the
        // recorded take see the same app.
        projects = seed();
        nextId = 4;
        const token = randomBytes(16).toString("hex");
        sessions.add(token);
        return redirect(res, "/projects", { "set-cookie": `session=${token}; HttpOnly; Path=/; SameSite=Lax` });
      }
      return send(res, 401, loginPage("Incorrect email or password."));
    }
    return send(res, 200, loginPage());
  }
  if (!authed) return redirect(res, "/login");

  if (url.pathname === "/" ) return redirect(res, "/projects");
  if (url.pathname === "/projects" && req.method === "GET") return send(res, 200, projectsPage(Number(url.searchParams.get("created"))));
  if (url.pathname === "/projects/new") return send(res, 200, newProjectPage());
  if (url.pathname === "/projects" && req.method === "POST") {
    const body = await readBody(req);
    const name = (body.name ?? "").trim();
    if (!name) return send(res, 422, newProjectPage("Please enter a project name.", body));
    const project = {
      id: nextId++,
      name,
      description: (body.description ?? "").trim(),
      status: body.status ?? "Planning",
      owner: body.owner ?? TEAM[0],
      created: new Date().toISOString().slice(0, 10),
    };
    projects.unshift(project);
    return redirect(res, `/projects?created=${project.id}`);
  }
  const match = /^\/projects\/(\d+)$/.exec(url.pathname);
  if (match) {
    const project = projects.find((p) => p.id === Number(match[1]));
    return project ? send(res, 200, projectPage(project)) : send(res, 404, shell("Projects", "<h1>Not found</h1>"));
  }
  if (url.pathname === "/team") {
    return send(res, 200, shell("Team", `<div class="top"><h1>Team</h1><button class="btn">Invite member</button></div><div class="card"><table><tbody>${TEAM.map((t) => `<tr><td>${t}</td><td>Member</td></tr>`).join("")}</tbody></table></div>`));
  }
  if (url.pathname === "/settings") {
    return send(res, 200, shell("Settings", `<div class="top"><h1>Settings</h1></div><div class="card" style="padding:28px"><p>Workspace: Acme Inc.</p><button class="btn danger">Delete workspace</button></div>`));
  }
  send(res, 404, shell("Projects", "<h1>Not found</h1>"));
});

server.listen(PORT, () => console.log(`Projectly running at http://localhost:${PORT} (login: ${USER})`));
