// FAKE agents for backend tests only (swapped into server.js by fake/build.mjs). Implements the PLAN section 3 contract closely enough to drive
// the backend: catalog, task types, platform rules, defaultPlan, missingRoleWarnings and a mock engine with a
// real heuristic QA (first social draft omits CTA -> QA fails once). Test hooks via task.description markers:
//   [fail-work]      doWork returns ok:false api_error
//   [fail-brief]     writeBrief returns ok:false api_error
//   [parse-brief]    writeBrief returns parse_error
//   [qa-unreadable]  review returns parse_error
//   [never-fix]      revise keeps the CTA missing (QA keeps failing -> escalation)
//   [slow]           every call takes 2000 ms (for cancel tests)
//   [long-x]         X post is 300 chars, revision shortens it
import crypto from "node:crypto";

const P = (id, label) => Object.freeze({ id, label });
export const PLATFORMS = Object.freeze([P("facebook", "Facebook"), P("instagram", "Instagram"), P("linkedin", "LinkedIn"),
  P("tiktok", "TikTok"), P("x", "X"), P("blog", "Blog"), P("email", "Email")]);
const R = (id, title, short, core, taskTypes) => Object.freeze({ id, title, short, core, responsibilities: [`${title} duties`],
  cadence: "Per brief", taskTypes, usesWebSearch: id === "research", modelTier: id === "research" || id === "analytics" ? "worker" : "main",
  systemPrompt: `You are the ${title}.` });
export const ROLE_CATALOG = Object.freeze([
  R("manager", "Marketing Manager", "Manager", true, ["content_calendar"]),
  R("research", "Research & Intelligence", "Research", true, ["news_digest", "competitor_report"]),
  R("seo", "SEO Specialist", "SEO", true, ["seo_audit", "blog_article"]),
  R("writer", "Content Writer", "Writer", true, ["social_post", "blog_article"]),
  R("designer", "Creative Designer", "Designer", true, ["social_post"]),
  R("qa", "Brand & QA Reviewer", "QA", true, []),
  R("analytics", "Analytics & Reporting", "Analytics", true, ["analytics_report"]),
  R("ads", "Paid Ads Specialist", "Ads", false, ["ad_copy"]),
  R("email", "Email/CRM Specialist", "Email", false, ["email_campaign"]),
  R("community", "Community Manager", "Community", false, ["custom"]),
]);
export const CORE_ROLE_IDS = ["manager", "research", "seo", "writer", "designer", "qa", "analytics"];
const S = (roles, optional = false) => ({ roles, optional });
export const TASK_TYPES = Object.freeze([
  { id: "social_post", label: "Social post", description: "d", route: [S(["writer"]), S(["designer"], true)], platformScope: "social" },
  { id: "blog_article", label: "Blog article", description: "d", route: [S(["seo"], true), S(["writer"])], platformScope: "blog" },
  { id: "seo_audit", label: "SEO audit", description: "d", route: [S(["seo", "writer"])], platformScope: "any" },
  { id: "competitor_report", label: "Competitor report", description: "d", route: [S(["research"])], platformScope: "any" },
  { id: "news_digest", label: "News digest", description: "d", route: [S(["research"])], platformScope: "any" },
  { id: "ad_copy", label: "Ad copy", description: "d", route: [S(["ads", "writer"]), S(["designer"], true)], platformScope: "social" },
  { id: "email_campaign", label: "Email campaign", description: "d", route: [S(["email", "writer"])], platformScope: "email" },
  { id: "content_calendar", label: "Content calendar", description: "d", route: [S(["manager", "writer"])], platformScope: "any" },
  { id: "analytics_report", label: "Analytics report", description: "d", route: [S(["analytics", "research"])], platformScope: "any" },
  { id: "custom", label: "Custom", description: "d", route: [S(["writer", "research", "seo", "designer", "analytics", "ads", "email", "community"])], platformScope: "any" },
]);
export const PLATFORM_RULES = {
  x: { label: "X", hardLimit: 280, recommended: [1, 280], hashtags: { max: null, recommended: [1, 2] } },
  linkedin: { label: "LinkedIn", hardLimit: 3000, recommended: [150, 1300], hashtags: { max: null, recommended: [3, 5] } },
  facebook: { label: "Facebook", hardLimit: 63206, recommended: [40, 250], hashtags: { max: null, recommended: null } },
  instagram: { label: "Instagram", hardLimit: 2200, recommended: [125, 150], hashtags: { max: 30, recommended: [3, 10] }, note: "x" },
  tiktok: { label: "TikTok", hardLimit: 2200, recommended: null, hashtags: { max: null, recommended: [3, 5] } },
  blog: { label: "Blog", hardLimit: null, recommended: null, hashtags: null },
  email: { label: "Email", hardLimit: null, recommended: null, hashtags: null },
  meta_title: { hardLimit: 60, recommended: [50, 60] },
  meta_description: { hardLimit: 160, recommended: [120, 160] },
  email_subject: { hardLimit: null, recommended: [1, 60] },
};
export const SCHEMAS = { brief: {}, deliverable: {}, verdict: {} };
export function isMockMode(env = process.env) { return env.MOCK === "1" || !env.ANTHROPIC_API_KEY; }
export function resolveModels(env = process.env) { const model = env.MODEL || "claude-opus-5-5"; return { model, workerModel: env.WORKER_MODEL || model }; }
export function buildSystemBlocks(role, brand) { return [{ type: "text", text: role.systemPrompt }, { type: "text", text: JSON.stringify(brand), cache_control: { type: "ephemeral" } }]; }
export function defaultPlan(taskType, team, opts = {}) {
  if (opts.onlyMemberId) { const m = team.find((x) => x.id === opts.onlyMemberId); return m ? [{ roleId: m.roleId, memberId: m.id, instructions: opts.instructions || "Do it." }] : []; }
  const type = TASK_TYPES.find((t) => t.id === taskType);
  const out = [];
  for (const slot of type.route) {
    const roleId = slot.roles.find((r) => team.some((m) => m.roleId === r));
    if (!roleId) continue;
    out.push({ roleId, memberId: team.find((m) => m.roleId === roleId).id, instructions: "Do your part." });
  }
  if (!out.length) { const m = team.find((x) => x.roleId !== "manager" && x.roleId !== "qa"); if (m) out.push({ roleId: m.roleId, memberId: m.id, instructions: "Do it." }); }
  return out.slice(0, 3);
}
export function missingRoleWarnings(team, taskType, assignee) {
  const w = [];
  const has = (r) => team.some((m) => m.roleId === r);
  if (!has("qa")) w.push("No Brand & QA Reviewer hired - output goes straight to your approval without QA review.");
  if (assignee.mode === "manager") {
    if (!has("manager")) w.push("No Marketing Manager hired - the task will be routed by default rules.");
    for (const slot of TASK_TYPES.find((t) => t.id === taskType).route) if (!slot.roles.some(has)) w.push(`No ${ROLE_CATALOG.find((r) => r.id === slot.roles[0]).title} hired - this task will be done without that step.`);
  }
  const plan = defaultPlan(taskType, team, assignee.mode === "member" ? { onlyMemberId: assignee.memberId } : {});
  if (!plan.length) w.push("Nobody on the team can do this task - hire a specialist.");
  return w;
}

