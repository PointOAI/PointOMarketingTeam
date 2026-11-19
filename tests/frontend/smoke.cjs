const { chromium } = require("playwright");
const { startServer, req, SHOTS } = require("./lib.cjs");
(async () => {
  const srv = await startServer();
  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`); });
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    await page.goto(srv.url + "/");
    await page.waitForTimeout(800);
    await page.screenshot({ path: SHOTS + "/smoke-empty.png" });
    await req("POST", srv.url + "/api/team/recommended", {});
    await page.waitForTimeout(800);
    await page.screenshot({ path: SHOTS + "/smoke-team.png" });
    console.log(await page.evaluate(() => ({ s: __officeDebug.scale, fps: __officeDebug.fps, b: __officeDebug.backing })));
  } finally {
    console.log("errors:", errors);
    await browser.close();
    await srv.stop();
  }
})();
