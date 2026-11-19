// HTTP robustness, SSE details, persistence and process-level tests.
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start, req, sse, sleep, waitFor, waitStatus, tmpDir } from "./lib.mjs";

let passed = 0;
async function T(name, fn) { const t0 = Date.now(); await fn(); passed++; console.log(`ok ${name} (${Date.now() - t0} ms)`); }
const SOCIAL = { title: "Autumn launch", description: "Launch", type: "social_post", platforms: ["instagram", "x"], assignee: { mode: "manager" } };
const BACKEND_FILE = fileURLToPath(process.env.BACKEND || new URL("../../server.js", import.meta.url).href);

function rawHttp(port, text) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    let out = "";
    s.on("data", (d) => { out += d; });
    s.on("error", () => resolve(out));
    s.on("close", () => resolve(out));
    s.write(text);
    setTimeout(() => { s.destroy(); }, 700);
  });
}

await T("D routes, status codes, error shape, headers", async () => {
  const app = await start({ ANTHROPIC_API_KEY: "sk-test-123" });
  const root = await req(app, "GET", "/");
  assert.equal(root.status, 200);
  assert.equal(root.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(root.headers["content-security-policy"], "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  assert.equal(root.headers["x-content-type-options"], "nosniff");
  assert.equal(root.headers["referrer-policy"], "no-referrer");
  const fe = path.join(path.dirname(BACKEND_FILE), "frontend.html");
  if (fs.existsSync(fe)) assert.equal(root.text, fs.readFileSync(fe, "utf8"));
  const h = await req(app, "GET", "/healthz");
  assert.deepEqual(h.json, { ok: true, mode: "mock" });
  assert.equal(h.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(h.headers["cache-control"], "no-store");
  const st = (await req(app, "GET", "/api/state")).json;
  for (const k of ["mode", "model", "workerModel", "serverTime", "brand", "team", "tasks", "settings", "usage", "activity", "queue", "catalog"]) assert.ok(k in st, k);
  assert.equal(st.model, "claude-opus-5-5");
  assert.ok(st.catalog.roles.length === 10 && st.catalog.roles.every((r) => !("systemPrompt" in r)));
  assert.ok(st.catalog.taskTypes.every((t) => !("route" in t) && t.platformScope));
  assert.deepEqual(st.catalog.recommended, ["manager", "research", "seo", "writer", "designer", "qa", "analytics"]);
  const roles = (await req(app, "GET", "/api/roles")).json;
  assert.ok(roles.roles.every((r) => !("systemPrompt" in r)) && roles.recommended.length === 7);
  const E = async (method, p, body, status, code, headers) => {
    const r = await req(app, method, p, body, headers);
    assert.equal(r.status, status, `${method} ${p} -> ${r.status} ${r.text}`);
    if (code) { assert.equal(r.json.code, code, `${method} ${p}`); assert.equal(typeof r.json.error, "string"); }
    return r;
  };
  await E("POST", "/api/team", "{bad json", 400, "bad_request");
  await E("POST", "/api/team", "[1,2]", 400, "bad_request");
  await E("POST", "/api/team", "null", 400, "bad_request");
  await E("POST", "/api/team", "\"str\"", 400, "bad_request");
  await E("POST", "/api/team", { roleId: "writer" }, 415, "unsupported_media_type", { "content-type": "text/plain" });
  await E("POST", "/api/team", '{"roleId":"writer"}', 415, "unsupported_media_type", { "content-type": "application/x-www-form-urlencoded" });
  const big = JSON.stringify({ roleId: "writer", name: "x".repeat(1.5 * 1024 * 1024) });
  await E("POST", "/api/team", big, 413, "payload_too_large");
  // chunked oversize (no content-length)
  const chunked = await new Promise((resolve) => {
    import("node:http").then(({ default: http }) => {
      const r = http.request({ host: "127.0.0.1", port: app.port, method: "PUT", path: "/api/brand", headers: { "content-type": "application/json" } }, (res) => {
        let t = ""; res.on("data", (d) => (t += d)); res.on("end", () => resolve({ status: res.statusCode, text: t }));
      });
      r.on("error", (e) => resolve({ status: 0, err: e.message }));
      const chunk = "a".repeat(64 * 1024);
      let n = 0;
      const pump = () => { while (n < 40) { n++; if (!r.write(chunk)) { r.once("drain", pump); return; } } r.end(); };
      pump();
    });
  });
  assert.equal(chunked.status, 413, JSON.stringify(chunked));
  await E("GET", "/nope", undefined, 404, "not_found");
  await E("GET", "/api/state/", undefined, 404, "not_found");
  await E("GET", "/api/tasks/t_123", undefined, 404, "not_found");
  await E("GET", "/api/tasks/t_ABCDEF1234", undefined, 404, "not_found");
  await E("GET", "/api/tasks/t_0123456789", undefined, 404, "not_found");
  await E("POST", "/api/tasks/t_0123456789/approve", {}, 404, "not_found");
  await E("PATCH", "/api/team/m_bad", { name: "x" }, 404, "not_found");
  await E("PATCH", "/api/team/m_0123456789", { name: "x" }, 404, "not_found");
  await E("GET", "/api/tasks/../../etc/passwd", undefined, 404, "not_found");
  let r = await E("DELETE", "/api/brand", undefined, 405, "method_not_allowed");
  assert.equal(r.headers.allow, "GET, PUT");
  r = await E("HEAD", "/", undefined, 405);
  assert.equal(r.headers.allow, "GET");
  r = await E("HEAD", "/api/state", undefined, 405);
  r = await E("GET", "/api/team", undefined, 405, "method_not_allowed"); assert.equal(r.headers.allow, "POST");
  r = await E("GET", "/api/team/recommended", undefined, 405, "method_not_allowed"); assert.equal(r.headers.allow, "POST");
  r = await E("PUT", "/api/tasks", {}, 405, "method_not_allowed"); assert.equal(r.headers.allow, "GET, POST");
  r = await E("OPTIONS", "/api/settings", undefined, 405, "method_not_allowed");
  await E("POST", "/api/team", { roleId: "ceo" }, 400, "bad_request");
  await E("POST", "/api/team", { roleId: 5 }, 400, "bad_request");
  await E("POST", "/api/team", { roleId: "writer", name: "x".repeat(41) }, 400, "bad_request");
  await E("POST", "/api/team", { roleId: "writer", name: "  " }, 400, "bad_request");
  await E("POST", "/api/team", { roleId: "writer", name: 7 }, 400, "bad_request");
  const w = (await E("POST", "/api/team", { roleId: "writer" }, 201)).json.member;
  assert.match(w.id, /^m_[0-9a-f]{10}$/);
  await E("POST", "/api/team", { roleId: "writer" }, 409, "conflict");
  for (const roleId of ["manager", "research", "seo", "designer", "qa", "analytics", "ads", "email"]) await E("POST", "/api/team", { roleId }, 201);
  const full = await E("POST", "/api/team", { roleId: "community" }, 201);
  void full;
  // 10 roles exist so the team-full 409 requires 10 members: all hired now
  assert.equal((await req(app, "GET", "/api/state")).json.team.length, 10);
  const rec = await E("POST", "/api/team/recommended", {}, 200);
  assert.deepEqual(rec.json.hired, []);
  await E("PATCH", `/api/team/${w.id}`, { name: "" }, 400, "bad_request");
  await E("PATCH", `/api/team/${w.id}`, {}, 400, "bad_request");
  // brand validation
  await E("PUT", "/api/brand", { businessName: "x".repeat(101) }, 400, "bad_request");
  await E("PUT", "/api/brand", { bannedWords: "cheap" }, 400, "bad_request");
  await E("PUT", "/api/brand", { bannedWords: [1] }, 400, "bad_request");
  await E("PUT", "/api/brand", { bannedWords: ["x".repeat(51)] }, 400, "bad_request");
  await E("PUT", "/api/brand", { platforms: ["myspace"] }, 400, "bad_request");
  await E("PUT", "/api/brand", { competitors: [{ name: "A", url: "javascript:alert(1)" }] }, 400, "bad_request");
  await E("PUT", "/api/brand", { competitors: [{ name: "", url: "" }] }, 400, "bad_request");
  await E("PUT", "/api/brand", { competitors: Array.from({ length: 21 }, (_, i) => ({ name: "c" + i, url: "" })) }, 400, "bad_request");
  const okBrand = await E("PUT", "/api/brand", { businessName: " Pointo\u0000 ", bannedWords: ["Cheap", "cheap", " "], platforms: ["x", "x", "instagram"], competitors: [{ name: "Rival", url: "https://rival.example" }], extra: 1 }, 200);
  assert.equal(okBrand.json.brand.businessName, "Pointo");
  assert.deepEqual(okBrand.json.brand.bannedWords, ["Cheap"]);
  assert.deepEqual(okBrand.json.brand.platforms, ["x", "instagram"]);
  assert.ok(okBrand.json.brand.updatedAt);
  assert.ok(!("extra" in okBrand.json.brand));
  // tasks validation
  await E("POST", "/api/tasks", { ...SOCIAL, title: "" }, 400, "bad_request");
  await E("POST", "/api/tasks", { ...SOCIAL, title: "x".repeat(121) }, 400, "bad_request");
  await E("POST", "/api/tasks", { ...SOCIAL, description: "x".repeat(4001) }, 400, "bad_request");
  await E("POST", "/api/tasks", { ...SOCIAL, type: "tweet" }, 400, "bad_request");
  await E("POST", "/api/tasks", { ...SOCIAL, platforms: "x" }, 400, "bad_request");
  await E("POST", "/api/tasks", { ...SOCIAL, assignee: { mode: "member", memberId: "m_0000000000" } }, 400, "bad_request");
  await E("POST", "/api/tasks", { ...SOCIAL, assignee: { mode: "boss" } }, 400, "bad_request");
  await E("POST", "/api/tasks", { ...SOCIAL, assignee: "manager" }, 400, "bad_request");
  // settings validation
  await E("PUT", "/api/settings", { maxConcurrent: 0 }, 400, "bad_request");
  await E("PUT", "/api/settings", { maxConcurrent: 6 }, 400, "bad_request");
  await E("PUT", "/api/settings", { maxConcurrent: 1.5 }, 400, "bad_request");
  await E("PUT", "/api/settings", { dailyDigest: "yes" }, 400, "bad_request");
  assert.deepEqual((await E("GET", "/api/settings", undefined, 200)).json.settings, { dailyDigest: false, maxConcurrent: 2, lastDigestAt: null });
  // empty body POST is {}
  const empty = await req(app, "POST", "/api/team/recommended", undefined);
  assert.equal(empty.status, 200);
  // approve/reject validation on a task
  const t = (await E("POST", "/api/tasks", SOCIAL, 201)).json.task;
  assert.match(t.id, /^t_[0-9a-f]{10}$/);
  await E("POST", `/api/tasks/${t.id}/approve`, {}, 409, "conflict"); // not awaiting yet (queued/running)
  await waitStatus(app, t.id, "awaiting_approval");
  await E("POST", `/api/tasks/${t.id}/approve`, { editedOutput: { items: [{ key: "nope", text: "x" }] } }, 400, "bad_request");
  await E("POST", `/api/tasks/${t.id}/approve`, { editedOutput: { items: [{ key: t.id, text: 5 }] } }, 400, "bad_request");
  await E("POST", `/api/tasks/${t.id}/approve`, { editedOutput: { items: "x" } }, 400, "bad_request");
  await E("POST", `/api/tasks/${t.id}/reject`, { feedback: "x".repeat(2001) }, 400, "bad_request");
  await E("POST", `/api/tasks/${t.id}/reject`, {}, 400, "bad_request");
  await E("GET", `/api/tasks/${t.id}/export?format=xml`, undefined, 400, "bad_request");
  const t2 = (await E("POST", "/api/tasks", { ...SOCIAL, description: "[slow]" }, 201)).json.task;
  await E("GET", `/api/tasks/${t2.id}/export?format=md`, undefined, 409, "conflict");
  await req(app, "POST", `/api/tasks/${t2.id}/cancel`, {});
  const u = await E("GET", "/api/usage", undefined, 200);
  assert.ok(u.json.usage.totals && u.json.mode === "mock");
  assert.ok((await E("GET", "/api/tasks", undefined, 200)).json.tasks.length === 2);
  // still alive
  assert.equal((await req(app, "GET", "/healthz")).status, 200);
  await app.close();
});

await T("D fuzz of malformed requests; process survives", async () => {
  const app = await start({ ANTHROPIC_API_KEY: "sk-test-123" });
  const garbage = [
    "GARBAGE\r\n\r\n",
    "GET /\r\n\r\n",
    "GET http://evil.com/api/state HTTP/1.1\r\nHost: x\r\n\r\n",
    "GET //api/state HTTP/1.1\r\nHost: x\r\n\r\n",
    "GET * HTTP/1.1\r\nHost: x\r\n\r\n",
    "POST /api/team HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 5\r\n\r\n{\"ro",
    "POST /api/team HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: abc\r\n\r\n{}",
    "POST /api/team HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n",
    "POST /api/team HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 99999999\r\n\r\n{}",
    "PUT /api/brand HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 30\r\n\r\n{\"__proto__\":{\"polluted\":1}}  ",
    "GET /api/%ZZ HTTP/1.1\r\nHost: x\r\n\r\n",
    "GET /api/tasks/t_0123456789/export?format=%ZZ HTTP/1.1\r\nHost: x\r\n\r\n",
    "DELETE /api/team/m_0123456789 HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 3\r\n\r\nabc",
    "POST /api/team HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 4\r\n\r\nÿþ\u0000\u0001",
    "GET /api/events HTTP/1.1\r\nHost: x\r\n\r\n",
    "\u0000\u0001\u0002\u0003",
    "GET / HTTP/1.1\r\n" + "X: " + "a".repeat(20000) + "\r\n\r\n",
  ];
  for (const g of garbage) {
    const out = await rawHttp(app.port, g);
    assert.ok(!out.includes("sk-test-123"));
    assert.ok(!/at .*\.js:\d+/.test(out), "no stack traces: " + out.slice(0, 200));
  }
  assert.equal(({}).polluted, undefined);
  // random JSON shapes
  const shapes = [0, -1, true, "x", [], {}, { a: { b: [] } }, null, 1e309, " ", { roleId: { toString: 1 } }, { title: ["a"] }, { name: null }];
  for (const p of ["/api/team", "/api/tasks", "/api/brand", "/api/settings", "/api/team/recommended", "/api/digest/run"]) {
    for (const s of shapes) for (const m of ["POST", "PUT", "PATCH"]) {
      const r = await req(app, m, p, JSON.stringify(s));
      assert.ok([200, 201, 400, 405, 409].includes(r.status), `${m} ${p} ${JSON.stringify(s)} -> ${r.status} ${r.text}`);
      if (r.status >= 400) assert.ok(r.json && typeof r.json.error === "string" && typeof r.json.code === "string");
    }
  }
  for (let i = 0; i < 200; i++) {
    const bytes = Buffer.from(Array.from({ length: 1 + Math.floor(Math.random() * 200) }, () => Math.floor(Math.random() * 256)));
    const r = await req(app, "POST", "/api/tasks", bytes);
    assert.ok([201, 400].includes(r.status), String(r.status));
  }
  assert.equal((await req(app, "GET", "/healthz")).status, 200);
  await app.close();
});

await T("SSE: headers, retry+snapshot, ids increase, cap 50, closed clients removed, heartbeat", async () => {
  const app = await start();
  const first = sse(app); await first.ready();
  assert.equal(first.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(first.headers["cache-control"], "no-cache, no-transform");
  assert.equal(first.headers["x-accel-buffering"], "no");
  assert.ok(first.raw().startsWith("retry: 2000\n\n"));
  const clients = [first];
  for (let i = 0; i < 49; i++) { const c = sse(app); clients.push(c); await c.ready(); }
  assert.equal(first.closed, false);
  const extra = sse(app); await extra.ready();
  await waitFor(() => first.closed, 2000);
  // abruptly destroy 10 clients then broadcast: no throw, server still fine
  for (const c of clients.slice(1, 11)) c.req.destroy();
  await sleep(100);
  await req(app, "POST", "/api/team", { roleId: "writer" });
  const ev = await extra.wait((e) => e.type === "member");
  const ids = extra.events.filter((e) => e.id).map((e) => e.id);
  assert.ok(ids.every((v, i) => i === 0 || v > ids[i - 1]));
  assert.ok(ev.data.member.roleId === "writer");
  const act = await extra.wait((e) => e.type === "activity");
  assert.equal(act.data.activity.kind, "hire");
  // events seen across a broadcast of settings/brand
  await req(app, "PUT", "/api/settings", { maxConcurrent: 3 });
  await extra.wait((e) => e.type === "settings" && e.data.settings.maxConcurrent === 3);
  await req(app, "PUT", "/api/brand", { businessName: "B" });
  await extra.wait((e) => e.type === "brand" && e.data.brand.businessName === "B");
  console.log("   waiting 15.5 s for heartbeat...");
  await extra.wait((e) => e.comment === "ping", 16500);
  for (const c of clients) c.close();
  extra.close();
  await app.close();
});

await T("task cap 200: oldest terminal tasks pruned with task_removed", async () => {
  const dataDir = tmpDir("cap");
  const now = new Date().toISOString();
  const tasks = Array.from({ length: 200 }, (_, i) => ({ id: "t_" + i.toString(16).padStart(10, "0"), title: "Old " + i, type: "custom", status: "cancelled", createdAt: now, assignee: { mode: "manager" }, steps: [] }));
  fs.writeFileSync(path.join(dataDir, "state.json"), JSON.stringify({ version: 1, tasks }));
  const app = await start({}, dataDir);
  const ev = sse(app); await ev.ready();
  const c = await req(app, "POST", "/api/tasks", SOCIAL);
  assert.equal(c.status, 201);
  const rm = await ev.wait((e) => e.type === "task_removed");
  assert.equal(rm.data.id, "t_0000000000");
  assert.equal((await req(app, "GET", "/api/tasks")).json.tasks.length, 200);
  ev.close(); await app.close();
});

function spawnServer(env, dataDir) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, [BACKEND_FILE], { env: { ...process.env, MOCK: "1", MOCK_DELAY_MS: "20", HANDOFF_MS: "0", PORT: String(port), DATA_DIR: dataDir, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  const app = { port, proc: p, out: () => out };
  app.ready = waitFor(() => out.includes("Marketing Office (") , 5000);
  app.exited = new Promise((r) => p.on("exit", (code, sig) => r({ code, sig })));
  return app;
}

await T("F persistence: SIGTERM flush + restart, kill -9 mid-task resume, corrupt file, no tmp", async () => {
  const dataDir = tmpDir("persist");
  let s = spawnServer({ ANTHROPIC_API_KEY: "sk-test-123", MOCK_DELAY_MS: "600" }, dataDir);
  await s.ready;
  assert.match(s.out(), /Marketing Office \(mock mode\) at http:\/\/127\.0\.0\.1:\d+/);
  await req(s, "POST", "/api/team/recommended", {});
  await req(s, "PUT", "/api/brand", { businessName: "Persisted Co", bannedWords: ["cheap"] });
  await req(s, "PUT", "/api/settings", { maxConcurrent: 3, dailyDigest: false });
  const id = (await req(s, "POST", "/api/tasks", SOCIAL)).json.task.id;
  await waitStatus(s, id, "awaiting_approval");
  const before = (await req(s, "GET", "/api/state")).json;
  s.proc.kill("SIGTERM");
  const ex = await s.exited;
  assert.equal(ex.code, 0, s.out());
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"));
  assert.ok(!JSON.stringify(saved).includes("sk-test-123"));
  s = spawnServer({ MOCK_DELAY_MS: "600" }, dataDir); await s.ready;
  const after = (await req(s, "GET", "/api/state")).json;
  assert.deepEqual(after.team.map((m) => [m.id, m.name, m.desk]), before.team.map((m) => [m.id, m.name, m.desk]));
  assert.deepEqual(after.brand, before.brand);
  assert.deepEqual(after.settings, before.settings);
  assert.deepEqual(after.usage, before.usage);
  assert.deepEqual(after.tasks.map((t) => [t.id, t.status, t.steps.length]), before.tasks.map((t) => [t.id, t.status, t.steps.length]));
  assert.ok(after.activity.length >= before.activity.length);
  assert.equal(after.team.find((m) => m.roleId === "writer").status, "waiting");
  // kill -9 mid-task (slow) and restart -> resumed, interrupted, completes
  const id2 = (await req(s, "POST", "/api/tasks", { ...SOCIAL, title: "Slow one", description: "[slow]" })).json.task.id;
  await waitStatus(s, id2, "in_progress");
  await sleep(400); // let debounce save
  s.proc.kill("SIGKILL"); await s.exited;
  s = spawnServer({ MOCK_DELAY_MS: "600" }, dataDir); await s.ready;
  const t2 = (await req(s, "GET", `/api/tasks/${id2}`)).json.task;
  assert.ok(t2.steps.some((x) => x.status === "interrupted"), JSON.stringify(t2.steps.map((x) => x.status)));
  assert.ok(t2.steps.some((x) => x.title === "Resumed after restart"));
  const done = await waitStatus(s, id2, "awaiting_approval", 30000);
  assert.ok(done.steps.filter((x) => x.kind === "brief").length >= 2, "restarted from step 1");
  const st = (await req(s, "GET", "/api/state")).json;
  assert.ok(st.activity.some((a) => a.text.startsWith("Resumed after restart")));
  // kill -9 during a feedback revision -> redoes revision
  const rj = await req(s, "POST", `/api/tasks/${id2}/reject`, { feedback: "warmer" });
  assert.equal(rj.status, 200);
  await waitStatus(s, id2, "revision");
  await sleep(400);
  s.proc.kill("SIGKILL"); await s.exited;
  s = spawnServer({ MOCK_DELAY_MS: "20" }, dataDir); await s.ready;
  const t3 = await waitStatus(s, id2, "awaiting_approval", 30000);
  assert.equal(t3.pendingFeedbackRevision, false);
  const fbRev = t3.steps.filter((x) => x.kind === "revision").at(-1);
  assert.equal(fbRev.status, "done"); assert.equal(fbRev.detail.feedback, "warmer");
  const kinds = t3.steps.map((x) => x.kind);
  assert.equal(kinds.slice(kinds.lastIndexOf("human")).filter((k) => k === "brief").length, 0, "feedback resume does not re-brief");
  s.proc.kill("SIGTERM"); await s.exited;
  assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.endsWith(".tmp")), []);
  // corrupt
  fs.writeFileSync(path.join(dataDir, "state.json"), "{garbage");
  s = spawnServer({}, dataDir); await s.ready;
  assert.equal((await req(s, "GET", "/api/state")).json.team.length, 0);
  assert.ok(fs.readdirSync(dataDir).some((f) => /^state\.corrupt-.*\.json$/.test(f)));
  // wrong shape
  s.proc.kill("SIGTERM"); await s.exited;
  fs.writeFileSync(path.join(dataDir, "state.json"), JSON.stringify({ team: "nope" }));
  s = spawnServer({}, dataDir); await s.ready;
  assert.equal((await req(s, "GET", "/healthz")).status, 200);
  assert.equal(fs.readdirSync(dataDir).filter((f) => /^state\.corrupt-.*\.json$/.test(f)).length, 2);
  s.proc.kill("SIGTERM"); await s.exited;
  assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.endsWith(".tmp")), []);
});

await T("in-process close() flushes without cancelling; restart resumes", async () => {
  const dataDir = tmpDir("close");
  let app = await start({ MOCK_DELAY_MS: "1500" }, dataDir);
  await req(app, "POST", "/api/team/recommended", {});
  const id = (await req(app, "POST", "/api/tasks", { ...SOCIAL, description: "[slow]" })).json.task.id;
  await waitStatus(app, id, "in_progress");
  await sleep(100);
  await app.close();
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"));
  const st = saved.tasks.find((t) => t.id === id);
  assert.equal(st.status, "in_progress");
  assert.ok(!st.steps.some((s) => s.status === "cancelled"));
  app = await start({ MOCK_DELAY_MS: "1500" }, dataDir);
  const t = (await req(app, "GET", `/api/tasks/${id}`)).json.task;
  assert.ok(["queued", "briefing", "in_progress"].includes(t.status));
  assert.ok(t.steps.some((s) => s.status === "interrupted"));
  await req(app, "POST", `/api/tasks/${id}/cancel`, {});
  await app.close();
  assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.endsWith(".tmp")), []);
});

await T("debounced, serialised writes under burst", async () => {
  const dataDir = tmpDir("burst");
  const app = await start({}, dataDir);
  await Promise.all(Array.from({ length: 40 }, (_, i) => req(app, "PUT", "/api/brand", { businessName: "B" + i })));
  await sleep(400);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"));
  assert.equal(saved.version, 1);
  assert.equal(saved.brand.businessName, (await req(app, "GET", "/api/brand")).json.brand.businessName);
  await app.close();
  assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.endsWith(".tmp")), []);
});

await T("default binding 127.0.0.1 and port from env via startServer()", async () => {
  const { startServer } = await import(process.env.BACKEND || new URL("../../server.js", import.meta.url).href);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const app = await startServer({ dataDir: tmpDir("bind"), env: { MOCK: "1", PORT: String(port), QUIET: "1" } });
  assert.equal(app.server.address().address, "127.0.0.1");
  assert.equal(app.port, port);
  assert.equal(app.url, `http://127.0.0.1:${port}`);
  await app.close();
});

console.log(`\n${passed} http/persistence tests passed`);