const CTA = "Learn more today.";
function usageFor(s) { return { input_tokens: Math.ceil(s.length / 4) + 50, output_tokens: Math.ceil(s.length / 4), cache_read_input_tokens: 0, cache_creation_input_tokens: 0, web_search_requests: 0, calls: 1 }; }
function effPlatforms(task, brand) {
  if (task.platforms.length) return task.platforms;
  const scope = TASK_TYPES.find((t) => t.id === task.type).platformScope;
  if (scope === "social") { const s = brand.platforms.filter((p) => ["facebook", "instagram", "linkedin", "tiktok", "x"].includes(p)); return s.length ? s : ["linkedin", "x"]; }
  if (scope === "blog") return ["blog"]; if (scope === "email") return ["email"]; return brand.platforms;
}
function stripBanned(text, brand) { let t = text; for (const w of brand.bannedWords || []) t = t.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "great"); return t; }
function postText(platform, brand, withCta, long) {
  const name = brand.businessName || "your business";
  const base = {
    x: `${name} has something new for you. #news`,
    instagram: `Fresh from ${name}: something new is here and we think you will love it.\nCome and see.\n#new #local #love`,
    linkedin: `${name} is launching something new. ` + "We built it for teams who care about quality and service. ".repeat(3) + "#launch #business #growth",
    facebook: `Big news from ${name}: something new is here for you.`,
    tiktok: `New at ${name}! #new #fyp #local`,
  }[platform] || `Update from ${name}.`;
  let t = base + (withCta ? ` ${CTA}` : "");
  if (long && platform === "x") t = t + " " + "x".repeat(300);
  return t;
}

