// QA (agents-claude): Claude API request correctness + real-mode pipeline paths, exercised against a
// LOCAL fake Anthropic API (no real key, no network). server.js runs as a child process in live mode with
// ANTHROPIC_API_KEY=<fake> and ANTHROPIC_BASE_URL=<fake server>; a second section runs MOCK=1 and proves the
// mock engine never calls the API and walks the same pipeline.
//
// Run: node tests/qa-agents-claude.test.mjs
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "server.js");
const FAKE_KEY = "sk-ant-qa-fake-key-0123456789";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rndPort = () => 20000 + Math.floor(Math.random() * 30000);

let passed = 0, failed = 0;
const failures = [];
async function T(name, fn) {
  const t0 = Date.now();
  try { await fn(); passed++; console.log(`ok   ${name} (${Date.now() - t0} ms)`); }
  catch (e) { failed++; failures.push(name); console.log(`FAIL ${name}\n     ${String(e && e.stack || e).split("\n").slice(0, 4).join("\n     ")}`); }
}

// ------------------------------------------------------------------ fake Anthropic API
const ROLE_MARKERS = { "Marketing Manager (orchestrator)": "manager", "Research & Intelligence": "research", "SEO Specialist": "seo",
  "Content Writer": "writer", "Creative Designer": "designer", "Brand & QA Reviewer": "qa", "Analytics & Reporting": "analytics",
  "Paid Ads Specialist": "ads", "Email/CRM Specialist": "email", "Community Manager": "community" };
function roleOf(body) {
  const sys = Array.isArray(body.system) ? body.system.map((b) => b.text || "").join("\n") : String(body.system || "");
  const m = sys.match(/## Your role: ([^\n]+)/);
  return m ? (ROLE_MARKERS[m[1].trim()] || m[1].trim()) : "unknown";
}
function schemaKind(body) {
  const req = body.output_config?.format?.schema?.required || [];
  if (req.includes("pass")) return "verdict";
  if (req.includes("steps")) return "brief";
  if (req.includes("items")) return "deliverable";
  return "text";
}
const USAGE = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 };
function msg(content, stop_reason = "end_turn", usage = USAGE, extra = {}) {
  return { status: 200, body: { id: "msg_" + Math.random().toString(36).slice(2), type: "message", role: "assistant", model: "fake",
    content, stop_reason, stop_sequence: null, usage, ...extra } };
}
const text = (t) => ({ type: "text", text: t });
function goodJson(body) {
  const kind = schemaKind(body);
  const role = roleOf(body);
  if (kind === "brief") return { objective: "Launch autumn menu", audience: "Commuters", keyMessages: ["Warm drinks"], platforms: ["x", "linkedin"],
    tone: "Warm", steps: [{ roleId: "writer", instructions: "Write posts for X and LinkedIn." }], successCriteria: ["Passes checks"] };
  if (kind === "verdict") return { pass: true, score: 9, issues: [], suggestions: ["Maybe add an emoji"] };
  if (role === "designer") return { summary: "Concepts", notes: "", items: [{ key: "x-visual", label: "X visual", platform: "x", kind: "visual_concept", text: "Steaming mug, 16:9." }] };
  return { summary: "Two posts", notes: "", items: [
    { key: "x-post", label: "X post", platform: "x", kind: "post", text: "Autumn is here at Pointo Cafe. Warm drinks for your commute. Visit us today! #autumn" },
    { key: "linkedin-post", label: "LinkedIn post", platform: "linkedin", kind: "post",
      text: "Autumn is here at Pointo Cafe.\n\nOur new seasonal drinks are made for busy commuters who want something warm and good on the way to work. Stop by this week and tell us your favourite.\n\nWhat is your go-to autumn drink? #autumn #coffee #commute" },
  ] };
}
const fake = {
  requests: [],
  handler: null, // (body, n, role) -> {status, body, headers} | null
  reset(h = null) { this.requests = []; this.handler = h; },
};
function defaultReply(body) { return msg([text(JSON.stringify(goodJson(body)))]); }
const fakeServer = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    let body = null;
    try { body = JSON.parse(raw); } catch { body = { _unparseable: raw }; }
    const entry = { method: req.method, url: req.url, headers: req.headers, body, role: roleOf(body || {}) };
    fake.requests.push(entry);
    const n = fake.requests.filter((r) => r.role === entry.role).length;
    let out = null;
    try { out = fake.handler ? await fake.handler(body, n, entry.role, entry) : null; } catch (e) { out = { status: 500, body: { type: "error", error: { type: "api_error", message: String(e) } } }; }
    if (!out) out = defaultReply(body);
    if (out.destroy) { req.socket.destroy(); return; }
    res.writeHead(out.status, { "content-type": "application/json", "request-id": "req_fake", ...(out.headers || {}) });
    res.end(JSON.stringify(out.body));
  });
});

