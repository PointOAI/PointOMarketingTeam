// QA "api-backend" suite: HTTP API & backend robustness for server.js.
//
//   node tests/qa-api-backend.test.mjs            # run everything
//   node tests/qa-api-backend.test.mjs cancel     # only tests whose name contains "cancel"
//
// No API key needed. Two kinds of servers are used:
//   * in-process startServer({ engine }) with a SCRIPTED engine (deterministic, gateable engine calls) to drive
//     the state machine into every stage (cancel at each stage, revision cap, reject loops, restart mid-task);
//   * startServer with the real demo engine (MOCK=1) and a spawned `MOCK=1 node server.js` child process for
//     black-box robustness (malformed HTTP, SIGKILL restart, corrupt state.json).
// Tests named "[api-backend-NNN]" assert the EXPECTED behaviour of a reported finding, so they fail until fixed.
// Exit code: 0 when every test passes, 1 otherwise.
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "server.js");
const { startServer } = await import(SERVER);

// ------------------------------------------------------------------ tiny harness
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
class AssertError extends Error {}
function ok(cond, msg) { if (!cond) throw new AssertError(msg); }
function eq(a, b, msg) { if (a !== b) throw new AssertError(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 8000, what = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > end) throw new AssertError(`timeout waiting for ${what}`);
    await sleep(15);
  }
}
const tmpDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `qa-api-${tag}-`));

// ------------------------------------------------------------------ HTTP helpers
function request(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const h = { ...(data !== null ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers };
    const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on("error", reject);
    if (data !== null) r.write(data);
    r.end();
  });
}
function rawSend(port, payload, waitMs = 400) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    let out = "";
    s.on("data", (d) => { out += d.toString("latin1"); });
    s.on("error", () => {});
    s.on("connect", () => { s.write(payload); });
    setTimeout(() => { s.destroy(); resolve(out); }, waitMs);
  });
}
function sse(port, headers = {}) {
  const c = { events: [], closed: false };
  const r = http.get({ host: "127.0.0.1", port, path: "/api/events", headers, agent: false }, (res) => {
    c.status = res.statusCode; c.headers = res.headers;
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = {};
        for (const line of block.split("\n")) {
          if (line.startsWith("id: ")) ev.id = Number(line.slice(4));
          else if (line.startsWith("event: ")) ev.type = line.slice(7);
          else if (line.startsWith("data: ")) ev.data = JSON.parse(line.slice(6));
          else if (line.startsWith("retry: ")) ev.retry = Number(line.slice(7));
        }
        c.events.push(ev);
      }
    });
    res.on("close", () => { c.closed = true; });
  });
  r.on("error", () => { c.closed = true; });
  c.close = () => r.destroy();
  return c;
}

// ------------------------------------------------------------------ scripted engine
// Every call is recorded. A method can be "held": its calls wait until released (or until aborted, unless the
// engine is told to ignore aborts, simulating an HTTP call that does not stop immediately).
function scriptedEngine() {
  const usage = { input_tokens: 10, output_tokens: 5, calls: 1 };
  const eng = { mode: "mock", calls: [], held: new Set(), pending: [], ignoreAbort: false, script: {} };
  const defaults = {
    writeBrief: () => ({ ok: true, data: { objective: "o", steps: [{ roleId: "writer", instructions: "write" }] }, usage, stopReason: "end_turn" }),
    doWork: (a) => ({ ok: true, data: { summary: "draft", items: [{ key: "x-post", label: "X post", platform: "x", kind: "post",
      text: `Fresh draft for ${a.task.title}. Learn more today.` }], notes: "", sources: [] }, usage, stopReason: "end_turn" }),
    review: () => ({ ok: true, data: { pass: true, score: 9, issues: [], suggestions: [] }, usage, stopReason: "end_turn" }),
    revise: (a) => ({ ok: true, data: { ...a.output, items: a.output.items.map((i) => ({ ...i, text: i.text + (a.feedback ? ` [fb:${a.feedback}]` : " [rev]") })) }, usage, stopReason: "end_turn" }),
  };
  for (const m of ["writeBrief", "doWork", "review", "revise"]) {
    eng[m] = async (args) => {
      const call = { method: m, args, settled: false };
      eng.calls.push(call);
      if (eng.held.has(m)) {
        const released = await new Promise((resolve) => {
          const p = { method: m, call, release: (v) => resolve(v ?? true) };
          eng.pending.push(p);
          if (!eng.ignoreAbort) args.signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
        });
        if (released === "aborted") { call.settled = true; return { ok: false, error: { code: "cancelled", message: "Cancelled.", retryable: false }, usage: null }; }
      }
      call.settled = true;
      return (eng.script[m] || defaults[m])(args, call);
    };
  }
  eng.hold = (m) => eng.held.add(m);
  eng.unhold = (m) => eng.held.delete(m);
  eng.waitPending = (m, n = 1) => until(() => eng.pending.filter((p) => p.method === m).length >= n && eng.pending.filter((p) => p.method === m), 8000, `pending ${m}`);
  eng.releaseAll = () => { for (const p of eng.pending.splice(0)) p.release(); };
  return eng;
}

