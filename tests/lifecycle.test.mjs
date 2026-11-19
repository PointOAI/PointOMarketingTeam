// Black-box end-to-end test of the assembled single-file app: spawns `node server.js` (MOCK=1) as a real
// process, drives every endpoint over HTTP, watches SSE, runs a full task lifecycle (hire recommended team,
// brand kit, Manager-routed task -> awaiting_approval -> reject with feedback -> revision -> approve -> export)
// and checks persistence across a SIGTERM restart and a kill -9 mid-task.
// Run: node tests/lifecycle.test.mjs
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server.js", import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pointo-life-"));
const port = 20000 + Math.floor(Math.random() * 30000);
const API_KEY = "sk-test-SECRET-123";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (name) => { passed++; console.log("ok", name); };

function launch(extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, MOCK: "1", MOCK_DELAY_MS: "40", HANDOFF_MS: "0", PORT: String(port), DATA_DIR: dataDir, ANTHROPIC_API_KEY: API_KEY, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  child.log = () => log;
  return child;
}
async function waitUp() {
  for (let i = 0; i < 100; i++) { try { if ((await req("GET", "/healthz")).status === 200) return; } catch { /* not up yet */ } await sleep(100); }
  throw new Error("server did not start");
}
function stop(child, sig = "SIGTERM") {
  return new Promise((res) => { if (child.exitCode !== null) return res(); child.once("exit", res); child.kill(sig); });
}
function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
    const h = { ...(data !== null ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers };
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: h }, (res) => {
      const c = []; res.on("data", (x) => c.push(x));
      res.on("end", () => { const text = Buffer.concat(c).toString(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    r.on("error", reject); if (data !== null) r.write(data); r.end();
  });
}
function sse() {
  const events = []; let raw = "";
  const r = http.get({ host: "127.0.0.1", port, path: "/api/events" }, (res) => {
    events.headers = res.headers; let buf = ""; res.setEncoding("utf8");
    res.on("data", (ch) => {
      raw += ch; buf += ch; let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2); const ev = {};
        for (const l of block.split("\n")) { if (l.startsWith("event: ")) ev.type = l.slice(7); else if (l.startsWith("data: ")) ev.data = JSON.parse(l.slice(6)); }
        if (ev.type) events.push(ev);
      }
    });
  });
  r.on("error", () => {});
  return { events, raw: () => raw, close: () => r.destroy() };
}
async function waitTask(id, statuses, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const t = (await req("GET", `/api/tasks/${id}`)).json.task;
    if (statuses.includes(t.status)) return t;
    if (["failed", "cancelled"].includes(t.status) && !statuses.includes(t.status)) throw new Error(`task ${id} ${t.status}: ${t.error?.message}`);
    await sleep(60);
  }
  throw new Error(`task ${id} never reached ${statuses}`);
}