// ------------------------------------------------------------------ app helpers
function startApp(extraEnv) {
  const port = rndPort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-agents-claude-"));
  const env = { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir, HANDOFF_MS: "0", QUIET: "1", ...extraEnv };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const child = spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const base = `http://127.0.0.1:${port}`;
  const app = {
    base, child, output: () => out,
    async ready() {
      for (let i = 0; i < 100; i++) {
        if (child.exitCode != null) throw new Error("server exited: " + out);
        try { const r = await fetch(base + "/api/state"); if (r.ok) return; } catch { /* not up */ }
        await sleep(100);
      }
      throw new Error("server did not start: " + out);
    },
    async req(method, p, body) {
      const r = await fetch(base + p, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text();
      let json = null; try { json = JSON.parse(t); } catch { /* not json */ }
      return { status: r.status, json, text: t };
    },
    async waitTask(id, statuses, ms = 20000) {
      const want = [].concat(statuses);
      const t0 = Date.now();
      let last;
      while (Date.now() - t0 < ms) {
        last = (await app.req("GET", `/api/tasks/${id}`)).json.task;
        if (want.includes(last.status)) return last;
        await sleep(50);
      }
      throw new Error(`task ${id} stuck in ${last && last.status} (wanted ${want}) error=${last && last.error}`);
    },
    async stop() { child.kill("SIGTERM"); await new Promise((r) => (child.exitCode != null ? r() : child.once("exit", r))); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
  return app;
}
const BRAND = { businessName: "Pointo Cafe", offering: "Specialty coffee", audience: "Busy commuters", voice: "Warm, upbeat",
  bannedWords: ["cheap", "best ever"], approvedClaims: ["Beans roasted in-house weekly"],
  competitors: [{ name: "BeanCo", url: "https://beanco.example.com" }], platforms: ["x", "linkedin"], goals: "More weekday visits" };
const SOCIAL = { title: "Autumn launch", description: "Launch our autumn menu", type: "social_post", platforms: ["x", "linkedin"], assignee: { mode: "manager" } };

function walkSchema(s, at, problems) {
  if (!s || typeof s !== "object") return;
  if (s.type === "object") {
    if (s.additionalProperties !== false) problems.push(`${at}: additionalProperties must be false`);
    const props = Object.keys(s.properties || {});
    const req = s.required || [];
    for (const p of props) if (!req.includes(p)) problems.push(`${at}: property ${p} not in required`);
    for (const p of props) walkSchema(s.properties[p], `${at}.${p}`, problems);
  }
  if (s.type === "array") walkSchema(s.items, `${at}[]`, problems);
}
function assertValidRequest(r, { workerModel = null } = {}) {
  const b = r.body;
  const where = `${r.role} request`;
  assert.equal(r.method, "POST", where);
  assert.equal(r.url.split("?")[0], "/v1/messages", where);
  const auth = r.headers["x-api-key"] || String(r.headers.authorization || "").replace(/^Bearer /, "");
  assert.equal(auth, FAKE_KEY, where + " API key header (x-api-key or Authorization: Bearer)");
  const expModel = (r.role === "research" || r.role === "analytics") && workerModel ? workerModel : "claude-opus-5-5";
  assert.equal(b.model, expModel, where + " model");
  assert.equal(b.max_tokens, 16000, where + " max_tokens");
  assert.deepEqual(b.thinking, { type: "adaptive" }, where + " thinking");
  for (const k of ["temperature", "top_p", "top_k", "budget_tokens", "stream", "tool_choice"]) assert.ok(!(k in b), `${where}: must not send ${k}`);
  assert.ok(!JSON.stringify(b).includes("budget_tokens"), where + " budget_tokens anywhere");
  assert.ok(b.output_config && ["low", "medium"].includes(b.output_config.effort), where + " effort " + JSON.stringify(b.output_config));
  if (b.output_config.format) {
    assert.equal(b.output_config.format.type, "json_schema", where);
    const problems = [];
    walkSchema(b.output_config.format.schema, "schema", problems);
    assert.deepEqual(problems, [], where + " schema");
  }
  assert.ok(Array.isArray(b.system) && b.system.length >= 1 && b.system.every((x) => x.type === "text"), where + " system array");
  assert.deepEqual(b.system.at(-1).cache_control, { type: "ephemeral" }, where + " cache_control on last system block");
  assert.ok(b.system.slice(0, -1).every((x) => !x.cache_control), where + " only one cache breakpoint in system");
  assert.ok(Array.isArray(b.messages) && b.messages[0].role === "user", where + " first message user");
  if (b.tools) {
    assert.deepEqual(b.tools, [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }], where + " tools");
  }
}

await new Promise((r) => fakeServer.listen(0, "127.0.0.1", r));
const FAKE_URL = `http://127.0.0.1:${fakeServer.address().port}`;
const LIVE_ENV = { ANTHROPIC_API_KEY: FAKE_KEY, ANTHROPIC_BASE_URL: FAKE_URL, MOCK: undefined, WORKER_MODEL: "claude-worker-qa", MODEL: undefined };

const app = startApp(LIVE_ENV);
try {
  await app.ready();
  await T("live mode is selected with a key and no MOCK; key never reaches the frontend", async () => {
    const st = (await app.req("GET", "/api/state")).json;
    assert.equal(st.mode, "live");
    for (const p of ["/api/state", "/", "/api/usage", "/api/roles"]) assert.ok(!(await app.req("GET", p)).text.includes(FAKE_KEY), p);
  });
  const team = (await app.req("POST", "/api/team/recommended", {})).json.team;
  const byRole = Object.fromEntries(team.map((m) => [m.roleId, m.id]));
  assert.equal((await app.req("PUT", "/api/brand", BRAND)).status, 200);

  // ---------------------------------------------------------------- 1. normal run
  let normalTask;
  await T("normal run: every request obeys SPEC Claude API rules; brief->writer->QA->awaiting_approval", async () => {
    fake.reset();
    const id = (await app.req("POST", "/api/tasks", SOCIAL)).json.task.id;
    normalTask = await app.waitTask(id, ["awaiting_approval", "failed"]);
    assert.equal(normalTask.status, "awaiting_approval", normalTask.error);
    const roles = fake.requests.map((r) => r.role);
    assert.deepEqual(roles, ["manager", "writer", "qa"]);
    for (const r of fake.requests) assertValidRequest(r, { workerModel: "claude-worker-qa" });
    const [mgr, wr, qa] = fake.requests;
    assert.equal(mgr.body.output_config.effort, "low", "brief uses low effort");
    assert.equal(schemaKind(mgr.body), "brief");
    assert.equal(schemaKind(wr.body), "deliverable");
    assert.equal(schemaKind(qa.body), "verdict");
    for (const r of fake.requests) {
      assert.equal(r.body.messages.length, 1, "no prefill / single user turn");
      assert.ok(!r.body.tools, "no tools for non-research roles");
      const sys = r.body.system.map((b) => b.text).join("\n");
      for (const s of ["Pointo Cafe", "Busy commuters", "Warm, upbeat", "cheap", "best ever", "Beans roasted in-house weekly", "BeanCo"]) assert.ok(sys.includes(s), `${r.role} system has brand kit field ${s}`);
      assert.ok(r.body.system.at(-1).text.includes("<brand_kit>"), "brand kit is the cached block");
    }
    const wsys = wr.body.system.map((b) => b.text).join("\n");
    for (const s of ["Hard limit: 280", "Hard limit: 3000", "never more than 30", "3-5 recommended", "1-2 recommended"]) assert.ok(wsys.includes(s), "writer platform skills: " + s);
    assert.ok(wr.body.messages[0].content.includes("Write posts for X and LinkedIn."), "brief instructions forwarded to writer");
    assert.equal(normalTask.verdict.score, 9);
    // usage: 3 calls x USAGE
    assert.equal(normalTask.usage.calls, 3);
    assert.equal(normalTask.usage.input_tokens, 300);
    assert.equal(normalTask.usage.output_tokens, 150);
    assert.equal(normalTask.usage.cache_read_input_tokens, 21);
    assert.equal(normalTask.usage.cache_creation_input_tokens, 9);
    const st = (await app.req("GET", "/api/state")).json;
    assert.equal(st.usage.byMember[byRole.writer].output_tokens, 50);
    assert.equal(st.usage.byRole.qa.calls, 1);
  });

  // ---------------------------------------------------------------- 2. research: web search + pause_turn
  await T("research: web_search_20260209 tool, no json format, pause_turn continuation, sources + web_search usage, WORKER_MODEL", async () => {
    const paused = [
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "coffee news" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [
        { type: "web_search_result", url: "https://news.example.com/a", title: "Coffee prices", encrypted_content: "x", page_age: null }] },
    ];
    fake.reset((body, n, role) => {
      if (role !== "research") return null;
      if (n === 1) return msg(paused, "pause_turn", { ...USAGE, server_tool_use: { web_search_requests: 1 } });
      return msg([text("## Key news\nPrices rose."), text(" More.\n## Competitor moves\n- none\n## Opportunities\n- post\n## Sources\n- https://news.example.com/a")],
        "end_turn", { ...USAGE, server_tool_use: { web_search_requests: 2 } });
    });
    const id = (await app.req("POST", "/api/tasks", { title: "Digest", description: "Weekly news", type: "news_digest", platforms: [], assignee: { mode: "member", memberId: byRole.research } })).json.task.id;
    const t = await app.waitTask(id, ["awaiting_approval", "failed"]);
    assert.equal(t.status, "awaiting_approval", t.error);
    const rr = fake.requests.filter((r) => r.role === "research");
    assert.equal(rr.length, 2);
    for (const r of rr) { assertValidRequest(r, { workerModel: "claude-worker-qa" }); assert.equal(r.body.model, "claude-worker-qa"); assert.ok(!r.body.output_config.format, "no json format for research"); }
    assert.deepEqual(rr[0].body.tools, [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }]);
    const m2 = rr[1].body.messages;
    assert.equal(m2.length, 2, "continuation appends assistant turn");
    assert.equal(m2[1].role, "assistant");
    assert.deepEqual(m2[1].content.map((b) => b.type), ["server_tool_use", "web_search_tool_result"]);
    const report = t.output.items.find((i) => i.kind === "report");
    assert.ok(report.text.includes("Prices rose. More."), "text blocks joined");
    assert.deepEqual(t.output.sources.map((s) => s.url), ["https://news.example.com/a"]);
    assert.equal(t.usage.web_search_requests, 3);
    const qa = fake.requests.find((r) => r.role === "qa");
    assert.equal(qa.body.model, "claude-opus-5-5", "QA uses main model");
  });

  await T("research digest failing QA is revised by the research agent; sources kept, revision request valid", async () => {
    fake.reset((body, n, role) => {
      if (role === "research" && !body.output_config.format) return msg([
        { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://news.example.com/b", title: "B" }] },
        text("## Key news\nThing.\n## Competitor moves\n-\n## Opportunities\n-\n## Sources\n- https://news.example.com/b")]);
      if (role === "qa" && n === 1) return msg([text(JSON.stringify({ pass: false, score: 5, issues: ["Report: add dates"], suggestions: [] }))]);
      return null; // research revision gets a schema -> default deliverable JSON
    });
    const id = (await app.req("POST", "/api/tasks", { title: "Digest 2", description: "news", type: "news_digest", platforms: [], assignee: { mode: "member", memberId: byRole.research } })).json.task.id;
    const t = await app.waitTask(id, ["awaiting_approval", "failed"]);
    assert.equal(t.status, "awaiting_approval", t.error);
    const rr = fake.requests.filter((r) => r.role === "research");
    assert.equal(rr.length, 2);
    assertValidRequest(rr[1], { workerModel: "claude-worker-qa" });
    assert.equal(schemaKind(rr[1].body), "deliverable");
    assert.deepEqual(t.output.sources.map((x) => x.url), ["https://news.example.com/b"]);
  });

  // ---------------------------------------------------------------- 3. refusal
  await T("refusal: writer step failed with clear message, task failed, usage still recorded, server alive", async () => {
    fake.reset((body, n, role) => role === "writer"
      ? msg([], "refusal", USAGE, { stop_details: { type: "refusal", category: "cyber", explanation: "Policy." } }) : null);
    const id = (await app.req("POST", "/api/tasks", SOCIAL)).json.task.id;
    const t = await app.waitTask(id, ["failed", "awaiting_approval"]);
    assert.equal(t.status, "failed");
    assert.match(t.error, /declined/i);
    const ws = t.steps.find((s) => s.kind === "work");
    assert.equal(ws.status, "failed");
    assert.equal(ws.stopReason, "refusal");
    assert.equal(t.usage.calls, 2, "manager + refused writer call counted");
    assert.equal(fake.requests.filter((r) => r.role === "qa").length, 0, "no QA after refusal");
  });

  // ---------------------------------------------------------------- 4. max_tokens on QA verdict & writer
  await T("max_tokens on QA (truncated JSON verdict): escalated to human with a warning, not crashed", async () => {
    fake.reset((body, n, role) => role === "qa" ? msg([text('{"pass": true, "score": 8, "issues": ["X po')], "max_tokens") : null);
    const id = (await app.req("POST", "/api/tasks", SOCIAL)).json.task.id;
    const t = await app.waitTask(id, ["failed", "awaiting_approval"]);
    assert.equal(t.status, "awaiting_approval");
    assert.equal(t.escalated, true);
    const qs = t.steps.find((s) => s.kind === "qa");
    assert.equal(qs.status, "failed");
    assert.equal(qs.stopReason, "max_tokens");
    assert.ok(t.warnings.length >= 1);
  });

  await T("max_tokens with complete JSON: deliverable kept, step marked truncated, truncation noted", async () => {
    fake.reset((body, n, role) => role === "writer" ? msg([text(JSON.stringify(goodJson(body)))], "max_tokens") : null);
    const id = (await app.req("POST", "/api/tasks", SOCIAL)).json.task.id;
    const t = await app.waitTask(id, ["failed", "awaiting_approval"]);
    assert.equal(t.status, "awaiting_approval", t.error);
    const ws = t.steps.find((s) => s.kind === "work");
    assert.equal(ws.truncated, true);
    assert.equal(ws.stopReason, "max_tokens");
    assert.match(t.output.notes, /truncated/i);
  });

  // ---------------------------------------------------------------- 5/6. HTTP errors
  await T("429 on brief: SDK retries (3 attempts), typed rate-limit error on task + agent, server alive", async () => {
    fake.reset((body, n, role) => role === "manager"
      ? { status: 429, headers: { "retry-after-ms": "5" }, body: { type: "error", error: { type: "rate_limit_error", message: "Slow down" } } } : null);
    const id = (await app.req("POST", "/api/tasks", SOCIAL)).json.task.id;
    const t = await app.waitTask(id, ["failed", "awaiting_approval"]);
    assert.equal(t.status, "failed");
    assert.match(t.error, /rate limit/i);
    assert.equal(fake.requests.filter((r) => r.role === "manager").length, 3, "1 + 2 SDK retries");
    const st = (await app.req("GET", "/api/state")).json;
    const mgr = st.team.find((m) => m.roleId === "manager");
    assert.match(String(mgr.lastError || ""), /rate limit/i, "error shown on the agent");
  });

  await T("500 on QA: SDK retries, typed api_error with status, task failed (no crash)", async () => {
    fake.reset((body, n, role) => role === "qa"
      ? { status: 500, headers: { "retry-after-ms": "5" }, body: { type: "error", error: { type: "api_error", message: "boom" } } } : null);
    const id = (await app.req("POST", "/api/tasks", SOCIAL)).json.task.id;
    const t = await app.waitTask(id, ["failed", "awaiting_approval"]);
    assert.equal(t.status, "failed");
    assert.match(t.error, /status 500/);
    assert.equal(fake.requests.filter((r) => r.role === "qa").length, 3);
  });

  await T("529 overloaded and 401 auth map to clear typed messages", async () => {
    fake.reset((body, n, role) => role === "manager" ? { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } } : null);
    let id = (await app.req("POST", "/api/tasks", SOCIAL)).json.task.id;
    let t = await app.waitTask(id, ["failed", "awaiting_approval"]);
    assert.match(t.error, /authentication failed/i);
    assert.equal(fake.requests.length, 1, "401 not retried");
    assert.ok(!t.error.includes(FAKE_KEY));
    fake.reset((body, n, role) => role === "manager" ? { status: 529, headers: { "retry-after-ms": "5" }, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } } : null);
    id = (await app.req("POST", "/api/tasks", SOCIAL)).json.task.id;
    t = await app.waitTask(id, ["failed", "awaiting_approval"]);
    assert.match(t.error, /overloaded/i);
  });

  await T("retry after a failure re-runs the task to awaiting_approval", async () => {
    fake.reset((body, n, role) => role === "manager" && n === 1 ? { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "bad" } } } : null);
    const id = (await app.req("POST", "/api/tasks", SOCIAL)).json.task.id;
    let t = await app.waitTask(id, ["failed", "awaiting_approval"]);
    assert.equal(t.status, "failed");
    assert.match(t.error, /rejected the request/);
    assert.equal((await app.req("POST", `/api/tasks/${id}/retry`, {})).status, 200);
    t = await app.waitTask(id, ["awaiting_approval", "failed"]);
    assert.equal(t.status, "awaiting_approval", t.error);
  });

  // ---------------------------------------------------------------- 7. malformed verdict / brief
  await T("malformed QA verdict JSON: escalated to human approval with warning", async () => {
    fake.reset((body, n, role) => role === "qa" ? msg([text("Looks great, ship it! 9/10")]) : null);
    const id = (await app.req("POST", "/api/tasks", SOCIAL)).json.task.id;
    const t = await app.waitTask(id, ["failed", "awaiting_approval"]);
    assert.equal(t.status, "awaiting_approval");
    assert.equal(t.escalated, true);
    assert.equal(t.verdict, null);
  });

  await T("verdict schema-shaped but wrong types (pass:'yes') is not treated as a pass", async () => {
    fake.reset((body, n, role) => role === "qa" ? msg([text(JSON.stringify({ pass: "yes", score: 10, issues: [], suggestions: [] }))]) : null);
    const id = (await app.req("POST", "/api/tasks", SOCIAL)).json.task.id;
    const t = await app.waitTask(id, ["failed", "awaiting_approval"]);
    assert.equal(t.status, "awaiting_approval");
    assert.ok(t.escalated === true && !(t.verdict && t.verdict.pass === true));
  });

  await T("QA fail -> revision request carries issues, keeps rules (no prefill), passes on round 2", async () => {
    fake.reset((body, n, role) => {
      if (role === "qa" && n === 1) return msg([text(JSON.stringify({ pass: false, score: 4, issues: ["X post: add a CTA"], suggestions: [] }))]);
      return null;
    });
    const id = (await app.req("POST", "/api/tasks", SOCIAL)).json.task.id;
    const t = await app.waitTask(id, ["failed", "awaiting_approval"]);
    assert.equal(t.status, "awaiting_approval", t.error);
    const revs = fake.requests.filter((r) => r.role === "writer");
    assert.equal(revs.length, 2);
    assertValidRequest(revs[1]);
    assert.equal(revs[1].body.messages.length, 1);
    assert.ok(revs[1].body.messages[0].content.includes("X post: add a CTA"));
    assert.equal(schemaKind(revs[1].body), "deliverable");
    assert.equal(t.totalRevisions, 1);
  });

  await T("malformed brief JSON: default routing used with a warning", async () => {
    fake.reset((body, n, role) => role === "manager" ? msg([text("not json at all")]) : null);
    const id = (await app.req("POST", "/api/tasks", SOCIAL)).json.task.id;
    const t = await app.waitTask(id, ["failed", "awaiting_approval"]);
    assert.equal(t.status, "awaiting_approval", t.error);
    assert.ok(t.warnings.some((w) => /brief/i.test(w)));
    assert.ok(fake.requests.some((r) => r.role === "writer"));
  });

  // ---------------------------------------------------------------- 8. cancel mid-request
  await T("cancel while a Claude request is in flight aborts it; status cancelled; server alive", async () => {
    fake.reset(async (body, n, role) => { if (role === "writer") { await sleep(3000); } return null; });
    const id = (await app.req("POST", "/api/tasks", SOCIAL)).json.task.id;
    for (let i = 0; i < 100 && !fake.requests.some((r) => r.role === "writer"); i++) await sleep(30);
    assert.equal((await app.req("POST", `/api/tasks/${id}/cancel`, {})).status, 200);
    const t = await app.waitTask(id, ["cancelled"], 3000);
    assert.equal(t.status, "cancelled");
    await sleep(200);
    assert.equal((await app.req("GET", `/api/tasks/${id}`)).json.task.status, "cancelled");
  });

  // ---------------------------------------------------------------- findings probes (expected to FAIL until fixed)
  await T("[agents-claude-01] non-JSON fallback draft for an X-only task must still get the 280-char hard-limit check", async () => {
    const long = "Autumn at Pointo Cafe " + "is warm and cosy and full of seasonal flavour for you ".repeat(8) + "Visit us! #autumn";
    fake.reset((body, n, role) => {
      if (role === "writer") return msg([text(long)]);
      if (role === "manager") return msg([text(JSON.stringify({ ...goodJson(body), platforms: ["x"] }))]);
      return null;
    });
    const id = (await app.req("POST", "/api/tasks", { ...SOCIAL, platforms: ["x"] })).json.task.id;
    const t = await app.waitTask(id, ["failed", "awaiting_approval"]);
    const item = t.output.items[0];
    assert.equal(item.platform, "x");
    assert.ok([...item.text].length > 280);
    const errs = (t.checks?.results || []).filter((r) => r.level === "error");
    assert.ok(errs.some((e) => /280/.test(e.message)), `expected a 280-char hard-limit error for ${[...item.text].length}-char X text (kind=${item.kind}); got: ${JSON.stringify(t.checks?.results)}`);
  });

  await T("[agents-claude-01b] a JSON X item the model labels kind \"other\" must still get the 280-char hard-limit check", async () => {
    const long = "Autumn at Pointo Cafe " + "is warm and cosy and full of seasonal flavour for you ".repeat(8) + "Visit us! #autumn";
    fake.reset((body, n, role) => role === "writer"
      ? msg([text(JSON.stringify({ summary: "X post", notes: "", items: [{ key: "x-post", label: "X post", platform: "x", kind: "other", text: long }] }))]) : null);
    const id = (await app.req("POST", "/api/tasks", { ...SOCIAL, platforms: ["x"] })).json.task.id;
    const t = await app.waitTask(id, ["failed", "awaiting_approval"]);
    const errs = (t.checks?.results || []).filter((r) => r.level === "error");
    assert.ok(errs.some((e) => /280/.test(e.message)), `no hard-limit error for ${[...long].length}-char X item of kind other; checks: ${JSON.stringify(t.checks?.results)}`);
  });

  await T("[agents-claude-03] QA reviewer (rubric: platform fit) gets the per-platform rules in its system prompt", async () => {
    fake.reset();
    const id = (await app.req("POST", "/api/tasks", SOCIAL)).json.task.id;
    await app.waitTask(id, ["failed", "awaiting_approval"]);
    const q = fake.requests.find((r) => r.role === "qa");
    const sys = q.body.system.map((b) => b.text).join("\n");
    for (const s of ["Hard limit: 280", "3-5 recommended", "first 125-150"]) assert.ok(sys.includes(s), `QA system prompt lacks platform rule "${s}"`);
  });

  await T("[agents-claude-02] max_tokens mid-JSON deliverable must not be shown as a post of raw JSON", async () => {
    fake.reset((body, n, role) => role === "writer"
      ? msg([text('{"summary":"Two posts","notes":"","items":[{"key":"x-post","label":"X post","platform":"x","kind":"post","text":"Autumn is he')], "max_tokens") : null);
    const id = (await app.req("POST", "/api/tasks", SOCIAL)).json.task.id;
    const t = await app.waitTask(id, ["failed", "awaiting_approval"]);
    const raw = (t.output?.items || []).find((i) => i.text.trim().startsWith('{"summary"'));
    assert.ok(!raw, `a truncated JSON fragment reached the output as item "${raw && raw.key}" (status ${t.status}): ${raw && raw.text}`);
  });

  await T("server survived every scenario", async () => {
    assert.equal(app.child.exitCode, null);
    assert.equal((await app.req("GET", "/api/state")).status, 200);
    assert.ok(!/Unhandled|Uncaught/.test(app.output()), app.output());
  });
} finally {
  await app.stop();
}