async function boot({ engine = scriptedEngine(), env = {}, dataDir = tmpDir("data") } = {}) {
  const app = await startServer({ port: 0, dataDir, engine, quiet: true,
    env: { MOCK: "1", MOCK_DELAY_MS: "10", HANDOFF_MS: "0", QUIET: "1", ...env } });
  const call = (method, p, body, headers) => request(app.port, method, p, body, headers);
  const get = async (id) => (await call("GET", `/api/tasks/${id}`)).json.task;
  return { app, engine, dataDir, call, get, port: app.port };
}
async function hire(s, ...roles) {
  const out = {};
  for (const r of roles) { const x = await s.call("POST", "/api/team", { roleId: r }); eq(x.status, 201, `hire ${r}`); out[r] = x.json.member; }
  return out;
}
async function newTask(s, extra = {}) {
  const x = await s.call("POST", "/api/tasks", { title: extra.title || "Spring launch", type: "social_post", platforms: ["x"], ...extra });
  eq(x.status, 201, `create task (${x.text.slice(0, 120)})`);
  return x.json.task;
}
const waitStatus = (s, id, status, ms) => until(async () => { const t = await s.get(id); return t.status === status && t; }, ms, `task ${id} -> ${status}`);
function assertCancelledClean(t, team) {
  eq(t.status, "cancelled", "status");
  ok(!t.steps.some((st) => st.status === "running"), "no step left running after cancel");
  ok(t.finishedAt, "finishedAt set");
  for (const m of team) ok(m.currentTaskId !== t.id, `member ${m.roleId} still shows the cancelled task (${m.status})`);
}

// ================================================================== 1. input validation
test("endpoints reject invalid / missing / wrong-type / oversized input with 4xx, never 5xx", async () => {
  const s = await boot();
  try {
    const W = (await hire(s, "writer")).writer;
    const cases = [
      ["POST", "/api/team", {}, 400], ["POST", "/api/team", { roleId: 5 }, 400], ["POST", "/api/team", { roleId: "ceo" }, 400],
      ["POST", "/api/team", { roleId: "__proto__" }, 400], ["POST", "/api/team", { roleId: "constructor" }, 400],
      ["POST", "/api/team", { roleId: "seo", name: "" }, 400], ["POST", "/api/team", { roleId: "seo", name: "   " }, 400],
      ["POST", "/api/team", { roleId: "seo", name: "x".repeat(41) }, 400], ["POST", "/api/team", { roleId: "seo", name: 7 }, 400],
      ["POST", "/api/team", { roleId: "writer" }, 409],
      ["POST", "/api/team", "[]", 400], ["POST", "/api/team", "null", 400], ["POST", "/api/team", '"str"', 400],
      ["POST", "/api/team", "{bad json", 400], ["POST", "/api/team", "1e999", 400],
      ["PATCH", `/api/team/${W.id}`, {}, 400], ["PATCH", `/api/team/${W.id}`, { name: ["a"] }, 400],
      ["PATCH", "/api/team/m_ffffffffff", { name: "a" }, 404], ["DELETE", "/api/team/m_ffffffffff", undefined, 404],
      ["DELETE", "/api/team/../../etc", undefined, 404],
      ["PUT", "/api/brand", { businessName: 5 }, 400], ["PUT", "/api/brand", { bannedWords: "x" }, 400],
      ["PUT", "/api/brand", { bannedWords: [1] }, 400], ["PUT", "/api/brand", { bannedWords: Array.from({ length: 101 }, (_, i) => `w${i}`) }, 400],
      ["PUT", "/api/brand", { competitors: [{ name: "A", url: "javascript:alert(1)" }] }, 400],
      ["PUT", "/api/brand", { competitors: [{ name: "A", url: "not a url" }] }, 400], ["PUT", "/api/brand", { competitors: [{}] }, 400],
      ["PUT", "/api/brand", { competitors: {} }, 400], ["PUT", "/api/brand", { platforms: ["myspace"] }, 400],
      ["PUT", "/api/brand", { goals: "g".repeat(2001) }, 400], ["PUT", "/api/brand", { learnings: "x" }, 400],
      ["POST", "/api/tasks", {}, 400], ["POST", "/api/tasks", { title: "t" }, 400], ["POST", "/api/tasks", { title: "t", type: "nope" }, 400],
      ["POST", "/api/tasks", { title: "", type: "custom" }, 400], ["POST", "/api/tasks", { title: "\u0000\u0001", type: "custom" }, 400],
      ["POST", "/api/tasks", { title: "x".repeat(121), type: "custom" }, 400], ["POST", "/api/tasks", { title: ["t"], type: "custom" }, 400],
      ["POST", "/api/tasks", { title: "t", type: "custom", description: "d".repeat(4001) }, 400],
      ["POST", "/api/tasks", { title: "t", type: "custom", platforms: "x" }, 400], ["POST", "/api/tasks", { title: "t", type: "custom", platforms: [{}] }, 400],
      ["POST", "/api/tasks", { title: "t", type: "custom", assignee: "manager" }, 400],
      ["POST", "/api/tasks", { title: "t", type: "custom", assignee: { mode: "ceo" } }, 400],
      ["POST", "/api/tasks", { title: "t", type: "custom", assignee: { mode: "member", memberId: "m_ffffffffff" } }, 400],
      ["POST", "/api/tasks", { title: "t", type: "toString" }, 400],
      ["PUT", "/api/settings", { maxConcurrent: 0 }, 400], ["PUT", "/api/settings", { maxConcurrent: 6 }, 400],
      ["PUT", "/api/settings", { maxConcurrent: 1.5 }, 400], ["PUT", "/api/settings", { maxConcurrent: "2" }, 400],
      ["PUT", "/api/settings", { dailyDigest: "yes" }, 400],
      ["GET", "/api/tasks/t_ffffffffff", undefined, 404], ["POST", "/api/tasks/t_ffffffffff/cancel", {}, 404],
      ["POST", "/api/tasks/t_ffffffffff/approve", {}, 404], ["GET", "/api/tasks/T_FFFFFFFFFF", undefined, 404],
      ["POST", "/api/digest/run", {}, 409],
    ];
    for (const [m, p, b, want] of cases) {
      const r = await s.call(m, p, b);
      eq(r.status, want, `${m} ${p} ${JSON.stringify(b)?.slice(0, 60)}`);
      ok(r.json && typeof r.json.error === "string", `${m} ${p}: JSON error body`);
    }
    // wrong content types / sizes
    eq((await s.call("POST", "/api/team", '{"roleId":"seo"}', { "content-type": "text/plain" })).status, 415, "text/plain body -> 415");
    eq((await s.call("POST", "/api/team", "x".repeat(1048577), { "content-type": "application/json" })).status, 413, "1 MB + 1 -> 413");
    eq((await s.call("POST", "/api/team", undefined, { "content-type": "application/json", "content-length": "99999999" })).status, 413, "declared huge -> 413");
    // deeply nested JSON just under the limit must not blow the stack
    const deep = '{"x":' + "[".repeat(400000) + "]".repeat(400000) + "}";
    const r = await s.call("PUT", "/api/brand", deep);
    ok(r.status < 500, `deep nesting handled (${r.status})`);
    eq((await s.call("GET", "/healthz")).status, 200, "server alive");
  } finally { await s.app.close(); }
});

