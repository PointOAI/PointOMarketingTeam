// Test helpers: start/stop the real backend (MOCK=1) on a random high port with a temp data dir.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");

const REPO = path.resolve(__dirname, "../..");
const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), "pointo-shots");
fs.mkdirSync(SHOTS, { recursive: true });

function randPort() { return 20000 + Math.floor(Math.random() * 20000); }
function mkData() { return fs.mkdtempSync(path.join(SHOTS, "data-")); }

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b })); }).on("error", reject);
  });
}
function req(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j, body: b }); });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

async function startServer({ port = randPort(), dataDir = mkData(), env = {} } = {}) {
  const child = spawn(process.execPath, [path.join(REPO, "server.js")], {
    cwd: REPO, env: { ...process.env, MOCK: "1", MOCK_DELAY_MS: "300", HANDOFF_MS: "1500", PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await get(url + "/healthz"); if (r.status === 200) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return { child, port, url, dataDir, log: () => log,
    stop: () => new Promise((resolve) => { if (child.exitCode !== null) return resolve(); child.once("exit", () => resolve()); child.kill("SIGTERM"); setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000); }) };
}

module.exports = { startServer, randPort, mkData, get, req, SHOTS, REPO };
