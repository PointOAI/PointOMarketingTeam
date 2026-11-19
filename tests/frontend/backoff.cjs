// Verifies SSE reconnect backoff (1,2,4,8,10 s cap) while the server is down, recovery, and DPR=2 crisp scaling.
const { chromium } = require("playwright");
const { startServer, req, SHOTS } = require("./lib.cjs");
const assert = require("node:assert/strict");
(async () => {
  let srv = await startServer();
  const { port, dataDir } = srv;
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const attempts = [];
    page.on("request", (r) => { if (r.url().endsWith("/api/events")) attempts.push(Date.now()); });
    await page.goto(srv.url + "/");
    await req("POST", srv.url + "/api/team/recommended", {});
    await page.waitForFunction(() => document.getElementById("conn").textContent === "Live");
    await page.waitForTimeout(500);
    const dbg = await page.evaluate(() => ({ s: __officeDebug.scale, d: __officeDebug.dpr, b: __officeDebug.backing }));
    assert.equal(dbg.s, 2); assert.equal(dbg.d, 2);
    assert.equal(dbg.b.width, 2048); assert.equal(dbg.b.height, 1280); assert.equal(dbg.b.cssWidth, "1024px");
    console.log("PASS DPR 2: backing 2048x1280 for CSS 1024x640 (world*s*round(DPR))");
    await page.screenshot({ path: `${SHOTS}/office-1440x900-dpr2.png` });
    await srv.stop();
    const t0 = Date.now();
    attempts.length = 0;
    await page.waitForTimeout(33000);
    const gaps = attempts.map((t, i) => (i ? t - attempts[i - 1] : t - t0)).map((g) => Math.round(g / 100) / 10);
    console.log("reconnect attempt gaps (s):", gaps.join(", "));
    assert.ok(attempts.length >= 4 && attempts.length <= 7, "attempt count " + attempts.length);
    const later = gaps.slice(1);
    for (let i = 1; i < later.length; i++) assert.ok(later[i] >= later[i - 1] - 0.3, "non-decreasing gaps");
    assert.ok(Math.max(...gaps) <= 10.6, "capped at 10 s");
    assert.equal(await page.textContent("#conn"), "Reconnecting…");
    console.log("PASS exponential backoff capped at 10 s while down; badge shows Reconnecting…");
    srv = await startServer({ port, dataDir });
    await page.waitForFunction(() => document.getElementById("conn").textContent === "Live", null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => Object.keys(__officeDebug.positions()).length), 7);
    console.log("PASS recovered after restart from a fresh snapshot");
  } catch (e) { console.error("FAIL", e.message); process.exitCode = 1; }
  finally { await browser.close(); await srv.stop(); }
})();