test("unknown routes, wrong methods, odd paths -> 404/405 with JSON, never 5xx", async () => {
  const s = await boot();
  try {
    for (const p of ["/nope", "/api", "/api/", "/api/state/", "/api/tasks/", "/api/team/x", "/api/tasks/t_0123456789/nope",
      "/api/%74asks", "/%2e%2e/server.js", "/server.js", "/api/tasks/t_0123456789/export/", "/API/STATE"]) {
      const r = await s.call("GET", p);
      eq(r.status, 404, `GET ${p}`);
    }
    for (const [m, p] of [["DELETE", "/api/state"], ["POST", "/"], ["PUT", "/api/tasks"], ["GET", "/api/team"], ["HEAD", "/"], ["OPTIONS", "/api/tasks"]]) {
      const r = await s.call(m, p);
      eq(r.status, 405, `${m} ${p}`);
      ok(r.headers.allow, `${m} ${p} Allow header`);
    }
    const raw = await rawSend(s.port, "GET http://x/ HTTP/1.1\r\nHost: x\r\n\r\n");
    ok(/^HTTP\/1\.1 400/.test(raw), "absolute-form URL -> 400");
    const raw2 = await rawSend(s.port, "\x00\x01garbage\r\n\r\n");
    ok(/^HTTP\/1\.1 400/.test(raw2), "binary garbage -> 400");
    const raw3 = await rawSend(s.port, "POST /api/team HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n");
    ok(/^HTTP\/1\.1 400/.test(raw3), "CL+TE smuggling attempt -> 400");
    eq((await s.call("GET", "/healthz")).status, 200, "alive");
  } finally { await s.app.close(); }
});

// ================================================================== 2. concurrency & queueing
test("concurrency limit is enforced, queue is FIFO, awaiting_approval frees the slot, raising the limit starts more", async () => {
  const s = await boot();
  try {
    await hire(s, "writer");
    eq((await s.call("PUT", "/api/settings", { maxConcurrent: 1 })).status, 200, "settings");
    s.engine.hold("doWork");
    const t1 = await newTask(s, { title: "A" }), t2 = await newTask(s, { title: "B" }), t3 = await newTask(s, { title: "C" });
    await s.engine.waitPending("doWork", 1);
    await sleep(100);
    eq(s.engine.pending.length, 1, "only one engine call in flight with maxConcurrent=1");
    const st = (await s.call("GET", "/api/state")).json;
    eq(st.queue.running.length, 1, "running=1");
    eq(st.queue.queued.join(), [t2.id, t3.id].join(), "FIFO queue");
    eq(s.engine.pending[0].call.args.task.id, t1.id, "oldest first");
    eq((await s.call("PUT", "/api/settings", { maxConcurrent: 3 })).status, 200, "raise limit");
    await s.engine.waitPending("doWork", 3);
    s.engine.unhold("doWork"); s.engine.releaseAll();
    for (const t of [t1, t2, t3]) await waitStatus(s, t.id, "awaiting_approval");
    const st2 = (await s.call("GET", "/api/state")).json;
    eq(st2.queue.running.length, 0, "awaiting tasks hold no slot");
  } finally { await s.app.close(); }
});

