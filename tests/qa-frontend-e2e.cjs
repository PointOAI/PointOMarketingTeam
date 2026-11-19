// QA frontend end-to-end suite (Playwright, real backend in mock mode).
// Usage: node tests/qa-frontend-e2e.cjs      (needs Node 22 + the preinstalled `playwright` package)
// Every check is recorded as PASS/FAIL; the process exits 1 if any check fails.
// The server is started with MOCK=1 on a random high port with a temp DATA_DIR and is always killed.
"use strict";
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const { startServer, req, SHOTS } = require("./frontend/lib.cjs");

const IMG = `<img src=x onerror=alert(1)>`;
const IMG2 = `<img src=x onerror="window.__xss=(window.__xss||0)+1">`;
const SCRIPT = `<script>window.__xss=(window.__xss||0)+1;alert(2)</script>`;
const SVG = `<svg onload=window.__xss=1>`; // fits the 40-char name limit

const results = [];
function pass(name, info = "") { results.push({ ok: true, name }); console.log("PASS", name, info ? `- ${info}` : ""); }
function fail(name, info = "") { results.push({ ok: false, name, info }); console.log("FAIL", name, info ? `- ${info}` : ""); }
async function check(name, fn) {
  try { const info = await fn(); pass(name, typeof info === "string" ? info : ""); }
  catch (e) { fail(name, e && e.message ? e.message.split("\n")[0] : String(e)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, arg, timeout = 15000, label = "condition") {
  try { return await page.waitForFunction(fn, arg, { timeout, polling: 50 }); }
  catch { throw new Error(`timed out waiting for ${label}`); }
}
async function apiState(srv) { return (await req("GET", srv.url + "/api/state")).json; }
async function waitTask(srv, id, statuses, timeout = 60000) {
  const end = Date.now() + timeout;
  let t;
  while (Date.now() < end) {
    t = (await req("GET", `${srv.url}/api/tasks/${id}`)).json.task;
    if (statuses.includes(t.status)) return t;
    await sleep(120);
  }
  throw new Error(`task ${id} stuck in ${t && t.status}, wanted ${statuses}`);
}
// Runs inside the page: true when any XSS payload executed or became live markup.
const XSS_PROBE = () => ({
  flag: window.__xss || 0,
  imgs: [...document.querySelectorAll("img")].length,
  svgs: [...document.querySelectorAll("svg")].length,
  scripts: document.scripts.length,
});

(async () => {
  const srv = await startServer({ env: { MOCK_DELAY_MS: "250", HANDOFF_MS: "900" } });
  const browser = await chromium.launch();
  const consoleErrors = [];
  const dialogs = [];
  let expectErrors = false;
  const wire = (page, tag) => {
    page.on("console", (m) => { if (m.type() === "error" && !expectErrors) consoleErrors.push(`[${tag}] ${m.text()}`); });
    page.on("pageerror", (e) => consoleErrors.push(`[${tag}] pageerror: ${e.message}`));
    page.on("dialog", async (d) => { dialogs.push(`[${tag}] ${d.type()}: ${d.message()}`); await d.dismiss().catch(() => {}); });
  };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const page = await ctx.newPage();
    wire(page, "A");
    await page.goto(srv.url + "/");
    await waitFor(page, () => document.getElementById("conn").textContent === "Live", null, 10000, "Live badge");
    const baseScripts = await page.evaluate(() => document.scripts.length);

    // ---------------------------------------------------------------- load / demo badge
    await check("load: demo badge visible in mock mode, Live connection, empty overlay", async () => {
      assert(await page.isVisible("#demoBadge"), "demo badge hidden");
      assert((await page.textContent("#demoBadge")).trim() === "Demo mode", "badge text");
      assert(await page.isVisible("#emptyOverlay"), "empty overlay hidden");
      const st = await apiState(srv);
      assert(st.mode === "mock", "mode " + st.mode);
    });

    // ---------------------------------------------------------------- activity empty state goes stale
    await check("activity: 'No activity yet' placeholder disappears when the first live entry arrives (non-team event)", async () => {
      await page.click("#tab-activity");
      await waitFor(page, () => /No activity yet/.test(document.getElementById("view").textContent), null, 3000, "empty activity");
      // a brand save logs an activity entry but does not touch the team, so only the SSE activity handler runs
      await req("PUT", srv.url + "/api/brand", { businessName: "First save" });
      await waitFor(page, () => document.querySelectorAll("#activityList li").length >= 1, null, 5000, "first activity row");
      await sleep(400);
      const txt = await page.textContent("#view");
      assert(!/No activity yet/.test(txt), `view shows an entry AND "No activity yet." -> ${JSON.stringify(txt.slice(0, 120))}`);
    });
    await check("activity: first hire (team event) re-renders the feed", async () => {
      await req("POST", srv.url + "/api/team", { roleId: "analytics", name: "Ana" });
      await waitFor(page, () => [...document.querySelectorAll("#activityList li")].some((l) => /Ana/.test(l.textContent)), null, 5000, "hire row");
    });

    // ---------------------------------------------------------------- hire / rename / remove with XSS
    await check("hire via catalog with <img onerror> name renders literally", async () => {
      await page.click("#tab-team");
      await page.fill('#view [data-k="hire:seo"]', IMG);
      await page.click('#view [data-hire="seo"]');
      await waitFor(page, (x) => [...document.querySelectorAll("#view .member-row strong")].some((s) => s.textContent === x), IMG, 5000, "member row");
      const p = await page.evaluate(XSS_PROBE);
      assert(p.imgs === 0 && p.flag === 0, JSON.stringify(p));
    });
    await check("hire via Enter key with <script> name renders literally", async () => {
      await page.fill('#view [data-k="hire:designer"]', SCRIPT.slice(0, 40));
      await page.press('#view [data-k="hire:designer"]', "Enter");
      await waitFor(page, (x) => [...document.querySelectorAll("#view .member-row strong")].some((s) => s.textContent === x), SCRIPT.slice(0, 40), 5000, "member row");
      const p = await page.evaluate(XSS_PROBE);
      assert(p.scripts === baseScripts && p.flag === 0, JSON.stringify(p));
    });
    await check("hire: name over 40 chars is blocked by maxlength (input truncates)", async () => {
      await page.fill('#view [data-k="hire:email"]', "x".repeat(60));
      assert((await page.inputValue('#view [data-k="hire:email"]')).length === 40, "maxlength not applied");
      await page.fill('#view [data-k="hire:email"]', "");
    });
    await check("hire recommended button fills the remaining core roles (7 core total)", async () => {
      await page.click("#btnRecommended");
      await waitFor(page, () => Object.keys(__officeDebug.positions()).length === 7, null, 5000, "7 sprites");
      const st = await apiState(srv);
      const core = st.catalog.recommended;
      assert(core.every((r) => st.team.some((m) => m.roleId === r)), "missing core role");
      assert(await page.isHidden("#emptyOverlay"), "overlay still visible");
      await waitFor(page, () => /Recommended team hired/.test(document.getElementById("btnRecommended").textContent) && document.getElementById("btnRecommended").disabled, null, 3000, "button label/disabled");
    });
    const st0 = await apiState(srv);
    const seo = st0.team.find((m) => m.roleId === "seo");
    const writer = st0.team.find((m) => m.roleId === "writer");
    const mgr = st0.team.find((m) => m.roleId === "manager");
    const analytics = st0.team.find((m) => m.roleId === "analytics");

    await check("rename member to an <svg onload> payload via agent panel; office/desk updated; no execution", async () => {
      await page.click(`#view [data-member="${seo.id}"]`);
      await page.fill(`[data-k="rename:${seo.id}"]`, SVG);
      await page.click('[data-action="rename"]');
      await waitFor(page, (x) => document.querySelector("#view h2") && document.querySelector("#view h2").textContent === x, SVG, 5000, "renamed heading");
      const p = await page.evaluate(XSS_PROBE);
      assert(p.svgs === 0 && p.flag === 0, JSON.stringify(p));
      assert((await apiState(srv)).team.find((m) => m.id === seo.id).name === SVG, "server name");
    });
    await check("rename: empty name shows inline error and does not call server", async () => {
      await page.fill(`[data-k="rename:${seo.id}"]`, "   ");
      await page.click('[data-action="rename"]');
      await waitFor(page, () => !!document.querySelector("#view .inline-err"), null, 3000, "inline error");
      assert((await apiState(srv)).team.find((m) => m.id === seo.id).name === SVG, "name changed");
      await page.fill(`[data-k="rename:${seo.id}"]`, "Sam SEO");
      await page.click('[data-action="rename"]');
      await waitFor(page, () => document.querySelector("#view h2").textContent === "Sam SEO", null, 5000, "rename back");
    });
    await check("remove needs a confirm click; second click removes member, sprite and desk", async () => {
      await page.click(`#tab-team`);
      await page.click(`#view [data-member="${analytics.id}"]`);
      await page.click('[data-action="remove"]');
      await waitFor(page, () => document.querySelector('[data-action="remove"]').textContent === "Confirm remove", null, 3000, "armed");
      assert((await apiState(srv)).team.some((m) => m.id === analytics.id), "removed on first click");
      await page.click('[data-action="remove"]');
      await waitFor(page, (id) => !__officeDebug.positions()[id], analytics.id, 5000, "sprite gone");
      assert(!(await apiState(srv)).team.some((m) => m.id === analytics.id), "still on server");
      assert(/Analytics & Reporting/.test(await page.textContent("#view")), "back on team view with catalog");
    });
    await check("remove arm expires after ~5 s (button returns to 'Remove')", async () => {
      await page.click(`#view [data-member="${seo.id}"]`);
      await page.click('[data-action="remove"]');
      await waitFor(page, () => document.querySelector('[data-action="remove"]').textContent === "Confirm remove", null, 3000, "armed");
      await waitFor(page, () => document.querySelector('[data-action="remove"]').textContent === "Remove", null, 8000, "disarmed");
      assert((await apiState(srv)).team.some((m) => m.id === seo.id), "member removed");
    });
    // re-hire analytics for later
    await req("POST", srv.url + "/api/team", { roleId: "analytics" });

    // ---------------------------------------------------------------- brand kit save + reload
    const brandVals = {
      businessName: `Biz ${IMG2}`, offering: `Beans ${SCRIPT}`, audience: `Baristas ${SVG}`, voice: "Warm & witty",
      banned: "cheap\n<b>bold</b>", claims: "Roasted within 48 hours", goals: `Grow ${IMG2}`,
    };
    await check("brand kit: XSS in every field saves, survives reload, renders literally", async () => {
      await page.click("#tab-brand");
      await page.fill("#bk-businessName", brandVals.businessName);
      await page.fill("#bk-offering", brandVals.offering);
      await page.fill("#bk-audience", brandVals.audience);
      await page.fill("#bk-voice", brandVals.voice);
      await page.fill("#bk-banned", brandVals.banned);
      await page.fill("#bk-claims", brandVals.claims);
      await page.click("#addCompetitor");
      await page.fill('[data-k="bk:cn:0"]', `Rival ${IMG2}`);
      await page.fill('[data-k="bk:cu:0"]', "https://rival.example/");
      for (const p of ["instagram", "x", "linkedin"]) await page.check(`input[name=brandPlatform][value=${p}]`);
      await page.fill("#bk-goals", brandVals.goals);
      await page.click("#brandSave");
      await waitFor(page, (n) => document.getElementById("bizName").textContent === n, brandVals.businessName, 5000, "bizName");
      await page.reload();
      await waitFor(page, () => document.getElementById("conn").textContent === "Live", null, 10000, "Live");
      await page.click("#tab-brand");
      await waitFor(page, () => !!document.getElementById("bk-businessName"), null, 3000, "brand form");
      assert(await page.inputValue("#bk-businessName") === brandVals.businessName, "businessName");
      assert(await page.inputValue("#bk-offering") === brandVals.offering, "offering");
      assert(await page.inputValue("#bk-audience") === brandVals.audience, "audience");
      assert(await page.inputValue("#bk-banned") === brandVals.banned, "banned");
      assert(await page.inputValue('[data-k="bk:cn:0"]') === `Rival ${IMG2}`, "competitor");
      assert(await page.inputValue('[data-k="bk:cu:0"]') === "https://rival.example/", "competitor url");
      const checked = await page.$$eval("input[name=brandPlatform]:checked", (e) => e.map((x) => x.value).sort());
      assert(JSON.stringify(checked) === JSON.stringify(["instagram", "linkedin", "x"]), "platforms " + checked);
      const p = await page.evaluate(XSS_PROBE);
      assert(p.flag === 0 && p.imgs === 0 && p.svgs === 0, JSON.stringify(p));
    });
    await check("brand kit: competitor with URL but no name is rejected inline with a readable message", async () => {
      await page.click("#addCompetitor");
      await page.fill('[data-k="bk:cu:1"]', "https://noname.example/");
      expectErrors = true;
      await page.click("#brandSave");
      await waitFor(page, () => !!document.getElementById("brandErr"), null, 5000, "brand error");
      expectErrors = false;
      const msg = await page.textContent("#brandErr");
      await page.click('[aria-label="Remove competitor 2"]');
      await page.click("#brandSave");
      await waitFor(page, () => !document.getElementById("brandErr"), null, 5000, "error cleared");
      return `message: "${msg}"`;
    });

    // ---------------------------------------------------------------- SSE: second tab sees live changes
    const page2 = await ctx.newPage();
    wire(page2, "B");
    await page2.goto(srv.url + "/");
    await waitFor(page2, () => document.getElementById("conn").textContent === "Live", null, 10000, "B Live");
    await check("SSE: hire in tab A appears in tab B without reload", async () => {
      await page.click("#tab-team");
      await page.click('#view [data-hire="community"]');
      await waitFor(page2, () => [...document.querySelectorAll("#view .member-row")].some((r) => /Community Manager/.test(r.textContent)), null, 5000, "B sees community");
    });
    await check("SSE: brand edit in A while B has unsaved edits -> B keeps draft and offers to load latest", async () => {
      await page2.click("#tab-brand");
      await page2.fill("#bk-voice", "B draft voice");
      await page.click("#tab-brand");
      await page.fill("#bk-voice", "A saved voice");
      await page.click("#brandSave");
      await waitFor(page2, () => /updated elsewhere/.test(document.getElementById("view").textContent), null, 5000, "remote notice");
      assert(await page2.inputValue("#bk-voice") === "B draft voice", "B draft lost");
      await page2.click('button:has-text("discard them and load the latest")');
      await waitFor(page2, () => document.getElementById("bk-voice").value === "A saved voice", null, 3000, "B loaded latest");
    });

    // ---------------------------------------------------------------- tasks: specific member + manager decides
    let tMember, tMgr;
    await check("create task assigned to a specific member (Writer) with XSS title/description", async () => {
      await page.click("#tab-team");
      await page.click(`#view [data-member="${writer.id}"]`);
      await page.click('[data-action="assign"]');
      await waitFor(page, () => document.getElementById("dlgTask").open, null, 3000, "dialog");
      assert(await page.inputValue("#dlgTask select[name=assignee]") === writer.id, "writer preselected");
      await page.fill("#ntTitle", `Post ${IMG2}`);
      await page.fill("#ntDesc", `Desc ${SCRIPT}`);
      await page.click('#dlgTask button[type=submit]');
      await waitFor(page, () => !document.getElementById("dlgTask").open, null, 5000, "dialog closed");
      tMember = (await apiState(srv)).tasks.find((t) => t.title === `Post ${IMG2}`);
      assert(tMember && tMember.assignee.mode === "member" && tMember.assignee.memberId === writer.id, JSON.stringify(tMember && tMember.assignee));
      await waitFor(page, (x) => document.querySelector("#view h2") && document.querySelector("#view h2").textContent === x, `Post ${IMG2}`, 3000, "detail view");
      const txt = await page.textContent("#view");
      assert(txt.includes(writer.name), "assignee name not shown in detail");
    });
    await check("create task with 'Let the Manager decide' from top-bar button", async () => {
      await page.click("#btnNewTask");
      await page.fill("#ntTitle", "Manager routed blog");
      await page.selectOption("#dlgTask select[name=type]", "blog_article");
      assert(await page.inputValue("#dlgTask select[name=assignee]") === "manager", "default assignee");
      await page.click('#dlgTask button[type=submit]');
      await waitFor(page, () => !document.getElementById("dlgTask").open, null, 5000, "dialog closed");
      tMgr = (await apiState(srv)).tasks.find((t) => t.title === "Manager routed blog");
      assert(tMgr && tMgr.assignee.mode === "manager", "assignee");
      assert(JSON.stringify(tMgr.platforms) === '["blog"]', "platforms " + JSON.stringify(tMgr.platforms));
    });

    // office animation while both tasks run
    await check("office: live status bubbles (working/reviewing) and at least one hand-off walk with a moving sprite", async () => {
      const kinds = new Set(), bubbles = new Set();
      let walk = null, moved = false;
      const end = Date.now() + 45000;
      let firstPos = null;
      while (Date.now() < end) {
        const s = await page.evaluate(() => ({ b: __officeDebug.bubbles(), w: __officeDebug.walks(), p: __officeDebug.positions() }));
        Object.values(s.b).forEach((b) => bubbles.add(b));
        Object.values(s.p).forEach((p) => kinds.add(p.pose + (p.walking ? "-walk" : "")));
        if (s.w.length) {
          if (!walk) { walk = s.w[0]; firstPos = s.p[walk.memberId]; }
          else if (s.p[walk.memberId] && firstPos && (s.p[walk.memberId].x !== firstPos.x || s.p[walk.memberId].y !== firstPos.y)) moved = true;
        }
        const st = await apiState(srv);
        const done = st.tasks.filter((t) => [tMember.id, tMgr.id].includes(t.id)).every((t) => t.status === "awaiting_approval" || t.status === "failed");
        if (done && walk && moved) break;
        await sleep(60);
      }
      assert(walk, "no walk seen; bubbles: " + [...bubbles].join("|"));
      assert(moved, "walking sprite never moved");
      assert(kinds.has("stand-walk") && kinds.has("sit"), "poses " + [...kinds]);
      assert(bubbles.size >= 4, "few bubble texts " + [...bubbles]);
      return `bubbles: ${[...bubbles].join(" | ")}; walk "${walk.label}" (${walk.path.length} waypoints)`;
    });
    await check("member-assigned task runs on the chosen member (writer has a work step) and reaches approval", async () => {
      const t = await waitTask(srv, tMember.id, ["awaiting_approval"]);
      assert(t.steps.some((s) => s.kind === "work" && s.memberId === writer.id), "no writer work step: " + t.steps.map((s) => s.kind + ":" + s.memberId).join(","));
      await waitTask(srv, tMgr.id, ["awaiting_approval"]);
      const mgrTask = (await req("GET", `${srv.url}/api/tasks/${tMgr.id}`)).json.task;
      assert(mgrTask.steps.some((s) => s.kind === "brief" && s.memberId === mgr.id), "manager task has no manager brief");
    });
    await check("waiting member shows 'Needs you!' bubble and Approvals tab badge counts 2", async () => {
      const t0 = Date.now();
      try {
        await waitFor(page, () => Object.values(__officeDebug.bubbles()).includes("Needs you!"), null, 30000, "Needs you bubble");
        const lag = Date.now() - t0;
        assert(lag < 2500, `server member is already "waiting/Needs you!" but the canvas kept replaying queued hand-off walks for ${(lag / 1000).toFixed(1)} s before showing "Needs you!"`);
      }
      catch (e) {
        if (/replaying/.test(e.message)) throw e;
        const st = await apiState(srv);
        const dbg = await page.evaluate(() => __officeDebug.bubbles());
        throw new Error(`no "Needs you!" bubble. canvas bubbles=${JSON.stringify(dbg)} server members=${JSON.stringify(st.team.map((m) => [m.roleId, m.status, m.statusText]))} awaiting=${JSON.stringify(st.tasks.filter((t) => t.status === "awaiting_approval").map((t) => t.primaryMemberId))}`);
      }
      await waitFor(page, () => { const b = document.querySelector("#tab-approvals .badge"); return b && b.textContent === "2"; }, null, 5000, "badge 2");
    });

    // ---------------------------------------------------------------- click agent on canvas
    await check("clicking a sprite on the canvas opens the agent side panel with the current task link", async () => {
      await page.click("#tab-tasks");
      const pos = await page.evaluate((id) => __officeDebug.positions()[id], writer.id);
      const pt = await page.evaluate(([x, y]) => __officeDebug.worldToClient(x, y), [pos.x, pos.y - 8]);
      await page.mouse.click(pt.x, pt.y);
      await waitFor(page, (n) => document.querySelector("#view h2") && document.querySelector("#view h2").textContent === n, writer.name, 3000, "agent view");
      const txt = await page.textContent("#view");
      assert(/Content Writer/.test(txt) && /Responsibilities/.test(txt), "role/responsibilities");
      assert(txt.includes(`Post ${IMG2}`) || txt.includes("Manager routed blog"), "current task / outputs missing");
    });

    // ---------------------------------------------------------------- approvals: edit+approve, reject, export
    await check("approvals: reject without feedback blocked; reject with feedback -> revision -> back to approval", async () => {
      await page.click("#tab-approvals");
      const card = `[data-approval="${tMgr.id}"]`;
      await waitFor(page, (s) => !!document.querySelector(s), card, 5000, "card");
      await page.click(`${card} [data-action="reject"]`);
      await page.click(`${card} [data-action="send-feedback"]`);
      await waitFor(page, (s) => !!document.querySelector(`${s} .inline-err`), card, 3000, "feedback required");
      await page.fill(`${card} textarea[data-k="fb:${tMgr.id}"]`, `Make it shorter ${IMG2}`);
      await page.click(`${card} [data-action="send-feedback"]`);
      const t = await waitTask(srv, tMgr.id, ["revision", "in_progress", "checks", "qa_review", "awaiting_approval"], 10000);
      await waitTask(srv, tMgr.id, ["awaiting_approval"]);
      const full = (await req("GET", `${srv.url}/api/tasks/${tMgr.id}`)).json.task;
      assert(full.feedback.some((f) => f.text.includes("Make it shorter")), "feedback not stored");
      return `went through ${t.status}`;
    });
    await check("approvals: Edit -> type <script> text -> live counter -> Save & approve stores edit", async () => {
      const card = `[data-approval="${tMember.id}"]`;
      await waitFor(page, (s) => !!document.querySelector(s), card, 5000, "card");
      await page.click(`${card} [data-action="edit"]`);
      const ta = await page.waitForSelector(`${card} textarea[data-k^="edit:"]`, { timeout: 3000 }).catch(() => null);
      assert(ta, "no edit textarea");
      const key = (await ta.getAttribute("data-k")).split(":").pop();
      const txt = `Edited ${SCRIPT} #coffee`;
      await ta.fill(txt);
      const meter = await page.textContent(`${card} [data-item="${key}"] .meter`);
      assert(meter.startsWith(`${[...txt].length} `), "meter not live: " + meter);
      await page.click(`${card} [data-action="save-approve"]`);
      const t = await waitTask(srv, tMember.id, ["approved"], 8000);
      const it = t.output.items.find((i) => i.key === key);
      assert(it.text === txt && it.edited === true, "edit not stored");
      const p = await page.evaluate(XSS_PROBE);
      assert(p.flag === 0 && p.scripts === baseScripts, JSON.stringify(p));
    });
    await check("export: Markdown and JSON downloads contain the approved edited text", async () => {
      await page.evaluate((id) => { document.querySelector(`[data-approval]`); }, tMember.id);
      const md = await req("GET", `${srv.url}/api/tasks/${tMember.id}/export?format=md`);
      const js = await req("GET", `${srv.url}/api/tasks/${tMember.id}/export?format=json`);
      assert(md.status === 200 && md.body.includes("Edited <script>"), "md export");
      assert(js.status === 200 && JSON.stringify(js.json).includes("Edited <script>"), "json export");
      // via the UI link (download attribute)
      await page.click("#tab-tasks");
      await page.click(`#view [data-task="${tMember.id}"]`);
      const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 5000 }), page.click('a:has-text("Export Markdown")')]);
      const f = path.join(SHOTS, "qa-export.md");
      await dl.saveAs(f);
      const body = fs.readFileSync(f, "utf8");
      assert(body.includes("Edited <script>"), "downloaded md lacks edit");
      return `download filename: ${dl.suggestedFilename()}`;
    });
    await check("approvals: plain Approve of the remaining task", async () => {
      await page.click("#tab-approvals");
      const card = `[data-approval="${tMgr.id}"]`;
      await waitFor(page, (s) => !!document.querySelector(s), card, 5000, "card");
      await page.click(`${card} [data-action="approve"]`);
      await waitTask(srv, tMgr.id, ["approved"], 8000);
      await waitFor(page, () => /Nothing is waiting for you/.test(document.getElementById("view").textContent), null, 5000, "empty approvals");
      assert(!(await page.$("#tab-approvals .badge")), "badge still shown");
    });

    // ---------------------------------------------------------------- usage panel
    await check("usage panel: simulated totals > 0, per-member and per-role sections, top-bar summary", async () => {
      await page.click("#tab-usage");
      await waitFor(page, () => document.getElementById("view").dataset.view === "usage", null, 3000, "usage view");
      const txt = await page.textContent("#view");
      assert(/Usage \(simulated\)/.test(txt), "simulated label");
      const st = await apiState(srv);
      assert(st.usage.totals.input_tokens > 0, "no input tokens");
      assert(await page.$("#usageByMember") && await page.$("#usageByRole"), "sections");
      const top = await page.textContent("#usageSummary");
      const n = Number(top.replace(/[^0-9]/g, ""));
      assert(n === st.usage.totals.input_tokens + st.usage.totals.output_tokens, `top bar ${top} vs ${st.usage.totals.input_tokens + st.usage.totals.output_tokens}`);
    });

    // ---------------------------------------------------------------- activity feed live
    await check("activity feed: live prepend of new entries with member names", async () => {
      await page.click("#tab-activity");
      const before = await page.$$eval("#activityList li", (l) => l.length);
      await req("PATCH", `${srv.url}/api/team/${analytics ? (await apiState(srv)).team.find((m) => m.roleId === "analytics").id : ""}`, { name: "Ana Lytics" });
      await waitFor(page, (b) => document.querySelectorAll("#activityList li").length > b, before, 5000, "new row");
      const first = await page.textContent("#activityList li:first-child");
      assert(/Ana Lytics/.test(first), "first row: " + first);
    });

    // ---------------------------------------------------------------- queue position staleness
    await check("task detail: queue position updates when tasks ahead of it leave the queue", async () => {
      await req("PUT", srv.url + "/api/settings", { maxConcurrent: 1 });
      const mk = async (title) => (await req("POST", srv.url + "/api/tasks", { title, type: "social_post", platforms: ["x"], assignee: { mode: "member", memberId: writer.id } })).json.task;
      const a = await mk("Q-A"), b = await mk("Q-B"), c = await mk("Q-C");
      await page.click("#tab-tasks");
      await page.click(`#view [data-task="${c.id}"]`);
      await waitFor(page, () => /#\d+ waiting for a free slot/.test(document.getElementById("view").textContent), null, 5000, "queue position");
      const pos0 = (await page.textContent("#view")).match(/#(\d+) waiting/)[1];
      // wait until the server says C is first in queue
      const end = Date.now() + 40000;
      let serverPos = null;
      while (Date.now() < end) {
        const st = await apiState(srv);
        serverPos = st.queue.queued.indexOf(c.id);
        if (serverPos === 0) break;
        await sleep(150);
      }
      assert(serverPos === 0, "C never became first in queue");
      await sleep(600);
      const txt = await page.textContent("#view");
      const shown = (txt.match(/#(\d+) waiting/) || [])[1];
      // proof that the data is there: navigating away and back re-renders the correct position
      await page.click("#tab-tasks");
      await page.click(`#view [data-task="${c.id}"]`);
      await page.waitForTimeout(200);
      const after = ((await page.textContent("#view")).match(/#(\d+) waiting/) || [])[1];
      // clean up the queue
      for (const t of [a, b, c]) await req("POST", `${srv.url}/api/tasks/${t.id}/cancel`, {});
      await req("PUT", srv.url + "/api/settings", { maxConcurrent: 2 });
      assert(shown === "1", `detail still shows "#${shown}" (was #${pos0}) while server queue position is #1; after re-opening the detail it shows "#${after}"`);
    });

    // ---------------------------------------------------------------- global XSS check
    await check("XSS: no alert/confirm dialogs, no injected img/svg/script, window.__xss unset (tabs A and B)", async () => {
      for (const tab of ["team", "tasks", "approvals", "brand", "activity", "usage", "settings"]) {
        await page.click(`#tab-${tab}`); await page.waitForTimeout(150);
        await page2.click(`#tab-${tab}`); await page2.waitForTimeout(150);
      }
      await page.click("#tab-tasks");
      await page.click(`#view [data-task="${tMember.id}"]`);
      await page.waitForTimeout(200);
      for (const pg of [page, page2]) {
        const p = await pg.evaluate(XSS_PROBE);
        assert(p.flag === 0 && p.imgs === 0 && p.svgs === 0 && p.scripts === baseScripts, JSON.stringify(p));
      }
      assert(dialogs.length === 0, "dialogs: " + dialogs.join("; "));
    });

    // ---------------------------------------------------------------- narrow layout 390px
    await check("390x844: no horizontal page overflow on every tab, panels stacked, canvas scrollable", async () => {
      const ctxN = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      const pn = await ctxN.newPage();
      wire(pn, "N");
      await pn.goto(srv.url + "/");
      await waitFor(pn, () => document.getElementById("conn").textContent === "Live", null, 10000, "Live");
      const issues = [];
      for (const tab of ["team", "tasks", "approvals", "brand", "activity", "usage", "settings"]) {
        await pn.click(`#tab-${tab}`);
        await pn.waitForTimeout(150);
        const m = await pn.evaluate(() => ({
          sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, vw: window.innerWidth,
          view: document.getElementById("view").scrollWidth - document.getElementById("view").clientWidth,
          wide: [...document.querySelectorAll("#panel *")].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 3).map((e) => e.tagName + "." + e.className),
        }));
        if (m.sw > m.vw || m.view > 0 || m.wide.length) issues.push(`${tab}: ${JSON.stringify(m)}`);
      }
      await pn.screenshot({ path: path.join(SHOTS, "qa-390-settings.png"), fullPage: true });
      const lay = await pn.evaluate(() => {
        const o = document.getElementById("officeArea").getBoundingClientRect(), p = document.getElementById("panel").getBoundingClientRect();
        const w = document.getElementById("canvasWrap");
        return { stacked: p.top >= o.bottom - 1, wrapScroll: w.scrollWidth > w.clientWidth, wrapW: w.clientWidth, overflowX: getComputedStyle(w).overflowX };
      });
      if (!lay.stacked) issues.push("panel not stacked below office");
      if (!lay.wrapScroll || lay.overflowX !== "auto") issues.push("canvas wrap not horizontally scrollable " + JSON.stringify(lay));
      // dialog at 390
      await pn.click("#btnNewTask");
      const dlg = await pn.evaluate(() => { const r = document.getElementById("dlgTask").getBoundingClientRect(); return { l: r.left, r: r.right, vw: innerWidth }; });
      if (dlg.l < 0 || dlg.r > dlg.vw) issues.push("dialog overflows " + JSON.stringify(dlg));
      await pn.keyboard.press("Escape");
      // clicking an agent scrolls the panel into view
      const pos = await pn.evaluate((id) => __officeDebug.positions()[id], mgr.id);
      if (pos) {
        await pn.evaluate(([x]) => { const w = document.getElementById("canvasWrap"); w.scrollLeft = Math.max(0, x - 150); }, [pos.x]);
        const pt = await pn.evaluate(([x, y]) => __officeDebug.worldToClient(x, y), [pos.x, pos.y - 8]);
        await pn.mouse.click(pt.x, pt.y);
        await pn.waitForTimeout(800);
        const h2 = await pn.evaluate(() => document.querySelector("#view h2") && document.querySelector("#view h2").textContent);
        if (h2 !== mgr.name && h2 !== (await apiState(srv)).team.find((m) => m.id === mgr.id).name) issues.push("tap on manager sprite at 390px did not open agent panel (h2=" + h2 + ")");
      }
      await pn.screenshot({ path: path.join(SHOTS, "qa-390-agent.png"), fullPage: false });
      await ctxN.close();
      assert(issues.length === 0, issues.join(" | "));
    });
    await check("1920x1080 wide layout: office scales to 2x+, panel beside office, no overflow", async () => {
      const ctxW = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      const pw = await ctxW.newPage();
      wire(pw, "W");
      await pw.goto(srv.url + "/");
      await waitFor(pw, () => document.getElementById("conn").textContent === "Live", null, 10000, "Live");
      await pw.waitForTimeout(300);
      const m = await pw.evaluate(() => {
        const o = document.getElementById("officeArea").getBoundingClientRect(), p = document.getElementById("panel").getBoundingClientRect();
        return { scale: __officeDebug.scale, side: p.left >= o.right - 1, sw: document.documentElement.scrollWidth, vw: innerWidth };
      });
      await pw.screenshot({ path: path.join(SHOTS, "qa-1920.png") });
      await ctxW.close();
      assert(m.scale >= 2 && m.side && m.sw <= m.vw, JSON.stringify(m));
      return `scale ${m.scale}`;
    });

    // ---------------------------------------------------------------- SSE reconnect + persistence across restart
    await check("persistence: restart server on same data dir -> UI reconnects, brand + team + approved tasks intact", async () => {
      await srv.stop();
      await waitFor(page, () => /Reconnecting/.test(document.getElementById("conn").textContent), null, 10000, "Reconnecting");
      expectErrors = true;
      const srv2 = await startServer({ port: srv.port, dataDir: srv.dataDir, env: { MOCK_DELAY_MS: "250", HANDOFF_MS: "900" } });
      srv.stop = srv2.stop;
      await waitFor(page, () => document.getElementById("conn").textContent === "Live", null, 20000, "Live again");
      expectErrors = false;
      const st = await apiState(srv2);
      assert(st.brand.businessName === brandVals.businessName, "brand lost");
      assert(st.tasks.find((t) => t.id === tMember.id).status === "approved", "task status lost");
      assert(await page.textContent("#bizName") === brandVals.businessName, "top bar");
    });

    await check("no console errors / page errors across all pages", async () => {
      assert(consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" || "));
    });
  } catch (e) {
    fail("suite crashed", e.stack || String(e));
  } finally {
    await browser.close().catch(() => {});
    await srv.stop().catch(() => {});
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) { console.log("Failures:"); failed.forEach((f) => console.log(" -", f.name, "::", f.info)); }
  process.exit(failed.length ? 1 : 0);
})();