let child = launch();
try {
  await waitUp();
  const stream = sse();
  await sleep(300);

  // ---- static / basic endpoints
  const root = await req("GET", "/");
  assert.equal(root.status, 200); assert.match(root.headers["content-type"], /text\/html/);
  assert.ok(root.headers["content-security-policy"].includes("default-src 'self'")); assert.equal(root.headers["x-content-type-options"], "nosniff");
  assert.ok(root.text.includes("<title>Marketing Office</title>"));
  assert.deepEqual((await req("GET", "/healthz")).json, { ok: true, mode: "mock" });
  const roles = (await req("GET", "/api/roles")).json;
  assert.equal(roles.roles.length, 10); assert.ok(roles.roles.every((r) => !("systemPrompt" in r))); assert.equal(roles.recommended.length, 7);
  assert.equal(stream.events.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(stream.events[0].type, "snapshot");
  ok("GET /, /healthz, /api/roles, SSE snapshot");

  // ---- bad inputs on every family of endpoint
  const bad = [
    ["POST", "/api/team", "{oops", 400], ["POST", "/api/team", "[1]", 400], ["POST", "/api/team", { roleId: "ceo" }, 400],
    ["POST", "/api/tasks", { title: "", type: "social_post", assignee: { mode: "manager" } }, 400],
    ["POST", "/api/tasks", { title: "x", type: "nope", assignee: { mode: "manager" } }, 400],
    ["POST", "/api/tasks", { title: "x", type: "social_post", assignee: { mode: "member", memberId: "m_0000000000" } }, 400],
    ["GET", "/api/tasks/t_0000000000", undefined, 404], ["GET", "/api/tasks/bad", undefined, 404], ["PATCH", "/api/team/m_zz", { name: "a" }, 404],
    ["DELETE", "/api/brand", undefined, 405], ["GET", "/api/nothing", undefined, 404], ["GET", "/api/state/", undefined, 404],
    ["PUT", "/api/settings", { maxConcurrent: 9 }, 400], ["PUT", "/api/brand", { businessName: "x".repeat(5000) }, 400],
    ["POST", "/api/digest/run", {}, 409],
  ];
  for (const [m, p, b, s] of bad) { const r = await req(m, p, b); assert.equal(r.status, s, `${m} ${p} -> ${r.status} ${r.text}`); assert.ok(r.json?.error && r.json?.code, `${m} ${p} error shape`); }
  assert.equal((await req("POST", "/api/team", "roleId=writer", { "content-type": "text/plain" })).status, 415);
  assert.equal((await req("POST", "/api/team", JSON.stringify({ roleId: "writer", name: "x".repeat(1_600_000) }))).status, 413);
  assert.equal((await req("GET", "/healthz")).status, 200);
  ok(`bad inputs rejected with proper codes (${bad.length + 2} cases), server still healthy`);

  // ---- hire, brand, settings
  const hired = await req("POST", "/api/team/recommended", {});
  assert.equal(hired.status, 200); assert.equal(hired.json.team.length, 7);
  assert.equal(new Set(hired.json.team.map((m) => m.desk)).size, 7);
  assert.equal((await req("POST", "/api/team", { roleId: "writer" })).status, 409);
  const ads = await req("POST", "/api/team", { roleId: "ads", name: "Ada" }); assert.equal(ads.status, 201);
  assert.equal((await req("PATCH", `/api/team/${ads.json.member.id}`, { name: "Ada L." })).json.member.name, "Ada L.");
  assert.equal((await req("DELETE", `/api/team/${ads.json.member.id}`)).status, 200);
  const brand = (await req("PUT", "/api/brand", { businessName: "Bean There", offering: "Specialty coffee subscriptions", audience: "home baristas",
    voice: "Warm and witty", platforms: ["instagram", "x", "linkedin"], bannedWords: ["cheap"], goals: "Grow sign-ups" })).json.brand;
  assert.equal(brand.businessName, "Bean There"); assert.deepEqual((await req("GET", "/api/brand")).json.brand.platforms, ["instagram", "x", "linkedin"]);
  assert.equal((await req("PUT", "/api/settings", { maxConcurrent: 2 })).json.settings.maxConcurrent, 2);
  ok("hire recommended (7, distinct desks), duplicate 409, hire/rename/fire, brand kit, settings");

  // ---- full lifecycle
  const created = await req("POST", "/api/tasks", { title: "Autumn blend launch", description: "Announce our autumn blend", type: "social_post", platforms: ["instagram", "x"], assignee: { mode: "manager" } });
  assert.equal(created.status, 201);
  const id = created.json.task.id;
  assert.equal((await req("POST", `/api/tasks/${id}/approve`, {})).status, 409);
  let t = await waitTask(id, ["awaiting_approval"]);
  const seen = stream.events.filter((e) => e.type === "task" && e.data.task.id === id).map((e) => e.data.task.status).filter((s, i, a) => s !== a[i - 1]);
  for (const s of ["queued", "briefing", "in_progress", "checks", "qa_review", "awaiting_approval"]) assert.ok(seen.includes(s), `status ${s} seen in ${seen}`);
  const handoffs = stream.events.filter((e) => e.type === "handoff" && e.data.taskId === id);
  assert.ok(handoffs.length >= 3, "handoffs: " + handoffs.length);
  assert.ok(t.output.items.length >= 2 && t.usage && (t.usage.input_tokens + t.usage.output_tokens) > 0);
  ok(`task moved through pipeline (${seen.join(" -> ")}), ${handoffs.length} hand-offs`);

  assert.equal((await req("POST", `/api/tasks/${id}/reject`, {})).status, 400);
  const rej = await req("POST", `/api/tasks/${id}/reject`, { feedback: "Make it more playful and mention free shipping" });
  assert.equal(rej.status, 200);
  await waitTask(id, ["revision", "queued", "in_progress", "checks", "qa_review"], 10000).catch(() => null);
  t = await waitTask(id, ["awaiting_approval"]);
  assert.ok(JSON.stringify(t).includes("free shipping"), "feedback recorded on task");
  const key = t.output.items[0].key;
  const app = await req("POST", `/api/tasks/${id}/approve`, { editedOutput: { items: [{ key, text: "Edited by a human: autumn blend is here. Try it today!" }] } });
  assert.equal(app.status, 200); assert.equal(app.json.task.status, "approved");
  assert.equal(app.json.task.output.items.find((i) => i.key === key).edited, true);
  ok("reject without feedback 400; reject with feedback -> revision -> awaiting_approval; approve with edit");

  const md = await req("GET", `/api/tasks/${id}/export?format=md`);
  assert.equal(md.status, 200); assert.match(md.headers["content-type"], /text\/markdown/); assert.match(md.headers["content-disposition"], /attachment; filename=".+\.md"/);
  assert.ok(md.text.startsWith("# Autumn blend launch") && md.text.includes("Edited by a human"));
  const js = await req("GET", `/api/tasks/${id}/export?format=json`);
  assert.equal(js.json.task.status, "approved");
  assert.equal((await req("GET", `/api/tasks/${id}/export?format=pdf`)).status, 400);
  ok("export md/json, bad format 400");

  // ---- digest, cancel, retry
  const dg = await req("POST", "/api/digest/run", {}); assert.equal(dg.status, 201);
  assert.equal((await waitTask(dg.json.task.id, ["awaiting_approval"])).type, "news_digest");
  const c = (await req("POST", "/api/tasks", { title: "To cancel", type: "blog_article", assignee: { mode: "manager" } })).json.task.id;
  await waitTask(c, ["briefing", "in_progress"], 10000);
  assert.equal((await req("POST", `/api/tasks/${c}/cancel`, {})).json.task.status, "cancelled");
  assert.equal((await req("POST", `/api/tasks/${c}/retry`, {})).status, 200);
  await waitTask(c, ["awaiting_approval"]);
  const usage = (await req("GET", "/api/usage")).json;
  assert.equal(usage.mode, "mock"); assert.ok(usage.usage);
  ok("digest run-now, cancel + retry, usage");

  // ---- key never leaks
  const st = await req("GET", "/api/state");
  assert.ok(!st.text.includes(API_KEY) && !stream.raw().includes(API_KEY));
  ok("API key never in responses or SSE");
  stream.close();

  // ---- persistence across SIGTERM restart
  const before = st.json;
  await stop(child);
  child = launch(); await waitUp();
  const after = (await req("GET", "/api/state")).json;
  assert.deepEqual(after.team.map((m) => [m.id, m.name, m.roleId]), before.team.map((m) => [m.id, m.name, m.roleId]));
  assert.equal(after.brand.businessName, "Bean There");
  assert.equal(after.settings.maxConcurrent, 2);
  assert.equal(after.tasks.find((x) => x.id === id).status, "approved");
  assert.equal(after.tasks.length, before.tasks.length);
  ok("state persisted across SIGTERM restart");

  // ---- kill -9 mid-task, then resume (slower mock calls so the kill lands mid-step)
  await stop(child);
  child = launch({ MOCK_DELAY_MS: "800" }); await waitUp();
  const k = (await req("POST", "/api/tasks", { title: "Resume me", description: "slow", type: "social_post", platforms: ["instagram", "x", "linkedin"], assignee: { mode: "manager" } })).json.task.id;
  await waitTask(k, ["in_progress"], 15000);
  await sleep(300);
  await stop(child, "SIGKILL");
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8")).tasks.find((x) => x.id === k);
  assert.ok(["briefing", "in_progress", "checks", "qa_review", "revision"].includes(onDisk.status), "on disk at kill: " + onDisk.status);
  const hadRunningStep = onDisk.steps.some((s) => s.status === "running");
  child = launch(); await waitUp();
  const resumed = await waitTask(k, ["awaiting_approval"]);
  if (hadRunningStep) assert.ok(resumed.steps.some((s) => s.status === "interrupted"), "an interrupted step is recorded");
  assert.ok((await req("GET", "/api/state")).text.includes("Resumed after restart"));
  ok("kill -9 mid-task: task resumed and completed after restart");

  // ---- corrupt state file
  await stop(child);
  fs.writeFileSync(path.join(dataDir, "state.json"), "{garbage");
  child = launch(); await waitUp();
  assert.equal((await req("GET", "/api/state")).json.team.length, 0);
  assert.ok(fs.readdirSync(dataDir).some((f) => /^state\.corrupt-.*\.json$/.test(f)));
  assert.ok(!fs.readdirSync(dataDir).some((f) => f.endsWith(".tmp")));
  ok("corrupt state.json -> fresh start, corrupt file kept, no tmp files");
} catch (e) {
  console.error("FAIL", e); console.error("--- server log ---\n" + child.log());
  process.exitCode = 1;
} finally {
  await stop(child);
  fs.rmSync(dataDir, { recursive: true, force: true });
}
console.log(`\n${passed} lifecycle checks passed`);