// ================================================================== 3. cancel at every stage
async function cancelScenario(name, { roles, hold, prepare, after }) {
  const s = await boot({ env: name === "handoff" ? { HANDOFF_MS: "60000" } : {} });
  try {
    await hire(s, ...roles);
    await s.call("PUT", "/api/settings", { maxConcurrent: 1 });
    if (hold) s.engine.hold(hold);
    const t = await prepare(s);
    const writer = (await s.call("GET", "/api/state")).json.team.find((m) => m.roleId === "writer");
    // assigned directly to the writer: no brief, no hand-off walk, so it is not slowed by the scenario's settings
    const next = await newTask(s, { title: "Next in queue", assignee: { mode: "member", memberId: writer.id } });
    const c = await s.call("POST", `/api/tasks/${t.id}/cancel`, {});
    eq(c.status, 200, `cancel (${name}) -> 200: ${c.text.slice(0, 100)}`);
    const team = (await s.call("GET", "/api/state")).json.team;
    assertCancelledClean(c.json.task, team);
    const stepsAfterCancel = c.json.task.steps.length;
    // the slot is freed: the next queued task runs to completion
    s.engine.unhold(hold); s.engine.held.clear();
    s.engine.releaseAll();
    await waitStatus(s, next.id, "awaiting_approval");
    await sleep(150);
    const t2 = await s.get(t.id);
    eq(t2.status, "cancelled", `still cancelled after the in-flight call settled (${name})`);
    eq(t2.steps.length, stepsAfterCancel, `stale run added no steps (${name})`);
    eq((await s.call("POST", `/api/tasks/${t.id}/cancel`, {})).status, 409, "second cancel -> 409");
    if (after) await after(s, t);
    const final = (await s.call("GET", "/api/state")).json;
    eq(final.queue.running.length, 0, "no running tasks at end");
    for (const m of final.team) ok(m.status !== "working" && m.status !== "reviewing", `member ${m.roleId} idle at end (${m.status})`);
  } finally { await s.app.close(); }
}
test("cancel while queued", () => cancelScenario("queued", { roles: ["writer"], hold: "doWork", prepare: async (s) => {
  const blocker = await newTask(s, { title: "Blocker" }); await s.engine.waitPending("doWork");
  const t = await newTask(s, { title: "Queued one" }); eq((await s.get(t.id)).status, "queued", "queued"); void blocker; return t;
} }));
test("cancel while briefing (manager call in flight)", () => cancelScenario("briefing", { roles: ["manager", "writer"], hold: "writeBrief", prepare: async (s) => {
  const t = await newTask(s); await s.engine.waitPending("writeBrief"); eq((await s.get(t.id)).status, "briefing", "briefing"); return t;
} }));
test("cancel during a hand-off walk (HANDOFF_MS sleep)", () => cancelScenario("handoff", { roles: ["manager", "writer"], prepare: async (s) => {
  const t = await newTask(s);
  await until(async () => (await s.get(t.id)).status === "in_progress", 8000, "in_progress (handing off)");
  ok(!s.engine.calls.some((c) => c.method === "doWork"), "writer has not started yet"); return t;
} }));
test("cancel while in_progress (work call in flight)", () => cancelScenario("in_progress", { roles: ["writer"], hold: "doWork", prepare: async (s) => {
  const t = await newTask(s); await s.engine.waitPending("doWork"); eq((await s.get(t.id)).status, "in_progress", "in_progress"); return t;
} }));
test("cancel while qa_review", () => cancelScenario("qa_review", { roles: ["writer", "qa"], hold: "review", prepare: async (s) => {
  const t = await newTask(s); await s.engine.waitPending("review"); eq((await s.get(t.id)).status, "qa_review", "qa_review"); return t;
} }));
test("cancel while revision (automated)", () => cancelScenario("revision", { roles: ["writer", "qa"], hold: "revise", prepare: async (s) => {
  s.engine.script.review = () => ({ ok: true, data: { pass: false, score: 3, issues: ["weak"], suggestions: [] }, usage: null });
  const t = await newTask(s); await s.engine.waitPending("revise"); eq((await s.get(t.id)).status, "revision", "revision");
  s.engine.script.review = null; return t;
} }));
test("cancel while awaiting_approval, then retry restarts the pipeline", () => cancelScenario("awaiting", { roles: ["writer"], prepare: async (s) => {
  const t = await newTask(s); await waitStatus(s, t.id, "awaiting_approval"); return t;
}, after: async (s, t) => {
  const r = await s.call("POST", `/api/tasks/${t.id}/retry`, {}); eq(r.status, 200, "retry");
  await waitStatus(s, t.id, "awaiting_approval");
} }));
test("cancel a feedback revision that is queued and one that is in flight", async () => {
  await cancelScenario("feedback-queued", { roles: ["writer"], hold: "doWork", prepare: async (s) => {
    s.engine.unhold("doWork");
    const t = await newTask(s); await waitStatus(s, t.id, "awaiting_approval");
    s.engine.hold("doWork");
    const blocker = await newTask(s, { title: "Blocker" }); await s.engine.waitPending("doWork"); void blocker;
    eq((await s.call("POST", `/api/tasks/${t.id}/reject`, { feedback: "shorter" })).status, 200, "reject");
    eq((await s.get(t.id)).status, "queued", "feedback revision queued"); return t;
  } });
  await cancelScenario("feedback-inflight", { roles: ["writer"], hold: "revise", prepare: async (s) => {
    const t = await newTask(s); await waitStatus(s, t.id, "awaiting_approval");
    eq((await s.call("POST", `/api/tasks/${t.id}/reject`, { feedback: "shorter" })).status, 200, "reject");
    await s.engine.waitPending("revise"); eq((await s.get(t.id)).status, "revision", "revision"); return t;
  } });
});
test("cancel -> retry while the old engine call ignores the abort: stale result never leaks into the new run", async () => {
  const s = await boot();
  try {
    await hire(s, "writer");
    s.engine.ignoreAbort = true;
    s.engine.hold("doWork");
    const t = await newTask(s);
    const [first] = await s.engine.waitPending("doWork");
    eq((await s.call("POST", `/api/tasks/${t.id}/cancel`, {})).status, 200, "cancel");
    eq((await s.call("POST", `/api/tasks/${t.id}/retry`, {})).status, 200, "retry");
    await s.engine.waitPending("doWork", 2);
    s.engine.script.doWork = (a, call) => ({ ok: true, data: { summary: "s", items: [{ key: "x-post", label: "X", platform: "x", kind: "post",
      text: call === first.call ? "STALE output from the cancelled run. Learn more." : "NEW output from the retried run. Learn more." }] }, usage: null });
    first.release();
    await sleep(100);
    s.engine.unhold("doWork"); s.engine.releaseAll();
    const done = await waitStatus(s, t.id, "awaiting_approval");
    ok(done.output.items[0].text.startsWith("NEW"), `output is from the retried run: ${done.output.items[0].text}`);
    eq(done.steps.filter((st) => st.kind === "work" && st.status === "done").length, 1, "exactly one completed work step");
  } finally { await s.app.close(); }
});

