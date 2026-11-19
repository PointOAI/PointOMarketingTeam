// Scripted contract server: serves the frontend embedded in server.js and a crafted snapshot covering states that the
// mock pipeline rarely produces (escalation, member error, unsafe source URLs, XSS in model output).
const http = require("node:http");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { REPO, SHOTS, randPort } = require("./lib.cjs");

const html = (() => {
  // Extract the FRONTEND_HTML template literal from server.js and evaluate it (undoes the assembly escaping).
  const src = fs.readFileSync(REPO + "/server.js", "utf8");
  const a = src.indexOf("const FRONTEND_HTML = `"), b = src.indexOf("`;\n\n// ===== Agents", a);
  if (a < 0 || b < 0) throw new Error("FRONTEND_HTML not found in server.js");
  return require("node:vm").runInNewContext(src.slice(a + "const FRONTEND_HTML = ".length, b + 1));
})();
const XSS = `<img src=x onerror="window.__xss=1">`;
const now = new Date().toISOString();
const U = (n) => ({ input_tokens: n, output_tokens: n, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, web_search_requests: 0, calls: 1 });
const ap = (i) => ({ skin: ["#f1c27d", "#8d5524", "#e0ac69", "#a8754a"][i % 4], hair: ["#1f1f2e", "#a63d40", "#7a4b26", "#e6c36a"][i % 4], shirt: ["#ef4444", "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#64748b"][i], pants: "#2f3542", hairStyle: i % 4 });
const roles = ["manager", "research", "seo", "writer", "designer", "qa", "analytics", "ads", "email", "community"];
const statuses = [["working", "Writing brief"], ["working", "Drafting"], ["reviewing", "Reviewing"], ["waiting", "Needs you!"], ["error", "Error"], ["idle", "Idle"], ["working", "Revising"], ["idle", "Idle"], ["reviewing", "Reviewing"], ["idle", "Idle"]];
const team = roles.map((r, i) => ({ id: `m_${String(i).padStart(10, "0")}`, roleId: r, name: i === 9 ? XSS : ["Maya", "Leo", "Ava", "Noah", "Zoe", "Omar", "Iris", "Kai", "Lena", "Sam"][i], desk: i,
  appearance: ap(i), status: statuses[i][0], statusText: statuses[i][1], currentTaskId: null, hiredAt: now, lastError: statuses[i][0] === "error" ? "Claude declined this request (cyber)" : null }));
