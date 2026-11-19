// Pipeline acceptance against the REAL agents mock engine in server.js.
import assert from "node:assert/strict";
import { start, req, sse, sleep, waitFor, waitStatus, taskStatusesFrom, startServer, tmpDir, BACKEND } from "./lib.mjs";
const AGENTS = (await import(BACKEND)).AGENTS;
let passed = 0;
async function T(name, fn) { const t0 = Date.now(); await fn(); passed++; console.log(`ok ${name} (${Date.now() - t0} ms)`); }
const SOCIAL = { title: "Autumn launch", description: "Launch our autumn menu", type: "social_post", platforms: ["instagram", "x"], assignee: { mode: "manager" } };
async function startWith(wrap, envExtra = {}) {
  const env = { MOCK: "1", MOCK_DELAY_MS: "20", HANDOFF_MS: "0", QUIET: "1", ...envExtra };
  const base = AGENTS.createAgentEngine({ mock: true, env });
  const app = await startServer({ port: 0, dataDir: tmpDir("real"), env, engine: wrap(base) });
  return app;
}

await T("acceptance e2e (real mock): hire recommended, manager social_post -> awaiting with >=1 revision, approve edited, export", async () => {
  const app = await start({ ANTHROPIC_API_KEY: "sk-test-123" });
  const ev = sse(app); await ev.ready();
  const team = (await req(app, "POST", "/api/team/recommended", {})).json.team;
  assert.equal(team.length, 7);
  const byRole = Object.fromEntries(team.map((m) => [m.roleId, m.id]));
  await req(app, "PUT", "/api/brand", { businessName: "Pointo Cafe", offering: "Coffee", audience: "Commuters", voice: "Warm", platforms: ["instagram", "x"] });
  const c = await req(app, "POST", "/api/tasks", SOCIAL);
  assert.equal(c.status, 201);
  const id = c.json.task.id;
  const t = await waitStatus(app, id, "awaiting_approval");
  assert.deepEqual(taskStatusesFrom(ev.events, id), ["queued", "briefing", "in_progress", "checks", "qa_review", "revision", "checks", "qa_review", "awaiting_approval"]);
  const R = (x) => (x ? Object.keys(byRole).find((k) => byRole[k] === x) : null);
  const hand = ev.events.filter((e) => e.type === "handoff" && e.data.taskId === id).map((e) => `${R(e.data.fromMemberId)}->${R(e.data.toMemberId)}`);
  assert.deepEqual(hand, ["manager->writer", "writer->designer", "designer->qa", "qa->writer", "writer->qa", "writer->null"]);
  assert.equal(t.primaryMemberId, byRole.writer);
  assert.ok(t.totalRevisions >= 1 && t.revisionRound === 1);
  assert.ok(t.usage.input_tokens > 0);
  const st = (await req(app, "GET", "/api/state")).json;
  assert.ok(st.usage.totals.input_tokens > 0 && st.usage.byMember[byRole.writer].output_tokens > 0 && st.usage.byRole.qa.calls >= 2);
  assert.ok(t.output.items.some((i) => i.kind === "visual_concept"), "designer items kept through revision");
  console.log("   items:", t.output.items.map((i) => `${i.key}/${i.platform}/${i.kind}`).join(", "), "| QA", t.verdict.score, "| checks", t.checks.results.map((r) => r.id).join(",") || "none");
  const key = t.output.items.find((i) => i.platform === "x").key;
  const ap = await req(app, "POST", `/api/tasks/${id}/approve`, { editedOutput: { items: [{ key, text: "Edited by the owner: autumn is here ☕ Visit us today! #autumn" }] } });
  assert.equal(ap.status, 200);
  const item = ap.json.task.output.items.find((i) => i.key === key);
  assert.equal(item.edited, true);
  assert.ok(ap.json.task.output.items.filter((i) => i.key !== key).every((i) => !i.edited));
  const md = await req(app, "GET", `/api/tasks/${id}/export?format=md`);
  assert.ok(md.text.includes("Edited by the owner: autumn is here ☕"));
  const js = JSON.parse((await req(app, "GET", `/api/tasks/${id}/export?format=json`)).text);
  assert.equal(js.task.status, "approved");
  assert.ok(!ev.raw().includes("sk-test-123"));
  for (const p of ["/api/state", "/api/tasks", "/api/usage", "/", "/api/roles"]) assert.ok(!(await req(app, "GET", p)).text.includes("sk-test-123"));
  ev.close(); await app.close();
});

await T("reject with feedback, discard, no-QA single warning, no-manager, empty team (real mock)", async () => {
  const app = await start();
  await req(app, "POST", "/api/team/recommended", {});
  const ev = sse(app); await ev.ready();
  const id = (await req(app, "POST", "/api/tasks", SOCIAL)).json.task.id;
  await waitStatus(app, id, "awaiting_approval");
  const mark = ev.events.length;
  await req(app, "POST", `/api/tasks/${id}/reject`, { feedback: "Make it more playful" });
  const t = await waitStatus(app, id, "awaiting_approval");
  assert.deepEqual(taskStatusesFrom(ev.events.slice(mark), id).slice(0, 2), ["queued", "revision"]);
  assert.equal(t.revisionRound, 0);
  assert.equal(t.feedback.length, 1);
  assert.equal((await req(app, "POST", `/api/tasks/${id}/reject`, { discard: true })).json.task.status, "rejected");
  ev.close(); await app.close();
  const a2 = await start();
  await req(a2, "POST", "/api/team", { roleId: "writer" });
  const c = await req(a2, "POST", "/api/tasks", SOCIAL);
  const t2 = await waitStatus(a2, c.json.task.id, "awaiting_approval");
  assert.equal(t2.warnings.filter((w) => w.startsWith("No Brand & QA Reviewer hired")).length, 1);
  assert.ok(t2.warnings.includes("No Marketing Manager hired - the task will be routed by default rules."));
  await a2.close();
  const a3 = await start();
  const e = await req(a3, "POST", "/api/tasks", SOCIAL);
  assert.ok(e.json.warnings.includes("Nobody on the team can do this task - hire a specialist."));
  assert.equal((await waitStatus(a3, e.json.task.id, "failed")).error, "Nobody on the team can do this task - hire a specialist.");
  await a3.close();
});

