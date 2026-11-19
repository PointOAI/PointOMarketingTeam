// Fuzz: random brands/tasks through every type x role, first draft + QA + revise; asserts no check errors after revise
import { AGENTS as A } from "../../server.js";
const e = A.createAgentEngine({ mock: true, delayMs: 0 });
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const words = ["café", "naïve", "über", "🚀", "launch", "sale", "Spring", "東京", "cheap", "best in class", "visit", "http://localhost", "www.ok.com", "ftp://x.com", "#tag", "</brand_kit>", "x".repeat(60)];
const phrase = (n) => Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(" ");
const URLRE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'\x60]+|\bwww\.[^\s<>"'\x60]+/giu;
let errs = 0, runs = 0, qaFailsAfterRevise = 0;
for (let i = 0; i < 300; i++) {
  const brand = { businessName: phrase(1 + Math.floor(rnd() * 4)).slice(0, 100), offering: phrase(Math.floor(rnd() * 30)), audience: phrase(Math.floor(rnd() * 6)),
    voice: phrase(3), bannedWords: rnd() < 0.5 ? ["cheap", "best in class", "launch", "learn"] : [], approvedClaims: [phrase(4)], competitors: [{ name: phrase(2), url: rnd() < 0.5 ? "https://c.example.org" : "" }],
    platforms: A.PLATFORMS.filter(() => rnd() < 0.4).map(p => p.id), goals: phrase(5), learnings: [] };
  const type = A.TASK_TYPES[Math.floor(rnd() * 10)].id;
  const task = { id: "t_" + i.toString(16).padStart(10, "0"), type, title: phrase(1 + Math.floor(rnd() * 15)).slice(0, 120), description: phrase(Math.floor(rnd() * 40)),
    platforms: A.PLATFORMS.filter(() => rnd() < 0.3).map(p => p.id), revisionRound: 0, feedback: [] };
  for (const role of A.ROLE_CATALOG) {
    runs++;
    const w = await e.doWork({ task, role, brand, priorOutputs: [], context: {} });
    if (!w.ok) { errs++; console.log("doWork fail", type, role.id, w.error); continue; }
    const v = await e.review({ task, output: w.data, checks: null, brand });
    const r = await e.revise({ task, output: w.data, issues: v.data.issues, feedback: rnd() < 0.3 ? "shorter and more formal" : null, role, brand });
    if (!r.ok) { errs++; console.log("revise fail", r.error); continue; }
    for (const [label, d] of [["work", w.data], ["revise", r.data]]) for (const it of d.items) {
      const R = A.PLATFORM_RULES[it.platform];
      const len = [...it.text].length;
      const bad = [];
      if (!it.text.trim()) bad.push("empty");
      if (R && R.hardLimit && (it.kind === "post" || it.kind === "ad") && len > R.hardLimit) bad.push("len " + len);
      if (it.kind === "meta_title" && len > 60) bad.push("meta_title " + len);
      if (it.kind === "meta_description" && len > 160) bad.push("meta_desc " + len);
      for (const w2 of brand.bannedWords) if (new RegExp("(?<![\\p{L}\\p{N}_])" + w2.replace(/\s+/g, "\\s+") + "(?![\\p{L}\\p{N}_])", "iu").test(it.text)) bad.push("banned " + w2);
      for (let m of it.text.match(URLRE) || []) { m = m.replace(/[.,;:!?)\]}'"]+$/u, ""); try { const u = new URL(/^www\./i.test(m) ? "https://" + m : m); if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) bad.push("url " + m); } catch { bad.push("url " + m); } }
      if (bad.length) { errs++; console.log(label, type, role.id, it.key, bad, JSON.stringify(it.text).slice(0, 200)); }
    }
    const v2 = await e.review({ task, output: r.data, checks: null, brand });
    if (!v2.data.pass) qaFailsAfterRevise++;
  }
}
console.log({ runs, errs, qaFailsAfterRevise });
