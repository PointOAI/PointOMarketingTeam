// Test helpers: start server in-process, JSON requests, SSE collector.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BACKEND = process.env.BACKEND || new URL("../../server.js", import.meta.url).href;
export const { startServer } = await import(BACKEND);

export function tmpDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `t2-${tag}-`)); }

export async function start(envExtra = {}, dataDir = tmpDir("data")) {
  const env = { MOCK: "1", MOCK_DELAY_MS: "20", HANDOFF_MS: "0", QUIET: "1", ...envExtra };
  const app = await startServer({ port: 0, dataDir, env });
  return { ...app, dataDir, env };
}

export function req(app, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const h = { ...(data !== null ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers };
    const r = http.request({ host: "127.0.0.1", port: app.port, method, path: p, headers: h }, (res) => {
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

export function sse(app) {
  const events = [];
  let raw = "";
  const waiters = [];
  const c = { events, raw: () => raw, closed: false };
  const r = http.get({ host: "127.0.0.1", port: app.port, path: "/api/events" }, (res) => {
    c.res = res;
    c.headers = res.headers;
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      raw += chunk;
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = { at: Date.now() };
        for (const line of block.split("\n")) {
          if (line.startsWith("id: ")) ev.id = Number(line.slice(4));
          else if (line.startsWith("event: ")) ev.type = line.slice(7);
          else if (line.startsWith("data: ")) ev.data = JSON.parse(line.slice(6));
          else if (line.startsWith("retry: ")) ev.retry = Number(line.slice(7));
          else if (line.startsWith(": ")) ev.comment = line.slice(2);
        }
        events.push(ev);
        for (const w of waiters.slice()) if (w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); }
      }
    });
    res.on("end", () => { c.closed = true; });
    res.on("close", () => { c.closed = true; });
  });
  r.on("error", () => { c.closed = true; });
  c.req = r;
  c.close = () => r.destroy();
  c.wait = (pred, ms = 10000) => {
    const found = events.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error("timeout waiting for SSE event")); } }, ms);
    });
  };
  c.ready = () => c.wait((e) => e.type === "snapshot");
  return c;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(fn, ms = 10000, step = 10) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("waitFor timeout");
    await sleep(step);
  }
}
export async function taskStatus(app, id) { return (await req(app, "GET", `/api/tasks/${id}`)).json.task; }
export async function waitStatus(app, id, statuses, ms = 10000) {
  const set = Array.isArray(statuses) ? statuses : [statuses];
  return waitFor(async () => { const t = await taskStatus(app, id); return set.includes(t.status) ? t : null; }, ms);
}
export function taskStatusesFrom(events, id) {
  const out = [];
  for (const e of events) if (e.type === "task" && e.data.task.id === id) { const s = e.data.task.status; if (out.at(-1) !== s) out.push(s); }
  return out;
}