export function createAgentEngine({ mock, env = process.env, delayMs } = {}) {
  const delay = delayMs ?? Number(env.MOCK_DELAY_MS ?? 1200);
  const engine = { mode: mock ? "mock" : "live" };
  const wait = (task, signal) => new Promise((resolve) => {
    const ms = task.description.includes("[slow]") ? 2000 : delay;
    if (signal?.aborted) return resolve(false);
    const t = setTimeout(() => { signal?.removeEventListener("abort", ab); resolve(true); }, ms);
    const ab = () => { clearTimeout(t); resolve(false); };
    signal?.addEventListener("abort", ab, { once: true });
  });
  const cancelled = () => ({ ok: false, error: { code: "cancelled", message: "Cancelled", retryable: false }, usage: usageFor(""), stopReason: null, model: "m" });
  const ok = (data, summary) => ({ ok: true, data, usage: usageFor(JSON.stringify(data)), stopReason: "end_turn", truncated: false, model: "claude-opus-5-5", summary });
  engine.writeBrief = async ({ task, brand, team, signal }) => {
    if (!(await wait(task, signal))) return cancelled();
    if (task.description.includes("[fail-brief]")) return { ok: false, error: { code: "api_error", message: "API error 500 sk-test-123", retryable: true }, usage: usageFor("x"), stopReason: null, model: "m" };
    if (task.description.includes("[parse-brief]")) return { ok: false, error: { code: "parse_error", message: "bad json", retryable: false }, usage: usageFor("x"), stopReason: "end_turn", model: "m" };
    const steps = defaultPlan(task.type, team).map((p) => ({ roleId: p.roleId, instructions: p.instructions }));
    if (task.type === "social_post" && team.some((m) => m.roleId === "qa")) steps.push({ roleId: "qa", instructions: "should be dropped" });
    return ok({ objective: `Deliver ${task.title}`, audience: brand.audience || "customers", keyMessages: ["New"], platforms: effPlatforms(task, brand), tone: "friendly", steps, successCriteria: ["Clear CTA"] }, "Wrote the brief.");
  };
  engine.doWork = async ({ task, role, brand, priorOutputs, signal }) => {
    if (!(await wait(task, signal))) return cancelled();
    if (task.description.includes("[fail-work]")) return { ok: false, error: { code: "api_error", message: "Upstream API error (status 500)", retryable: true }, usage: usageFor("x"), stopReason: null, model: "m" };
    const plats = effPlatforms(task, brand);
    let items = [];
    if (role.id === "writer" || role.id === "ads" || role.id === "email" || role.id === "community") {
      items = plats.map((p, i) => ({ key: `${p}-post`, label: `${p} post`, platform: p, kind: "post", text: stripBanned(postText(p, brand, i !== 0, task.description.includes("[long-x]")), brand) }));
      if (task.description.includes("[banned]")) items[0].text += " cheap";
    } else if (role.id === "designer") {
      items = [{ key: "visual-1", label: "Visual concept", platform: "none", kind: "visual_concept", text: "A bright flat-lay photo." }];
    } else if (role.id === "analytics") {
      items = [{ key: "plan", label: "Measurement plan", platform: "none", kind: "report", text: "Track reach, saves, clicks. Learn more today." },
        { key: "learning-1", label: "Hypothesis 1", platform: "none", kind: "learning", text: "Posts with a question in the first line get more comments." }];
    } else if (role.id === "research") {
      return { ...ok({ summary: "Digest (simulated demo data)", items: [{ key: "report", label: "News digest", platform: "none", kind: "report", text: "Key news... (simulated). Learn more today." }], notes: "", sources: [{ title: "Demo source: news", url: "https://example.com/news" }] }, "Research digest done.") };
    } else {
      items = [{ key: `${role.id}-out`, label: `${role.title} output`, platform: "none", kind: "report", text: `Output by ${role.title}. Learn more today.` }];
    }
    void priorOutputs;
    return ok({ summary: `${role.title} produced ${items.length} items`, items, notes: `${role.id} notes`, sources: [] }, `Drafted ${items.length} item(s).`);
  };
  engine.review = async ({ task, output, checks, brand, signal }) => {
    if (!(await wait(task, signal))) return cancelled();
    if (task.description.includes("[qa-unreadable]")) return { ok: false, error: { code: "parse_error", message: "bad json", retryable: false }, usage: usageFor("x"), stopReason: "end_turn", model: "m" };
    const issues = [];
    for (const it of output.items) {
      if (["post", "ad"].includes(it.kind) && !it.text.includes(CTA)) issues.push(`${it.label} has no call to action.`);
      for (const w of brand.bannedWords || []) if (it.text.toLowerCase().includes(w.toLowerCase())) issues.push(`${it.label} uses "${w}".`);
    }
    if (checks && !checks.pass) issues.push("Checks reported errors.");
    const score = Math.max(0, 10 - issues.length * 4);
    return ok({ pass: score >= 7, score, issues, suggestions: issues.length ? ["Add a clear CTA."] : [] }, `Scored ${score}/10.`);
  };
  engine.revise = async ({ task, output, issues, feedback, brand, signal }) => {
    if (!(await wait(task, signal))) return cancelled();
    const never = task.description.includes("[never-fix]");
    const items = output.items.map((it) => {
      let text = it.text;
      if (["post", "ad"].includes(it.kind) && !text.includes(CTA) && !never) text += ` ${CTA}`;
      if (it.platform === "x" && [...text].length > 280) text = `${brand.businessName || "Us"}: new! #news ${CTA}`;
      text = stripBanned(text, brand);
      if (feedback) text += " (more playful)";
      return { key: it.key, label: it.label, platform: it.platform, kind: it.kind, text };
    });
    return ok({ summary: "Revised", items, notes: (output.notes || "") + (feedback ? `\nApplied feedback: ${feedback}` : ""), sources: [] }, `Revised fixing ${issues.length} issue(s).`);
  };
  void crypto;
  return engine;
}