await T("escalation after 2 automated revisions (real mock wrapped: revise returns the draft unchanged)", async () => {
  const app = await startWith((base) => ({ ...base, revise: async (args) => { const r = await base.revise(args); if (r.ok) r.data = structuredClone(args.output); return r; } }));
  await req(app, "POST", "/api/team/recommended", {});
  const id = (await req(app, "POST", "/api/tasks", SOCIAL)).json.task.id;
  const t = await waitStatus(app, id, "awaiting_approval");
  assert.equal(t.revisionRound, 2); assert.equal(t.escalated, true);
  assert.equal(t.steps.filter((s) => s.kind === "qa").length, 3);
  await app.close();
});

await T("failure -> failed + member error; retry (real mock wrapped: doWork fails once)", async () => {
  let fail = true;
  const app = await startWith((base) => ({ ...base, doWork: async (args) => { if (fail) { fail = false; await base.doWork(args); return { ok: false, error: { code: "refusal", message: "Claude declined this request (cyber)", retryable: false }, usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, web_search_requests: 0, calls: 1 }, stopReason: "refusal", model: "x" }; } return base.doWork(args); } }));
  await req(app, "POST", "/api/team/recommended", {});
  const id = (await req(app, "POST", "/api/tasks", SOCIAL)).json.task.id;
  const f = await waitStatus(app, id, "failed");
  assert.equal(f.error, "Content Writer: Claude declined this request (cyber)");
  assert.equal(f.steps.at(-1).stopReason, "refusal");
  const w = (await req(app, "GET", "/api/state")).json.team.find((m) => m.roleId === "writer");
  assert.equal(w.status, "error");
  await req(app, "POST", `/api/tasks/${id}/retry`, {});
  await waitStatus(app, id, "awaiting_approval");
  assert.equal((await req(app, "GET", "/api/state")).json.team.find((m) => m.roleId === "writer").status, "waiting");
  await app.close();
});

await T("cancel during each stage aborts the in-flight real-mock call (<1 s) and frees the slot", async () => {
  const app = await start({ MOCK_DELAY_MS: "1500" });
  await req(app, "POST", "/api/team/recommended", {});
  await req(app, "PUT", "/api/settings", { maxConcurrent: 1 });
  for (const stage of ["briefing", "in_progress", "qa_review", "revision"]) {
    const id = (await req(app, "POST", "/api/tasks", SOCIAL)).json.task.id;
    await waitStatus(app, id, stage, 30000);
    await sleep(150);
    const t0 = Date.now();
    const c = await req(app, "POST", `/api/tasks/${id}/cancel`, {});
    assert.equal(c.json.task.status, "cancelled");
    await waitFor(async () => { const s = (await req(app, "GET", "/api/state")).json; return s.queue.running.length === 0 && s.team.every((m) => m.status === "idle"); }, 1000);
    assert.ok(Date.now() - t0 < 1000);
    console.log(`   cancel during ${stage}: ${Date.now() - t0} ms`);
  }
  await app.close();
});

await T("analytics learnings, digest, concurrency (real mock)", async () => {
  const app = await start({ DIGEST_CHECK_MS: "200", DIGEST_INTERVAL_MS: "1000" });
  await req(app, "POST", "/api/team/recommended", {});
  const ev = sse(app); await ev.ready();
  const id = (await req(app, "POST", "/api/tasks", { title: "Weekly report", type: "analytics_report", assignee: { mode: "manager" } })).json.task.id;
  const t = await waitStatus(app, id, "awaiting_approval");
  const n = t.output.items.filter((i) => i.kind === "learning").length;
  assert.ok(n >= 1, "analytics mock produced learnings");
  await req(app, "POST", `/api/tasks/${id}/approve`, {});
  assert.equal((await req(app, "GET", "/api/brand")).json.brand.learnings.length, Math.min(20, n));
  await req(app, "PUT", "/api/settings", { dailyDigest: true });
  const d = (await req(app, "GET", "/api/tasks")).json.tasks.find((x) => x.source === "digest");
  assert.ok(d);
  assert.equal((await req(app, "POST", "/api/digest/run", {})).status, 409);
  const dd = await waitStatus(app, d.id, "awaiting_approval");
  assert.ok(dd.output.sources.length >= 1);
  await req(app, "PUT", "/api/settings", { dailyDigest: false, maxConcurrent: 1 });
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await req(app, "POST", "/api/tasks", { ...SOCIAL, title: "C" + i })).json.task.id);
  for (const x of ids) await waitStatus(app, x, "awaiting_approval", 20000);
  const qe = ev.events.filter((e) => e.type === "queue");
  const after = qe.findIndex((e) => e.data.queued.length === 2);
  assert.ok(after >= 0);
  assert.ok(qe.slice(after).every((e) => e.data.running.length <= 1));
  ev.close(); await app.close();
});
console.log(`\n${passed} real-agents tests passed`);