// ------------------------------------------------------------------ mock mode shares the pipeline, never calls the API
const mockApp = startApp({ ...LIVE_ENV, MOCK: "1", MOCK_DELAY_MS: "10" });
try {
  await mockApp.ready();
  await T("MOCK=1 with a key present: mode mock, same pipeline states, zero API requests", async () => {
    fake.reset();
    assert.equal((await mockApp.req("GET", "/api/state")).json.mode, "mock");
    await mockApp.req("POST", "/api/team/recommended", {});
    await mockApp.req("PUT", "/api/brand", BRAND);
    const id = (await mockApp.req("POST", "/api/tasks", SOCIAL)).json.task.id;
    const t = await mockApp.waitTask(id, ["awaiting_approval", "failed"]);
    assert.equal(t.status, "awaiting_approval", t.error);
    const kinds = t.steps.map((s) => s.kind);
    for (const k of ["brief", "work", "checks", "qa"]) assert.ok(kinds.includes(k), k);
    assert.ok(t.usage.input_tokens > 0);
    assert.equal(fake.requests.length, 0, "mock mode must not call the API");
  });
} finally {
  await mockApp.stop();
}
fakeServer.close();
console.log(`\n${passed} passed, ${failed} failed${failed ? ": " + failures.join(" | ") : ""}`);
process.exit(failed ? 1 : 0);
