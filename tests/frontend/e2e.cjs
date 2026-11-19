// Full UI flow against the real backend in mock mode (MOCK=1). Usage: node e2e.cjs
const { chromium } = require("playwright");
const { startServer, req, SHOTS } = require("./lib.cjs");
const assert = require("node:assert/strict");

const XSS = `<img src=x onerror="window.__xss=1">`;
const results = [];
function ok(name) { results.push(["PASS", name]); console.log("PASS", name); }

async function waitFor(page, fn, arg, timeout = 30000, label = "condition") {
  try { return await page.waitForFunction(fn, arg, { timeout, polling: 50 }); }
  catch (e) { throw new Error(`Timed out waiting for ${label}`); }
}
async function apiState(srv) { return (await req("GET", srv.url + "/api/state")).json; }
async function waitTask(srv, id, statuses, timeout = 40000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const t = (await req("GET", `${srv.url}/api/tasks/${id}`)).json.task;
    if (statuses.includes(t.status)) return t;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`task ${id} never reached ${statuses}`);
}

(async () => {
  let srv = await startServer();
  const port = srv.port, dataDir = srv.dataDir;
  const browser = await chromium.launch();
  const consoleErrors = [];
  const external = [];
  let allowErrors = false;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: srv.url });
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error" && !allowErrors) consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
    page.on("request", (r) => { if (!r.url().startsWith(srv.url + "/") && !r.url().startsWith("data:")) external.push(r.url()); });

    // ---------- 1. load ----------
    await page.goto(srv.url + "/");
    await waitFor(page, () => document.getElementById("conn").textContent === "Live", null, 10000, "Live");
    assert.equal(await page.isVisible("#demoBadge"), true);
    assert.equal(await page.getAttribute("#demoBadge", "title"), "No API key: agents produce simulated output");
    assert.equal(await page.isVisible("#emptyOverlay"), true);
    assert.match(await page.textContent("#emptyOverlay"), /Your office is empty — hire your team/);
    ok("load: Live, Demo mode badge with tooltip, empty-office overlay");
    await page.screenshot({ path: `${SHOTS}/office-empty-1440x900.png` });

    // ---------- 2. hire recommended via overlay ----------
    await page.click("#btnOverlayRecommended");
    await waitFor(page, () => Object.keys(__officeDebug.positions()).length === 7, null, 5000, "7 sprites");
    await waitFor(page, () => document.getElementById("emptyOverlay").hidden && document.querySelectorAll("#view .member-row").length === 7, null, 5000, "overlay hidden + 7 rows");
    ok("recommended team hired from overlay: 7 sprites + 7 team rows");

    // canvas properties + pixel sampling
    const canvasInfo = await page.evaluate(() => {
      const c = document.getElementById("office");
      const g = c.getContext("2d");
      const K = c.width / 512;
      const px = (x, y) => Array.from(g.getImageData(Math.round(x * K), Math.round(y * K), 1, 1).data.slice(0, 3));
      return { dbg: { scale: __officeDebug.scale, dpr: __officeDebug.dpr, backing: __officeDebug.backing, bg: __officeDebug.bgCanvas },
        wood: px(4, 300), wood2: px(140, 290), carpet: px(330, 250), carpet2: px(400, 300), hall: px(300, 20), wall: px(230, 100), door: px(231, 180) };
    });
    const near = (a, b, tol = 14) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
    const isWood = (p) => p[0] > 175 && p[0] < 220 && p[1] > 115 && p[1] < 160 && p[2] > 50 && p[2] < 95;
    const isCarpet = (p) => p[2] > 150 && p[0] < 100 && p[1] > 105 && p[1] < 145;
    assert.ok(isWood(canvasInfo.wood) && isWood(canvasInfo.wood2), "wood colour " + JSON.stringify([canvasInfo.wood, canvasInfo.wood2]));
    assert.ok(isCarpet(canvasInfo.carpet) && isCarpet(canvasInfo.carpet2), "carpet colour " + JSON.stringify([canvasInfo.carpet, canvasInfo.carpet2]));
    assert.ok(near(canvasInfo.hall, [235, 228, 214], 20), "hallway " + canvasInfo.hall);
    assert.ok(near(canvasInfo.wall, [28, 36, 54], 12), "wall " + canvasInfo.wall);
    assert.ok(isCarpet(canvasInfo.door), "doorway is carpet " + canvasInfo.door);
    assert.equal(canvasInfo.dbg.scale, 2);
    assert.equal(canvasInfo.dbg.backing.width, 1024 * canvasInfo.dbg.dpr);
    assert.equal(canvasInfo.dbg.backing.smoothing, false);
    assert.deepEqual(canvasInfo.dbg.bg, { width: canvasInfo.dbg.backing.width, height: canvasInfo.dbg.backing.height });
    ok(`canvas: scale 2, backing ${canvasInfo.dbg.backing.width}x${canvasInfo.dbg.backing.height}, smoothing off, wood ${canvasInfo.wood} carpet ${canvasInfo.carpet} hall ${canvasInfo.hall} wall ${canvasInfo.wall}`);
    const f0 = await page.evaluate(() => __officeDebug.frames);
    await page.waitForTimeout(1000);
    const f1 = await page.evaluate(() => __officeDebug.frames);
    ok(`rAF loop running: ${f1 - f0} frames/s (headless), fps gauge ${await page.evaluate(() => __officeDebug.fps)}`);

    // distinct appearances
    const st = await apiState(srv);
    const looks = new Set(st.team.map((m) => JSON.stringify(m.appearance)));
    assert.equal(looks.size, 7);
    ok("7 distinct appearances drawn from server data");

    // ---------- 3. hire optional with XSS name ----------
    await page.fill('#view [data-k="hire:community"]', XSS);
    await page.click('#view [data-hire="community"]');
    await waitFor(page, () => Object.keys(__officeDebug.positions()).length === 8, null, 5000, "8 sprites");
    await waitFor(page, (x) => [...document.querySelectorAll("#view .member-row")].some((r) => r.textContent.includes(x)), XSS, 5000, "XSS member name shown literally");
    ok("hire optional role with custom name (XSS payload rendered literally)");

    // ---------- 4. brand kit ----------
    await page.click("#tab-brand");
    await page.fill("#bk-businessName", `Acme ${XSS}`);
    await page.fill("#bk-offering", "Specialty coffee beans and brewing gear");
    await page.fill("#bk-audience", "Home baristas aged 25-45");
    await page.fill("#bk-voice", "Warm, witty, never pushy");
    await page.fill("#bk-banned", "cheap\nguaranteed");
    await page.fill("#bk-claims", "Roasted within 48 hours of shipping");
    await page.click("#addCompetitor");
    await waitFor(page, () => document.querySelectorAll(".comp-row").length === 1, null, 3000, "row 1");
    await page.click("#addCompetitor");
    await waitFor(page, () => document.querySelectorAll(".comp-row").length === 2, null, 3000, "row 2");
    await page.fill('[data-k="bk:cn:0"]', "BeanCo");
    await page.fill('[data-k="bk:cu:0"]', "not a url");
    await page.fill('[data-k="bk:cn:1"]', "Drop me");
    await page.click('[aria-label="Remove competitor 2"]');
    await waitFor(page, () => document.querySelectorAll(".comp-row").length === 1, null, 3000, "1 competitor row");
    for (const p of ["instagram", "x", "linkedin"]) await page.check(`input[name=brandPlatform][value=${p}]`);
    await page.fill("#bk-goals", "Grow newsletter sign-ups by 20%");
    allowErrors = true; // the browser logs the intentional 400 response as "Failed to load resource"
    await page.click("#brandSave");
    await waitFor(page, () => !!document.getElementById("brandErr"), null, 5000, "brand 400 error");
    allowErrors = false;
    const brandErr = await page.textContent("#brandErr");
    ok(`brand kit: server 400 shown inline: "${brandErr}"`);
    assert.equal(await page.inputValue('[data-k="bk:cn:0"]'), "BeanCo", "draft kept after error");
    await page.fill('[data-k="bk:cu:0"]', "https://beanco.example");
    await page.click("#brandSave");
    await waitFor(page, () => !document.getElementById("brandErr") && document.getElementById("bizName").textContent.startsWith("Acme"), null, 5000, "brand saved");
    const brand = (await req("GET", srv.url + "/api/brand")).json.brand;
    assert.equal(brand.businessName, `Acme ${XSS}`);
    assert.deepEqual(brand.bannedWords, ["cheap", "guaranteed"]);
    assert.deepEqual(brand.competitors, [{ name: "BeanCo", url: "https://beanco.example" }]);
    assert.deepEqual([...brand.platforms].sort(), ["instagram", "linkedin", "x"]);
    assert.equal(await page.textContent("#bizName"), `Acme ${XSS}`);
    assert.match(await page.textContent("#view"), /No learnings yet|Learnings/);
    ok("brand kit saved with all fields; business name literal in top bar; learnings section read-only");

    // ---------- 5. click a character -> agent panel ----------
    const writer = st.team.find((m) => m.roleId === "writer");
    const mgr = st.team.find((m) => m.roleId === "manager");
    const pos = await page.evaluate((id) => __officeDebug.positions()[id], mgr.id);
    const cpt = await page.evaluate(([x, y]) => __officeDebug.worldToClient(x, y), [pos.x, pos.y - 8]);
    await page.mouse.move(cpt.x, cpt.y);
    assert.equal(await page.evaluate(() => document.getElementById("office").style.cursor), "pointer");
    await page.mouse.click(cpt.x, cpt.y);
    await waitFor(page, () => /Marketing Manager/.test(document.getElementById("view").textContent) && /Responsibilities/.test(document.getElementById("view").textContent), null, 3000, "agent view");
    const agentTxt = await page.textContent("#view");
    for (const s of ["Responsibilities", "Cadence", "Weekly + on demand", "Status", "Current task", "Recent outputs", "Usage (simulated)", "Assign task", "Remove", "Rename"]) assert.ok(agentTxt.includes(s), "agent view has " + s);
    ok("click on sprite (pointer cursor) opens agent view with role, responsibilities, cadence, status, current task, outputs, usage, actions");

    // rename
    await page.fill(`[data-k="rename:${mgr.id}"]`, "Morgan");
    await page.click('[data-action="rename"]');
    await waitFor(page, () => document.querySelector("#view h2") && document.querySelector("#view h2").textContent === "Morgan", null, 5000, "rename");
    ok("rename from agent view");

    // assign task from writer agent view (preselected)
    await page.click("#tab-team");
    await page.click(`#view [data-member="${writer.id}"]`);
    await page.click('[data-action="assign"]');
    await waitFor(page, () => document.getElementById("dlgTask").open, null, 3000, "dialog");
    assert.equal(await page.inputValue("#dlgTask select[name=assignee]"), writer.id);
    ok("Assign task opens New task with the member preselected");
    // type-driven default platforms
    const checked = () => page.$$eval("#dlgTask input[name=platform]:checked", (els) => els.map((e) => e.value).sort());
    assert.deepEqual(await checked(), ["instagram", "linkedin", "x"]);
    await page.selectOption("#dlgTask select[name=type]", "blog_article");
    assert.deepEqual(await checked(), ["blog"]);
    await page.selectOption("#dlgTask select[name=type]", "email_campaign");
    assert.deepEqual(await checked(), ["email"]);
    await page.selectOption("#dlgTask select[name=type]", "seo_audit");
    assert.deepEqual(await checked(), []);
    await page.selectOption("#dlgTask select[name=type]", "social_post");
    assert.deepEqual(await checked(), ["instagram", "linkedin", "x"]);
    ok("new task: platform defaults follow platformScope (social=brand∩social, blog, email, any=none)");
    // client-side validation
    await page.click('#dlgTask button[type=submit]');
    assert.match(await page.textContent("#taskErr"), /Title is required/);
    await page.click('#dlgTask button:has-text("Cancel")');
    ok("new task: client-side validation (empty title)");

    // ---------- 6. manager-routed task through the UI ----------
    await page.click("#btnNewTask");
    await page.fill("#ntTitle", `Launch ${XSS}`);
    await page.fill("#ntDesc", "Announce our autumn blend with a call to try it.");
    await page.uncheck("#dlgTask input[name=platform][value=linkedin]");
    await page.selectOption("#dlgTask select[name=assignee]", "manager");
    await page.click('#dlgTask button[type=submit]');
    await waitFor(page, () => !document.getElementById("dlgTask").open, null, 5000, "dialog closed");
    const t1 = (await apiState(srv)).tasks.find((t) => t.title === `Launch ${XSS}`);
    assert.ok(t1);
    assert.deepEqual(t1.platforms, ["instagram", "x"]);
    assert.equal(t1.assignee.mode, "manager");
    ok("task created via UI (Manager decides, instagram + x)");

    // bubbles change live + hand-off walk with moving sprite + doorway route
    const seen = new Set();
    let walkSeen = null, moved = false, doorway = false;
    const end = Date.now() + 40000;
    while (Date.now() < end) {
      const snap = await page.evaluate(() => ({ b: __officeDebug.bubbles(), w: __officeDebug.walks(), p: __officeDebug.positions() }));
      Object.values(snap.b).forEach((b) => seen.add(b));
      if (snap.w.length) {
        const w = snap.w[0];
        if (!walkSeen) walkSeen = w;
        if (w.path.some((p) => p.x >= 224 && p.x < 240 && p.y >= 160 && p.y < 208)) doorway = true;
        const p1 = snap.p[w.memberId];
        await page.waitForTimeout(120);
        const p2 = await page.evaluate((id) => __officeDebug.positions()[id], w.memberId);
        if (p1 && p2 && (p1.x !== p2.x || p1.y !== p2.y)) moved = true;
      }
      const t = (await req("GET", `${srv.url}/api/tasks/${t1.id}`)).json.task;
      if (t.status === "awaiting_approval") break;
      await page.waitForTimeout(80);
    }
    assert.ok(walkSeen, "a hand-off walk happened");
    assert.ok(moved, "sprite position changed between frames");
    assert.ok(doorway, "manager<->wood walk routed through the doorway");
    assert.ok(seen.has("Writing brief") || seen.has("Drafting"), "working bubble seen: " + [...seen]);
    assert.ok(seen.has("Reviewing"), "reviewing bubble seen: " + [...seen]);
    ok(`status bubbles seen live: ${[...seen].join(", ")}; walk label "${walkSeen.label}" moved and routed via the doorway`);
    await page.screenshot({ path: `${SHOTS}/office-working-1440x900.png` });

    // null-target hand-off -> Needs you!
    await waitFor(page, (id) => __officeDebug.bubbles()[id] === "Needs you!", writer.id, 10000, "Needs you!");
    ok("awaiting approval: writer shows 'Needs you!' bubble");
    await waitFor(page, () => { const b = document.querySelector("#tab-approvals .badge"); return b && b.textContent === "1"; }, null, 5000, "approvals badge");
    ok("Approvals tab badge shows 1");
    await page.screenshot({ path: `${SHOTS}/office-needs-you-1440x900.png` });

    // ---------- 7. approvals ----------
    await page.click("#tab-approvals");
    await waitFor(page, () => document.getElementById("view").dataset.view === "approvals", null, 3000, "approvals view");
    const apTxt = await page.textContent("#view");
    assert.ok(apTxt.includes("Nothing is published automatically."));
    assert.ok(apTxt.includes(`Launch ${XSS}`), "task title literal");
    const tabs = await page.$$eval("#view [data-ptab]", (els) => els.map((e) => e.dataset.ptab));
    assert.ok(tabs.includes("instagram") && tabs.includes("x"), "platform tabs " + tabs);
    await page.click('#view [data-ptab="x"]');
    await waitFor(page, () => { const b = document.querySelector('#view [data-ptab="x"]'); return b && b.getAttribute("aria-selected") === "true"; }, null, 3000, "x tab");
    const meter = await page.textContent("#view .item-box .meter");
    assert.match(meter, /\/ 280 chars/);
    assert.match(meter, /hashtag/);
    ok(`approvals: platform tabs ${tabs.join("/")}, counts vs rules ("${meter.trim()}")`);
    // copy
    await page.click("#view [data-copy]");
    await waitFor(page, () => /Copied/.test(document.getElementById("toasts").textContent), null, 3000, "copied toast");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    const t1now = (await req("GET", `${srv.url}/api/tasks/${t1.id}`)).json.task;
    const xItem = t1now.output.items.find((i) => i.platform === "x");
    assert.equal(clip, xItem.text);
    ok("copy to clipboard copies the item text");
    // edit + approve
    await page.click('#view [data-action="edit"]');
    await waitFor(page, () => !!document.querySelector("#view .item-box textarea"), null, 3000, "edit mode");
    const ta = page.locator(`#view textarea[data-k="edit:${t1.id}:${xItem.key}"]`);
    await ta.fill("Edited by the owner: try our autumn blend today! #coffee");
    const meter2 = await page.textContent("#view .item-box .meter");
    assert.match(meter2, /^\s*5\d \/ 280 chars/);
    await page.click('#view [data-action="save-approve"]');
    const t1a = await waitTask(srv, t1.id, ["approved"], 5000);
    const xi = t1a.output.items.find((i) => i.key === xItem.key);
    assert.equal(xi.text, "Edited by the owner: try our autumn blend today! #coffee");
    assert.equal(xi.edited, true);
    assert.equal(t1a.approvedEdited, true);
    ok("edit + Save & approve: live char count, item edited:true, approved");
    await waitFor(page, () => !document.querySelector("#tab-approvals .badge"), null, 5000, "badge cleared");

    // ---------- 8. task detail timeline ----------
    await page.click("#tab-tasks");
    await page.click('#view .filters button:has-text("Done")');
    await page.waitForTimeout(200);
    assert.equal(await page.locator("#view [data-task]").count(), 1);
    await page.click(`#view [data-task="${t1.id}"]`);
    await waitFor(page, () => document.getElementById("view").dataset.view === "task", null, 3000, "task view");
    const det = await page.textContent("#view");
    for (const s of ["Brief", "Objective", "Key messages", "Timeline", "Output", "Checks", "QA verdict", "Export Markdown", "Export JSON", "Usage (simulated)"]) assert.ok(det.includes(s), "detail has " + s);
    const steps = await page.locator("#view .timeline li").count();
    assert.ok(steps >= 8, "timeline steps " + steps);
    const href = await page.getAttribute('#view a:has-text("Export Markdown")', "href");
    const md = await req("GET", srv.url + href);
    assert.equal(md.status, 200);
    assert.ok(md.body.includes("Edited by the owner"));
    ok(`task detail: brief, ${steps}-step timeline, output, checks, verdict, usage; export link works`);

    // ---------- 9. reject with feedback, then discard ----------
    const r2 = await req("POST", srv.url + "/api/tasks", { title: "Second post", description: "Promote the grinder", type: "social_post", platforms: ["x"], assignee: { mode: "member", memberId: writer.id } });
    assert.equal(r2.status, 201);
    const t2 = r2.json.task;
    await waitTask(srv, t2.id, ["awaiting_approval"]);
    await page.click("#tab-approvals");
    await waitFor(page, (id) => !!document.querySelector(`#view [data-approval="${id}"]`), t2.id, 5000, "t2 card");
    await page.click(`#view [data-approval="${t2.id}"] [data-action="reject"]`);
    await page.click(`#view [data-approval="${t2.id}"] [data-action="send-feedback"]`);
    await waitFor(page, (id) => !!document.querySelector(`#view [data-approval="${id}"] .inline-err`), t2.id, 3000, "feedback required");
    assert.match(await page.textContent(`#view [data-approval="${t2.id}"] .inline-err`), /feedback/i);
    await page.fill(`#view [data-k="fb:${t2.id}"]`, "Make it more playful.");
    await page.click(`#view [data-approval="${t2.id}"] [data-action="send-feedback"]`);
    await waitTask(srv, t2.id, ["queued", "revision", "checks", "qa_review"], 5000);
    const t2b = await waitTask(srv, t2.id, ["awaiting_approval"]);
    assert.equal(t2b.feedback.length, 1);
    ok("reject with feedback (required) -> revision -> awaiting approval again");
    await waitFor(page, (id) => !!document.querySelector(`#view [data-approval="${id}"]`), t2.id, 5000, "t2 card again");
    await page.click(`#view [data-approval="${t2.id}"] [data-action="reject"]`);
    await page.click(`#view [data-approval="${t2.id}"] [data-action="discard"]`);
    await waitTask(srv, t2.id, ["rejected"], 5000);
    ok("discard -> rejected");

    // ---------- 10. remove busy member -> 409 message; cancel + retry ----------
    const designer = st.team.find((m) => m.roleId === "designer");
    await req("PUT", srv.url + "/api/settings", { maxConcurrent: 1 });
    const blocker = (await req("POST", srv.url + "/api/tasks", { title: "Blocker", type: "news_digest", assignee: { mode: "member", memberId: st.team.find((m) => m.roleId === "research").id } })).json.task;
    const r3 = await req("POST", srv.url + "/api/tasks", { title: "Visual ideas", type: "social_post", platforms: ["instagram"], assignee: { mode: "member", memberId: designer.id } });
    const t3 = r3.json.task;
    await page.click("#tab-team");
    await page.click(`#view [data-member="${designer.id}"]`);
    await page.click('[data-action="remove"]');
    await waitFor(page, () => document.querySelector('[data-action="remove"]').textContent === "Confirm remove", null, 3000, "confirm remove");
    allowErrors = true; // intentional 409
    await page.click('[data-action="remove"]');
    await waitFor(page, () => !!document.querySelector("#view .inline-err"), null, 5000, "409 message");
    allowErrors = false;
    const msg409 = await page.textContent("#view .inline-err");
    assert.match(msg409, /Visual ideas|Blocker|task/i);
    ok(`remove busy member shows the server 409 message: "${msg409}"`);
    // cancel from detail, then retry
    await page.click("#tab-tasks");
    await page.click('#view .filters button:has-text("Active")');
    await page.waitForTimeout(200);
    await page.click(`#view [data-task="${t3.id}"]`);
    await page.click('#view [data-action="cancel"]');
    await waitTask(srv, t3.id, ["cancelled"], 5000);
    await waitFor(page, () => !!document.querySelector('#view [data-action="retry"]'), null, 5000, "retry button");
    await page.click('#view [data-action="retry"]');
    await waitTask(srv, t3.id, ["queued", "briefing", "in_progress", "checks", "qa_review", "revision", "awaiting_approval"], 5000);
    ok("cancel and retry from task detail");
    await req("PUT", srv.url + "/api/settings", { maxConcurrent: 2 });
    await waitTask(srv, blocker.id, ["awaiting_approval", "failed"]);
    await waitTask(srv, t3.id, ["awaiting_approval", "failed"]);

    // ---------- 11. activity, usage, settings ----------
    await page.click("#tab-activity");
    await waitFor(page, () => !!document.getElementById("activityList"), null, 3000, "activity view");
    const n1 = await page.locator("#activityList li").count();
    assert.ok(n1 > 10);
    const firstBefore = await page.textContent("#activityList li");
    await req("PATCH", `${srv.url}/api/team/${writer.id}`, { name: "Noa" });
    await waitFor(page, (f) => document.querySelector("#activityList li").textContent !== f, firstBefore, 5000, "activity prepend");
    assert.match(await page.textContent("#activityList li"), /Noa/);
    ok(`activity feed: ${n1} rows, new entries prepend live`);
    await page.click("#tab-usage");
    await waitFor(page, () => document.getElementById("view").dataset.view === "usage", null, 3000, "usage view");
    const us = await page.textContent("#view");
    assert.ok(us.includes("Usage (simulated)") && us.includes("By member") && us.includes("By role"));
    assert.match(await page.textContent("#usageSummary"), /tokens \(simulated\)/);
    ok("usage panel with totals, per member, per role, '(simulated)'");
    await page.click("#tab-settings");
    await waitFor(page, () => !!document.getElementById("dailyDigest"), null, 3000, "settings view");
    await page.check("#dailyDigest");
    await waitFor(page, () => /Settings saved/.test(document.getElementById("toasts").textContent), null, 5000, "settings saved");
    assert.equal((await req("GET", srv.url + "/api/settings")).json.settings.dailyDigest, true);
    await page.selectOption("#maxConcurrent", "3");
    await page.waitForTimeout(400);
    assert.equal((await req("GET", srv.url + "/api/settings")).json.settings.maxConcurrent, 3);
    // wait until no digest is in progress (enabling may have created one), then run now
    const end2 = Date.now() + 30000;
    while (Date.now() < end2) {
      const s2 = await apiState(srv);
      if (!s2.tasks.some((t) => t.source === "digest" && (t.status === "queued" || ["briefing", "in_progress", "checks", "qa_review", "revision"].includes(t.status)))) break;
      await page.waitForTimeout(200);
    }
    await page.click("#tab-settings");
    await waitFor(page, () => !!document.getElementById("runDigest"), null, 3000, "settings view");
    await page.click("#runDigest");
    await waitFor(page, () => /Digest task created/.test(document.getElementById("toasts").textContent), null, 5000, "digest created");
    ok("settings: digest toggle, concurrency, run digest now");

    // ---------- 12. XSS ----------
    const xss = await page.evaluate(() => ({ flag: window.__xss, imgs: document.querySelectorAll("img").length }));
    assert.equal(xss.flag, undefined);
    assert.equal(xss.imgs, 0);
    ok("XSS payloads in brand name, member name, task title and output stayed literal; window.__xss undefined, no <img>");

    // ---------- 13. reconnect ----------
    await page.screenshot({ path: `${SHOTS}/office-1440x900.png` });
    allowErrors = true;
    await srv.stop();
    await waitFor(page, () => document.getElementById("conn").textContent === "Reconnecting…", null, 10000, "Reconnecting…");
    ok("server stopped -> 'Reconnecting…'");
    srv = await startServer({ port, dataDir });
    await waitFor(page, () => document.getElementById("conn").textContent === "Live", null, 15000, "Live again");
    allowErrors = false;
    await page.click("#tab-team");
    await waitFor(page, () => document.querySelectorAll("#view .member-row").length === 8, null, 3000, "8 rows after restart");
    ok("server restarted -> recovered to 'Live' from a fresh snapshot (team intact)");

    // ---------- 14. responsive ----------
    for (const [w, hgt] of [[1024, 768], [800, 1000]]) {
      await page.setViewportSize({ width: w, height: hgt });
      await page.waitForTimeout(300);
      const lay = await page.evaluate(() => {
        const c = document.getElementById("office").getBoundingClientRect(), p = document.getElementById("panel").getBoundingClientRect();
        return { sw: document.documentElement.scrollWidth, iw: innerWidth, cRight: c.right, cBottom: c.bottom, pLeft: p.left, pTop: p.top, scale: __officeDebug.scale };
      });
      assert.ok(lay.sw <= lay.iw, `no page horizontal scroll at ${w}: ${lay.sw} > ${lay.iw}`);
      if (w >= 1024) assert.ok(lay.pLeft >= lay.cRight, "side by side at " + w);
      else assert.ok(lay.pTop >= lay.cBottom, "stacked at " + w);
      ok(`${w}x${hgt}: ${w >= 1024 ? "side by side" : "stacked"}, scrollWidth ${lay.sw} <= ${lay.iw}, scale ${lay.scale}`);
    }
    await page.screenshot({ path: `${SHOTS}/office-800x1000.png` });
    await page.screenshot({ path: `${SHOTS}/office-800x1000-full.png`, fullPage: true });

    // ---------- 15. overflow regression: long unbroken title + long URL, every view, two sizes ----------
    const LONG_TITLE = "X".repeat(40) + "Y".repeat(40) + "Z".repeat(40); // 120 chars, no spaces
    assert.equal(LONG_TITLE.length, 120);
    const LONG_URL = "https://example.com/" + "a1b2c3d4e5".repeat(48); // 500 chars, no spaces
    assert.equal(LONG_URL.length, 500);
    const writerNow = (await apiState(srv)).team.find((m) => m.roleId === "writer");
    const rl = await req("POST", srv.url + "/api/tasks", { title: LONG_TITLE, description: `See ${LONG_URL}`, type: "social_post", platforms: ["x"], assignee: { mode: "member", memberId: writerNow.id } });
    assert.equal(rl.status, 201, "long task created: " + rl.body);
    const tl = await waitTask(srv, rl.json.task.id, ["awaiting_approval"]);
    const measure = () => page.evaluate(() => {
      const v = document.getElementById("view");
      const wraps = [...document.querySelectorAll("#view .table-wrap, #view .usage-grid")].map((e) => [e.scrollWidth, e.clientWidth]);
      return { sw: document.documentElement.scrollWidth, iw: innerWidth, vsw: v.scrollWidth, vcw: v.clientWidth, view: v.dataset.view, wraps };
    });
    const checkNoOverflow = async (label) => {
      await page.waitForTimeout(150);
      const m = await measure();
      assert.ok(m.sw <= m.iw, `${label}: documentElement.scrollWidth ${m.sw} > innerWidth ${m.iw}`);
      assert.ok(m.vsw <= m.vcw, `${label}: #view.scrollWidth ${m.vsw} > clientWidth ${m.vcw}`);
      for (const [s, c] of m.wraps) assert.ok(s <= c, `${label}: table/usage block scrollWidth ${s} > clientWidth ${c}`);
      return m;
    };
    for (const [w, hgt] of [[800, 1000], [1024, 768], [1440, 900]]) {
      await page.setViewportSize({ width: w, height: hgt });
      const seenViews = [];
      for (const tab of ["team", "tasks", "approvals", "brand", "activity", "usage", "settings"]) {
        await page.click(`#tab-${tab}`);
        await waitFor(page, (id) => document.getElementById("view").dataset.view === id, tab, 3000, `${tab} view`);
        if (tab === "approvals") assert.ok((await page.textContent("#view")).includes(LONG_TITLE), "long title on approvals");
        if (tab === "tasks") {
          await page.locator("#view .filters button", { hasText: /^All$/ }).click();
          await waitFor(page, (id) => !!document.querySelector(`#view [data-task="${id}"]`), tl.id, 3000, "long task in task list");
        }
        await checkNoOverflow(`${w}x${hgt} ${tab}`);
        seenViews.push(tab);
      }
      // task detail with the long title + URL description
      await page.click("#tab-approvals");
      await page.click(`#view [data-approval="${tl.id}"] button.link`);
      await waitFor(page, () => document.getElementById("view").dataset.view === "task", null, 3000, "task detail");
      assert.ok((await page.textContent("#view")).includes(LONG_URL), "long URL shown in detail");
      await checkNoOverflow(`${w}x${hgt} task detail`);
      if (w === 800) await page.screenshot({ path: `${SHOTS}/overflow-task-800.png`, fullPage: true });
      // agent view of the writer (recent output has the long title)
      await page.click("#tab-team");
      await page.click(`#view [data-member="${writerNow.id}"]`);
      await waitFor(page, () => /Recent outputs/.test(document.getElementById("view").textContent), null, 3000, "agent view");
      assert.ok((await page.textContent("#view")).includes(LONG_TITLE), "long title in agent recent outputs");
      const ug = await page.locator("#view .usage-grid [data-usage]").count();
      assert.equal(ug, 6, "agent usage shows 6 labelled cells");
      await checkNoOverflow(`${w}x${hgt} agent view`);
      if (w === 1440) await page.screenshot({ path: `${SHOTS}/overflow-agent-1440.png` });
      ok(`${w}x${hgt}: no horizontal overflow (page, #view, usage blocks) on ${seenViews.join("/")}, task detail and agent view with a 120-char unbroken title + 500-char URL`);
    }
    // usage labels: counts are not called tokens
    await page.click("#tab-usage");
    await waitFor(page, () => document.getElementById("view").dataset.view === "usage", null, 3000, "usage view");
    const lbls = await page.$$eval('#usageByMember .usage-entry:first-child .ulbl', (els) => els.map((e) => e.textContent));
    assert.deepEqual(lbls, ["Input tokens", "Output tokens", "Cache read tokens", "Cache write tokens", "Web searches", "API calls"]);
    ok("usage cells labelled per metric (searches and calls are counts, not tokens)");
    // agent view: recent output summary is the member's own step summary
    const tFull = (await req("GET", `${srv.url}/api/tasks/${t1.id}`)).json.task;
    const ownStep = [...tFull.steps].reverse().find((s) => (s.kind === "work" || s.kind === "revision") && s.memberId === writer.id && s.summary);
    if (ownStep) {
      await page.click("#tab-team");
      await page.click(`#view [data-member="${writer.id}"]`);
      await waitFor(page, () => /Recent outputs/.test(document.getElementById("view").textContent), null, 3000, "agent view");
      assert.ok((await page.textContent("#view")).includes(ownStep.summary), "writer's own step summary shown");
      ok(`agent view recent outputs show the member's own step summary ("${ownStep.summary}")`);
    }

    assert.deepEqual(external, [], "external requests: " + external.join(", "));
    ok("no external network requests");
    assert.deepEqual(consoleErrors, [], "console errors: " + consoleErrors.join(" | "));
    ok("no console errors during load and the full demo flow");
  } catch (err) {
    console.error("FAIL", err.message);
    console.error("console errors so far:", consoleErrors);
    process.exitCode = 1;
  } finally {
    await browser.close();
    await srv.stop();
    console.log(`\n${results.length} checks passed${process.exitCode ? " before failure" : ""}.`);
  }
})();