// ================================================================== 4. state machine: revision cap & reject loops
test("QA keeps failing -> exactly 2 automated revisions, then escalated to awaiting_approval", async () => {
  const s = await boot();
  try {
    await hire(s, "writer", "qa");
    s.engine.script.review = () => ({ ok: true, data: { pass: false, score: 4, issues: ["Too vague"], suggestions: ["Add a number"] }, usage: null });
    const t = await newTask(s);
    const done = await waitStatus(s, t.id, "awaiting_approval");
    eq(done.revisionRound, 2, "revisionRound");
    eq(done.totalRevisions, 2, "totalRevisions");
    eq(s.engine.calls.filter((c) => c.method === "revise").length, 2, "revise calls");
    eq(s.engine.calls.filter((c) => c.method === "review").length, 3, "review calls");
    ok(done.escalated, "escalated");
    ok(done.warnings.some((w) => w.startsWith("QA review still fails after 2 revisions")), "escalation warning");
    const issues = s.engine.calls.find((c) => c.method === "revise").args.issues;
    ok(issues.includes("Too vague") && issues.includes("Add a number"), "QA issues + suggestions fed to revision");
  } finally { await s.app.close(); }
});
test("checks keep failing (banned word) -> 2 revisions with check errors as issues, escalated, QA skipped", async () => {
  const s = await boot();
  try {
    await hire(s, "writer", "qa");
    await s.call("PUT", "/api/brand", { bannedWords: ["guaranteed"] });
    s.engine.script.doWork = () => ({ ok: true, data: { items: [{ key: "x-post", label: "X post", platform: "x", kind: "post", text: "Guaranteed results. Learn more." }] }, usage: null });
    s.engine.script.revise = (a) => ({ ok: true, data: a.output, usage: null });
    const t = await newTask(s);
    const done = await waitStatus(s, t.id, "awaiting_approval");
    eq(s.engine.calls.filter((c) => c.method === "revise").length, 2, "revise calls");
    eq(s.engine.calls.filter((c) => c.method === "review").length, 0, "QA never called while checks fail");
    ok(s.engine.calls.find((c) => c.method === "revise").args.issues.some((i) => /banned/.test(i)), "check error passed as issue");
    ok(done.escalated && done.warnings.some((w) => w.startsWith("Automated checks still fail")), "escalated with warning");
  } finally { await s.app.close(); }
});
test("reject -> feedback revision (no round++) -> up to 2 more automated rounds; repeated rejects loop correctly", async () => {
  const s = await boot();
  try {
    await hire(s, "writer", "qa");
    s.engine.script.review = () => ({ ok: true, data: { pass: false, score: 4, issues: ["meh"], suggestions: [] }, usage: null });
    const t = await newTask(s);
    await waitStatus(s, t.id, "awaiting_approval");
    for (let round = 1; round <= 2; round++) {
      const r = await s.call("POST", `/api/tasks/${t.id}/reject`, { feedback: `make it punchier ${round}` });
      eq(r.status, 200, "reject"); eq(r.json.task.status, "queued", "queued after reject");
      ok(r.json.task.pendingFeedbackRevision, "pendingFeedbackRevision");
      const done = await waitStatus(s, t.id, "awaiting_approval");
      eq(done.totalRevisions, 2 + round * 3, `totalRevisions after reject #${round}`);
      eq(done.revisionRound, 2, "round capped at 2 again");
      eq(done.pendingFeedbackRevision, false, "pending cleared");
      const fb = s.engine.calls.filter((c) => c.method === "revise" && c.args.feedback);
      eq(fb.length, round, "feedback revisions so far");
      eq(fb.at(-1).args.feedback, `make it punchier ${round}`, "feedback text passed");
      eq(fb.at(-1).args.issues.length, 0, "feedback revision has no automated issues");
    }
    eq(s.engine.calls.filter((c) => c.method === "writeBrief" || c.method === "doWork").length, 1, "feedback loop never re-ran the first draft");
    eq((await s.call("POST", `/api/tasks/${t.id}/reject`, { discard: true })).json.task.status, "rejected", "discard -> rejected");
    for (const a of ["approve", "reject", "cancel"]) eq((await s.call("POST", `/api/tasks/${t.id}/${a}`, { feedback: "x" })).status, 409, `${a} on rejected -> 409`);
    eq((await s.call("POST", `/api/tasks/${t.id}/retry`, {})).status, 409, "retry on rejected -> 409");
  } finally { await s.app.close(); }
});
test("illegal transitions return 409 and do not change the task", async () => {
  const s = await boot();
  try {
    await hire(s, "writer");
    s.engine.hold("doWork");
    const t = await newTask(s);
    await s.engine.waitPending("doWork");
    for (const [a, b] of [["approve", {}], ["reject", { feedback: "x" }], ["retry", {}]]) eq((await s.call("POST", `/api/tasks/${t.id}/${a}`, b)).status, 409, `${a} while running`);
    eq((await s.call("GET", `/api/tasks/${t.id}/export`)).status, 409, "export with no output -> 409");
    s.engine.unhold("doWork"); s.engine.releaseAll();
    await waitStatus(s, t.id, "awaiting_approval");
    eq((await s.call("POST", `/api/tasks/${t.id}/reject`, {})).status, 400, "reject without feedback -> 400");
    eq((await s.call("POST", `/api/tasks/${t.id}/reject`, { feedback: "  " })).status, 400, "blank feedback -> 400");
    eq((await s.call("POST", `/api/tasks/${t.id}/reject`, { feedback: "x".repeat(2001) })).status, 400, "long feedback -> 400");
    eq((await s.call("POST", `/api/tasks/${t.id}/approve`, { editedOutput: { items: [{ key: "nope", text: "x" }] } })).status, 400, "unknown item key");
    eq((await s.call("POST", `/api/tasks/${t.id}/approve`, { editedOutput: { items: [{ key: "x-post", text: 5 }] } })).status, 400, "non-string text");
    eq((await s.call("POST", `/api/tasks/${t.id}/approve`, { editedOutput: "x" })).status, 400, "editedOutput string");
    eq((await s.get(t.id)).status, "awaiting_approval", "still awaiting after bad requests");
    const a = await s.call("POST", `/api/tasks/${t.id}/approve`, { editedOutput: { items: [{ key: "x-post", text: "Edited. Learn more." }] } });
    eq(a.status, 200, "approve"); ok(a.json.task.approvedEdited && a.json.task.output.items[0].edited, "edited flags");
    eq((await s.call("POST", `/api/tasks/${t.id}/approve`, {})).status, 409, "double approve -> 409");
  } finally { await s.app.close(); }
});
test("engine failures/garbage never crash: thrown error, undefined result, unreadable deliverable -> failed + retry works", async () => {
  const s = await boot();
  try {
    await hire(s, "writer", "qa");
    const bad = [
      () => { throw new Error("boom"); }, () => undefined, () => ({ ok: true, data: { items: "nope" } }),
      () => ({ ok: false }), () => ({ ok: false, error: { code: "refusal", message: "Claude declined this request" } }),
    ];
    for (const [i, fn] of bad.entries()) {
      s.engine.script.doWork = fn;
      const t = await newTask(s, { title: `bad ${i}` });
      const f = await waitStatus(s, t.id, "failed");
      ok(typeof f.error === "string" && f.error.length, `error message (${i})`);
    }
    s.engine.script.doWork = null;
    s.engine.script.review = () => ({ ok: true, data: { pass: "yes", score: "NaN", issues: "x", suggestions: [1, "ok"] } });
    const t = await newTask(s, { title: "weird verdict" });
    const d = await waitStatus(s, t.id, "awaiting_approval");
    eq(d.verdict.score, 0, "score clamped"); eq(d.verdict.pass, false, "pass strict boolean");
    const failed = (await s.call("GET", "/api/tasks")).json.tasks.find((x) => x.title === "bad 0");
    eq((await s.call("POST", `/api/tasks/${failed.id}/retry`, {})).status, 200, "retry failed task");
    await waitStatus(s, failed.id, "awaiting_approval");
    eq((await s.call("GET", "/healthz")).status, 200, "alive");
  } finally { await s.app.close(); }
});