const catalogRoles = roles.map((r) => ({ id: r, title: { manager: "Marketing Manager", research: "Research & Intelligence", seo: "SEO Specialist", writer: "Content Writer", designer: "Creative Designer", qa: "Brand & QA Reviewer", analytics: "Analytics & Reporting", ads: "Paid Ads Specialist", email: "Email/CRM Specialist", community: "Community Manager" }[r], short: r.slice(0, 8), core: roles.indexOf(r) < 7, responsibilities: ["A", "B"], cadence: "Weekly", taskTypes: [], usesWebSearch: r === "research", modelTier: "main" }));
const task = {
  id: "t_00000000aa", title: `Escalated ${XSS}`, description: "", type: "social_post", platforms: ["x", "instagram"], assignee: { mode: "manager" }, source: "user",
  status: "awaiting_approval", createdAt: now, updatedAt: now, startedAt: now, finishedAt: null, brief: null, plan: [], primaryMemberId: team[3].id,
  steps: [{ id: "s_0000000001", kind: "work", status: "done", memberId: team[3].id, roleId: "writer", title: "Content Writer drafted", startedAt: now, finishedAt: now, summary: `Drafted ${XSS}`, detail: null, usage: U(10), stopReason: "max_tokens", truncated: true, error: null }],
  output: { summary: `Summary ${XSS}`, items: [
    { key: "x-post", label: `X post ${XSS}`, platform: "x", kind: "post", text: `${"y".repeat(300)} ${XSS} #a #b #c` },
    { key: "ig", label: "Instagram", platform: "instagram", kind: "post", text: "Hello #a" },
    { key: "meta", label: "Meta title", platform: "none", kind: "meta_title", text: "A meta title that is definitely longer than sixty characters in total" },
  ], notes: `Notes ${XSS}`, sources: [{ title: "Good source", url: "https://example.org/a" }, { title: "Bad source", url: "javascript:window.__xss=1" }, { title: "Data source", url: "data:text/html,hi" }] },
  checks: { pass: false, results: [{ id: "x-length-x-post", itemKey: "x-post", level: "error", message: `X post too long ${XSS}` }, { id: "w", itemKey: "ig", level: "warning", message: "Instagram short" }], checkedAt: now },
  verdict: { pass: false, score: 5, issues: [`Issue ${XSS}`], suggestions: ["Shorter"] }, revisionRound: 2, totalRevisions: 2, feedback: [{ at: now, text: `Feedback ${XSS}` }],
  warnings: ["QA verdict could not be read"], escalated: true, pendingFeedbackRevision: false, error: null, usage: U(10), approvedAt: null, approvedEdited: false,
};
const snapshot = {
  mode: "mock", model: "claude-opus-5-5", workerModel: "claude-opus-5-5", serverTime: now,
  brand: { businessName: XSS, offering: "", audience: "", voice: "", bannedWords: [], approvedClaims: [], competitors: [], platforms: ["x"], goals: "", learnings: [`Learning ${XSS}`], updatedAt: now },
  team, tasks: [task], settings: { dailyDigest: false, maxConcurrent: 2, lastDigestAt: null },
  usage: { totals: U(10), byMember: { [team[3].id]: U(10) }, byRole: { writer: U(10) } },
  activity: [{ id: "a_0000000001", at: now, memberId: team[9].id, taskId: null, kind: "hire", text: `Hired ${XSS}` }],
  queue: { running: [], queued: [] },
  catalog: { roles: catalogRoles, recommended: roles.slice(0, 7), taskTypes: [{ id: "social_post", label: "Social post", description: "d", platformScope: "social" }],
    platforms: [{ id: "facebook", label: "Facebook" }, { id: "instagram", label: "Instagram" }, { id: "linkedin", label: "LinkedIn" }, { id: "tiktok", label: "TikTok" }, { id: "x", label: "X" }, { id: "blog", label: "Blog" }, { id: "email", label: "Email" }],
    platformRules: { x: { label: "X", hardLimit: 280, recommended: [1, 280], hashtags: { max: null, recommended: [1, 2] } }, instagram: { label: "Instagram", hardLimit: 2200, recommended: [125, 150], hashtags: { max: 30, recommended: [3, 10] } }, meta_title: { hardLimit: 60, recommended: [50, 60] }, meta_description: { hardLimit: 160, recommended: [120, 160] }, email_subject: { hardLimit: null, recommended: [1, 60] } } },
};
const clients = new Set();
let seq = 0;
const send = (res, type, data) => res.write(`id: ${++seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
const server = http.createServer((req, res) => {
  if (req.url === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" }); return res.end(html); }
  if (req.url === "/api/state") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(snapshot)); }
  if (req.url === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write("retry: 2000\n\n"); send(res, "snapshot", snapshot); clients.add(res); req.on("close", () => clients.delete(res)); return;
  }
  res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Not found", code: "not_found" }));
});

(async () => {
  const port = randPort();
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const url = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url + "/");
    await page.waitForFunction(() => document.getElementById("conn").textContent === "Live");
    await page.waitForTimeout(400);
    // hand-offs: room<->wood both directions, wood<->wood, null target, unknown member (ignored)
    for (const c of clients) {
      send(c, "handoff", { taskId: task.id, fromMemberId: team[0].id, toMemberId: team[8].id, label: "Brief" });
      send(c, "handoff", { taskId: task.id, fromMemberId: team[5].id, toMemberId: team[0].id, label: "For review" });
      send(c, "handoff", { taskId: task.id, fromMemberId: team[1].id, toMemberId: team[2].id, label: "Draft" });
      send(c, "handoff", { taskId: task.id, fromMemberId: team[6].id, toMemberId: null, label: "Needs your approval" });
      send(c, "handoff", { taskId: task.id, fromMemberId: "m_ffffffffff", toMemberId: team[2].id, label: "x" });
    }
    await page.waitForTimeout(1500);
    const walks = await page.evaluate(() => __officeDebug.walks());
    assert.equal(walks.length, 3);
    const inDoor = (p) => p.x >= 224 && p.x < 240 && p.y >= 160 && p.y < 208;
    for (const w of walks) {
      const crosses = w.path.some((p) => p.x >= 240) && w.path.some((p) => p.x < 224);
      if (crosses) assert.ok(w.path.some(inDoor), "cross-zone walk uses the doorway " + JSON.stringify(w.path));
      // segments are axis-aligned and never cross the column-14 wall outside the doorway
      for (let i = 1; i < w.path.length; i++) {
        const a = w.path[i - 1], b = w.path[i];
        assert.ok(a.x === b.x || a.y === b.y, "axis aligned");
        if ((a.x < 224 && b.x >= 240) || (b.x < 224 && a.x >= 240)) assert.ok(a.y >= 160 && a.y < 208, "crosses wall only at the doorway");
      }
    }
    const b = await page.evaluate(() => __officeDebug.bubbles());
    assert.equal(b[team[6].id], "Needs you!");
    assert.equal(b[team[4].id], "Error");
    console.log("PASS fixture hand-offs: 3 walks (room->wood, wood->room via doorway, wood->wood), null target -> Needs you!, unknown member ignored");
    await page.screenshot({ path: `${SHOTS}/fixture-all-statuses-1440x900.png` });
    // remove a walking member mid-walk -> dropped safely
    for (const c of clients) send(c, "member_removed", { id: team[0].id });
    await page.waitForTimeout(300);
    assert.equal((await page.evaluate(() => __officeDebug.walks())).length, 2);
    console.log("PASS member removed mid-walk is dropped safely");

    await page.click("#tab-approvals");
    await page.waitForFunction(() => document.getElementById("view").dataset.view === "approvals");
    await page.click('#view [data-ptab="x"]');
    await page.waitForTimeout(100);
    const txt = await page.textContent("#view");
    assert.ok(txt.includes("QA/checks still failing after 2 revisions — review carefully"));
    assert.ok(txt.includes(`X post ${XSS}`));
    assert.match(txt, /3\d\d \/ 280 chars/);
    assert.match(txt, /3 hashtags/);
    await page.click('#view [data-ptab="none"]');
    await page.waitForTimeout(100);
    assert.match(await page.textContent("#view"), /\/ 60 chars/);
    assert.ok((await page.$$eval("#view [data-ptab]", (e) => e.map((x) => x.textContent))).some((t) => t.startsWith("General")));
    console.log("PASS escalated banner, over-limit counts, General tab for platform none, meta title limit");
    await page.click(`#view [data-approval="${task.id}"] button.link`);
    await page.waitForFunction(() => document.getElementById("view").dataset.view === "task");
    const links = await page.$$eval("#view a", (as) => as.map((a) => ({ t: a.textContent, href: a.getAttribute("href"), rel: a.getAttribute("rel"), target: a.getAttribute("target") })));
    const good = links.find((l) => l.t === "Good source"), bad = links.find((l) => l.t === "Bad source"), data = links.find((l) => l.t === "Data source");
    assert.equal(good.href, "https://example.org/a"); assert.equal(good.rel, "noopener noreferrer"); assert.equal(good.target, "_blank");
    assert.equal(bad.href, null); assert.equal(data.href, null);
    const det = await page.textContent("#view");
    for (const s of ["Output was truncated", "Stop reason: max_tokens", `Feedback ${XSS}`, `Issue ${XSS}`, `Notes ${XSS}`, "QA verdict could not be read"]) assert.ok(det.includes(s), s);
    console.log("PASS source links: href only for http(s) with rel/target; javascript:/data: rendered as text; truncation + stopReason notes");
    await page.click("#tab-brand");
    await page.waitForFunction(() => document.getElementById("view").dataset.view === "brand");
    assert.ok((await page.textContent("#learnings")).includes(`Learning ${XSS}`));
    await page.click("#tab-activity");
    await page.waitForFunction(() => !!document.getElementById("activityList"));
    assert.ok((await page.textContent("#activityList")).includes(`Hired ${XSS}`));
    const flags = await page.evaluate(() => ({ x: window.__xss, imgs: document.querySelectorAll("img").length, team: document.querySelectorAll("#view .member-row").length }));
    assert.equal(flags.x, undefined); assert.equal(flags.imgs, 0);
    console.log("PASS XSS in model output / learnings / activity rendered as text; window.__xss undefined");
    // agent with error
    await page.click("#tab-team");
    await page.click(`#view [data-member="${team[4].id}"]`);
    await page.waitForFunction(() => /Last error/.test(document.getElementById("view").textContent));
    console.log("PASS error member shows last error in agent view");
    assert.deepEqual(errors, []);
    console.log("PASS no console errors");
  } catch (e) {
    console.error("FAIL", e.message); process.exitCode = 1;
  } finally {
    await browser.close();
    for (const c of clients) c.end();
    server.close();
  }
})();