// ================================================================== 5. persistence
test("graceful close mid-task -> restart resumes the task from the start (scripted engine)", async () => {
  const dataDir = tmpDir("resume");
  const s1 = await boot({ dataDir });
  await hire(s1, "manager", "writer", "qa");
  s1.engine.hold("review");
  const t = await newTask(s1);
  await s1.engine.waitPending("review");
  await s1.app.close();
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"));
  eq(saved.tasks[0].status, "qa_review", "saved mid-pipeline status");
  ok(!fs.readdirSync(dataDir).some((f) => f.endsWith(".tmp")), "no temp files left");
  const s2 = await boot({ dataDir });
  try {
    const done = await waitStatus(s2, t.id, "awaiting_approval");
    ok(done.steps.some((st) => st.status === "interrupted"), "interrupted step recorded");
    ok(done.steps.some((st) => st.title === "Resumed after restart"), "resume step");
    eq(s2.engine.calls.filter((c) => c.method === "writeBrief").length, 1, "pipeline restarted from the brief");
  } finally { await s2.app.close(); }
});
test("restart while a feedback revision is queued -> the feedback revision is redone (not the whole pipeline)", async () => {
  const dataDir = tmpDir("fbq");
  const s1 = await boot({ dataDir });
  await hire(s1, "writer");
  const t = await newTask(s1);
  await waitStatus(s1, t.id, "awaiting_approval");
  s1.engine.hold("revise");
  await s1.call("POST", `/api/tasks/${t.id}/reject`, { feedback: "Mention the 20% discount" });
  await s1.engine.waitPending("revise");
  await s1.app.close();
  const s2 = await boot({ dataDir });
  try {
    const done = await waitStatus(s2, t.id, "awaiting_approval");
    eq(s2.engine.calls.filter((c) => c.method === "doWork").length, 0, "no new first draft");
    eq(s2.engine.calls.find((c) => c.method === "revise")?.args.feedback, "Mention the 20% discount", "feedback revision redone");
    ok(done.output.items[0].text.includes("[fb:Mention the 20% discount]"), "output carries the feedback");
  } finally { await s2.app.close(); }
});
test("[api-backend-002] restart AFTER the feedback revision (task in checks/QA) must not discard the human feedback", async () => {
  const dataDir = tmpDir("fbpost");
  const s1 = await boot({ dataDir });
  await hire(s1, "writer", "qa");
  const t = await newTask(s1);
  await waitStatus(s1, t.id, "awaiting_approval");
  s1.engine.hold("review");
  await s1.call("POST", `/api/tasks/${t.id}/reject`, { feedback: "Mention the 20% discount" });
  await s1.engine.waitPending("review"); // the post-feedback QA review (the first review was not held)
  const before = await s1.get(t.id);
  ok(before.output.items[0].text.includes("[fb:Mention the 20% discount]"), "feedback applied before restart");
  await s1.app.close();
  const s2 = await boot({ dataDir });
  try {
    const done = await waitStatus(s2, t.id, "awaiting_approval");
    const sawFeedback = s2.engine.calls.some((c) => c.args.feedback === "Mention the 20% discount");
    const keptOutput = done.output.items[0].text.includes("[fb:Mention the 20% discount]");
    ok(sawFeedback || keptOutput, `after restart the feedback is lost: no engine call received it and the output was regenerated from scratch ("${done.output.items[0].text}")`);
  } finally { await s2.app.close(); }
});
test("corrupt / odd state.json variants never prevent startup", async () => {
  const variants = { garbage: "{not json", empty: "", arr: "[]", wrongShape: JSON.stringify({ tasks: {} }), v2: JSON.stringify({ version: 2 }),
    nul: "\u0000\u0000", junk: JSON.stringify({ version: 1, team: [null, 5, { id: "m_0123456789", roleId: "writer", desk: 99 }, { id: "m_0123456789", roleId: "writer" }],
      tasks: [null, { id: "bad" }, { id: "t_0123456789", status: "in_progress", steps: [{ status: "running" }], title: 5 }],
      activity: [1, { text: "hi" }], settings: { maxConcurrent: 99 }, usage: { totals: { input_tokens: -5 }, byMember: { __proto__: { calls: 1 } } } }) };
  for (const [name, content] of Object.entries(variants)) {
    const dataDir = tmpDir(`corrupt-${name}`);
    fs.writeFileSync(path.join(dataDir, "state.json"), content);
    const s = await boot({ dataDir });
    try {
      const st = await s.call("GET", "/api/state");
      eq(st.status, 200, `${name}: state readable`);
      eq(st.json.settings.maxConcurrent, 2, `${name}: settings normalised`);
      if (name === "junk") {
        eq(st.json.team.length, 1, "junk: one valid member kept");
        eq(st.json.tasks.length, 1, "junk: one valid task kept");
      }
    } finally { await s.app.close(); }
  }
});
test("[api-backend-003] state.json with malformed output items: export/approve must not 500", async () => {
  const dataDir = tmpDir("items");
  fs.writeFileSync(path.join(dataDir, "state.json"), JSON.stringify({ version: 1, tasks: [{ id: "t_0123456789", title: "T", type: "custom",
    status: "awaiting_approval", output: { items: [null, { key: "a", text: "Hello" }] } }] }));
  const s = await boot({ dataDir });
  try {
    const md = await s.call("GET", "/api/tasks/t_0123456789/export?format=md");
    const ap = await s.call("POST", "/api/tasks/t_0123456789/approve", { editedOutput: { items: [{ key: "a", text: "Hi" }] } });
    ok(md.status < 500 && ap.status < 500, `export md -> ${md.status}, approve with edit -> ${ap.status} (expected no 500: items should be normalised on load)`);
  } finally { await s.app.close(); }
});
test("burst of writes: state.json is always complete JSON, no temp files left", async () => {
  const s = await boot();
  const file = path.join(s.dataDir, "state.json");
  let reads = 0, bad = 0;
  const reader = setInterval(() => { try { JSON.parse(fs.readFileSync(file, "utf8")); reads++; } catch (e) { if (e.code !== "ENOENT") bad++; } }, 1);
  try {
    await Promise.all(Array.from({ length: 60 }, (_, i) => s.call("PUT", "/api/brand", { businessName: `Biz ${i}`, goals: "g".repeat(1500) })));
    await sleep(400);
  } finally { clearInterval(reader); await s.app.close(); }
  eq(bad, 0, `partial state.json observed (${reads} good reads)`);
  ok(!fs.readdirSync(s.dataDir).some((f) => f.endsWith(".tmp")), "no temp files");
});

// ================================================================== 6. SSE
test("SSE: retry+snapshot on connect, monotonic ids, reconnect gets a fresh snapshot, client cap 50", async () => {
  const s = await boot();
  try {
    const a = sse(s.port);
    await until(() => a.events.some((e) => e.type === "snapshot"), 3000, "snapshot");
    eq(a.events[0].retry, 2000, "retry first");
    ok(/text\/event-stream/.test(a.headers["content-type"]), "content-type");
    await hire(s, "writer");
    await newTask(s);
    await until(() => a.events.some((e) => e.type === "task" && e.data.task.status === "awaiting_approval"), 8000, "task event");
    const ids = a.events.filter((e) => e.id).map((e) => e.id);
    ok(ids.every((v, i) => i === 0 || v > ids[i - 1]), "ids strictly increasing");
    const lastId = ids.at(-1);
    a.close();
    await hire(s, "seo"); // happens while disconnected
    const b = sse(s.port, { "last-event-id": String(lastId) });
    const snap = await until(() => b.events.find((e) => e.type === "snapshot"), 3000, "reconnect snapshot");
    ok(snap.data.team.some((m) => m.roleId === "seo"), "reconnect snapshot reflects changes missed while offline");
    ok(snap.id > lastId, "ids continue after reconnect");
    b.close();
    const many = Array.from({ length: 60 }, () => sse(s.port));
    await until(() => many.filter((c) => c.events.length).length === 60, 5000, "60 connects");
    await until(() => many.filter((c) => c.closed).length >= 10, 3000, "oldest dropped");
    eq(many.filter((c) => !c.closed).length, 50, "50 clients kept");
    many.forEach((c) => c.close());
    eq((await s.call("GET", "/healthz")).status, 200, "alive");
  } finally { await s.app.close(); }
});

// ================================================================== 7. cross-origin / host
test("[api-backend-001] cross-site requests must not be able to drive the API (CSRF / DNS rebinding)", async () => {
  const s = await boot();
  try {
    await hire(s, "research");
    // A page on any website can send a body-less "simple" POST (fetch(url,{method:"POST",mode:"no-cors"})) - no preflight.
    const evil = { origin: "https://evil.example" };
    const d = await s.call("POST", "/api/digest/run", undefined, evil);
    const r = await s.call("POST", "/api/team/recommended", undefined, evil);
    const g = await s.call("GET", "/api/state", undefined, { host: "rebind.evil.example" });
    const problems = [];
    if (d.status < 300) problems.push(`POST /api/digest/run from Origin evil.example -> ${d.status} (starts a paid Research run in live mode)`);
    if (r.status < 300) problems.push(`POST /api/team/recommended from Origin evil.example -> ${r.status} (hired ${r.json?.hired?.length})`);
    if (g.status < 300) problems.push(`GET /api/state with Host: rebind.evil.example -> ${g.status} (DNS-rebinding read of brand kit/tasks)`);
    ok(!problems.length, problems.join("; "));
  } finally { await s.app.close(); }
});

// ================================================================== 8. stale warnings after reject
test("[api-backend-004] escalation warnings are cleared when a later revision round passes", async () => {
  const s = await boot();
  try {
    await hire(s, "writer", "qa");
    let fail = true;
    s.engine.script.review = () => (fail ? { ok: true, data: { pass: false, score: 3, issues: ["weak"], suggestions: [] } }
      : { ok: true, data: { pass: true, score: 9, issues: [], suggestions: [] } });
    const t = await newTask(s);
    const esc = await waitStatus(s, t.id, "awaiting_approval");
    ok(esc.escalated && esc.warnings.some((w) => w.startsWith("QA review still fails")), "escalated first");
    fail = false;
    await s.call("POST", `/api/tasks/${t.id}/reject`, { feedback: "Fix it" });
    const done = await waitStatus(s, t.id, "awaiting_approval");
    eq(done.escalated, false, "not escalated");
    eq(done.verdict.score, 9, "QA passed");
    ok(!done.warnings.some((w) => w.startsWith("QA review still fails")),
      `task passed QA 9/10 but still carries warning: ${JSON.stringify(done.warnings)}`);
  } finally { await s.app.close(); }
});

// ================================================================== 9. black-box child process (MOCK=1 node server.js)
function spawnServer(dataDir, port) {
  const child = spawn(process.execPath, [SERVER], { cwd: ROOT, env: { ...process.env, MOCK: "1", PORT: String(port), HOST: "127.0.0.1",
    DATA_DIR: dataDir, MOCK_DELAY_MS: "300", HANDOFF_MS: "50", ANTHROPIC_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  child.output = () => out;
  return child;
}
const randPort = () => 20000 + Math.floor(Math.random() * 30000);
async function waitUp(port) { await until(async () => { try { return (await request(port, "GET", "/healthz")).status === 200; } catch { return false; } }, 10000, "server up"); }

test("child process: hostile traffic never kills the server; SIGKILL mid-task -> restart resumes and finishes", async () => {
  const dataDir = tmpDir("child");
  const port = randPort();
  let child = spawnServer(dataDir, port);
  try {
    await waitUp(port);
    const hostile = [
      "GET / HTTP/1.1\r\nHost: x\r\n" + "X-A: " + "a".repeat(70000) + "\r\n\r\n",
      "POST /api/tasks HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\nZZZ\r\n",
      "POST /api/tasks HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 50\r\n\r\n{\"tit", // aborted body
      "GET /api/tasks/%E0%A4%A HTTP/1.1\r\nHost: x\r\n\r\n",
      "GET /api/events HTTP/1.1\r\nHost: x\r\n\r\n", // SSE opened and torn down
      "BREW /pot HTTP/1.1\r\nHost: x\r\n\r\n",
      Buffer.from(Array.from({ length: 2048 }, () => Math.floor(Math.random() * 256))),
    ];
    for (let i = 0; i < 5; i++) await Promise.all(hostile.map((h) => rawSend(port, h, 150)));
    const big = await request(port, "PUT", "/api/brand", "{\"goals\":\"" + "x".repeat(3 * 1048576) + "\"}").catch((e) => ({ status: e.code }));
    ok(big.status === 413 || big.status === "ECONNRESET" || big.status === "EPIPE", `3 MB body rejected (${big.status})`);
    eq((await request(port, "GET", "/healthz")).status, 200, "alive after hostile traffic");
    ok(child.exitCode === null, "process still running");
    // SIGKILL mid task
    await request(port, "POST", "/api/team/recommended", {});
    const t = (await request(port, "POST", "/api/tasks", { title: "Kill me", type: "social_post", platforms: ["linkedin"] })).json.task;
    await until(async () => ["in_progress", "checks", "qa_review", "revision"].includes((await request(port, "GET", `/api/tasks/${t.id}`)).json.task.status), 10000, "running");
    await sleep(300); // past the 150 ms save debounce
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    child = spawnServer(dataDir, port);
    await waitUp(port);
    const done = await until(async () => { const x = (await request(port, "GET", `/api/tasks/${t.id}`)).json.task; return x.status === "awaiting_approval" && x; }, 30000, "resumed task finishes");
    ok(done.steps.some((s) => s.title === "Resumed after restart"), "resume recorded");
    ok(!/Uncaught exception|Unhandled rejection/.test(child.output()), "no uncaught errors logged");
  } finally { child.kill("SIGKILL"); }
});

// ------------------------------------------------------------------ run
const filter = process.argv[2];
let pass = 0, fail = 0;
const failures = [];
for (const t of tests) {
  if (filter && !t.name.includes(filter)) continue;
  const t0 = Date.now();
  try {
    await Promise.race([t.fn(), new Promise((_, rej) => setTimeout(() => rej(new AssertError("test timeout (60 s)")), 60000))]);
    pass++; console.log(`ok   ${t.name} (${Date.now() - t0} ms)`);
  } catch (err) {
    fail++; failures.push(t.name);
    console.log(`FAIL ${t.name} (${Date.now() - t0} ms)\n     ${err instanceof AssertError ? err.message : err?.stack || err}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed${fail ? `:\n  - ${failures.join("\n  - ")}` : ""}`);
process.exit(fail ? 1 : 0);
