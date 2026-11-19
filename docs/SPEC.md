# Product spec: PointO AI Marketing Team ("Marketing Office")

A web app where a business owner hires a team of AI marketing agents, sees them working in a
**top-down pixel-art office** (agents sit at desks, show status bubbles like "Idle", "Working",
"Reviewing", walk to each other when handing work off), assigns them tasks, and approves their output.

Read `docs/RESEARCH.md` first — product decisions come from it.

## Hard constraints

- **ONE source file:** `server.js` contains backend AND frontend (frontend HTML/CSS/JS embedded as a
  template string served at `/`). Plus `package.json`, `README.md`, `docs/`. Node 22+, ESM (`"type": "module"`).
- **Only runtime dependency:** `@anthropic-ai/sdk` (latest 1.x). Use Node built-ins (`node:http`, `node:fs`,
  `node:crypto`, `node:path`) for everything else. No Express, no frontend frameworks, no CDN assets.
  All pixel art is drawn procedurally on `<canvas>` (original art — do not copy any existing game's sprites).
- **Runs with `node server.js`**, default `http://127.0.0.1:3000` (env `PORT`, `HOST`).
- **Demo / mock mode:** if no Claude credentials are available (`ANTHROPIC_API_KEY` unset) or `MOCK=1`,
  agents produce realistic simulated outputs with short delays so the whole app works and is testable
  without an API key. The UI shows a "Demo mode" badge. Real mode and mock mode share the same pipeline code.
- **Persistence:** JSON file at `data/state.json` (env `DATA_DIR`), written atomically (write temp + rename).
  Survives restart. Corrupt/missing file -> start fresh without crashing.

## Features

### 1. Team builder (hire / fire)
- Catalog of roles from RESEARCH.md: Marketing Manager, Research & Intelligence, SEO Specialist, Content
  Writer, Creative Designer, Brand & QA Reviewer, Analytics & Reporting (core), plus optional Paid Ads
  Specialist, Email/CRM Specialist, Community Manager.
- User picks which members to add ("Hire"), can give each a custom name, and can remove them.
  A "Recommended team" one-click button hires the 7 core roles.
- Each hired member gets a desk in the office and a distinct procedurally drawn character (hair/shirt colours).
- Warn (not block) when the pipeline is missing a needed role (e.g. no QA reviewer -> output goes straight to human approval with a warning).

### 2. Brand kit (shared knowledge base)
- Form: business name, what you sell, target audience, brand voice/tone, words to avoid (banned words),
  approved claims, competitors (names + public URLs), active platforms (checkboxes: Facebook, Instagram,
  LinkedIn, TikTok, X, Blog, Email), goals.
- Injected into every agent's system prompt (as a stable, cache-friendly prefix).

### 3. Tasks
- User creates a task: title, description, type (social post, blog article, SEO audit, competitor report,
  news digest, ad copy, email campaign, content calendar, analytics report, custom), target platforms,
  and assignee: **a specific member** OR **"Let the Manager decide"** (Manager writes a brief and routes it).
- Pipeline per task (state machine, shown as a timeline in the task detail):
  `queued -> briefing (Manager) -> in_progress (specialist[s]) -> checks (deterministic) -> qa_review (QA agent)
   -> revision (back to specialist, max 2) -> awaiting_approval (human) -> approved | rejected (with feedback -> revision)`
- Hand-offs are visible in the office: the sprite of the agent passing work walks to the receiving agent's desk.
- Deterministic checks in code: per-platform character limits & hashtag counts (table in RESEARCH.md),
  banned words from brand kit, empty output, URL format. Failures are fed to the revision.
- QA agent returns structured verdict: `{pass: boolean, score: 0-10, issues: string[], suggestions: string[]}`.
- Approval queue: human sees final output (per platform tabs), QA score, checks; can Approve, Reject with
  feedback (sends back for revision), or Edit text then approve. Copy-to-clipboard and export (Markdown/JSON).
  **Nothing is ever auto-published to real social accounts.**
- Research agent daily digest: optional toggle "Run daily news & competitor digest" (setInterval, persisted setting).
- Activity feed: every agent action logged with timestamp.
- Concurrency: at most N (default 2) tasks running at once; others queue.
- Cancel a running task.

### 4. Office visualization (canvas)
- Top-down pixel office like the reference screenshot: wood floor area + blue carpet rooms, walls, desks with
  monitors, chairs, bookshelves, plants, sofa, wall picture. Desks laid out per hired member, labelled with name/role.
- Agent sprite states: idle (subtle bob), working (typing animation + "Working" bubble), reviewing, waiting
  for approval ("Needs you!" bubble), walking (hand-off). Status bubble shows a dark rounded label like the screenshot.
- Click an agent -> side panel: role, responsibilities, current task, recent outputs, "Assign task" button, "Remove".
- Smooth at 60fps, crisp pixel scaling (`imageSmoothingEnabled = false`), responsive to window size, works at
  laptop widths (>= 1024px) and degrades sensibly on narrow screens (office scrolls/scales, panels stack).

### 5. Real-time updates
- Server-Sent Events at `GET /api/events` push state changes (agent status, task status, new activity, approvals).
  Frontend reconnects automatically.

### 6. Usage & cost
- Track input/output tokens per agent and per task from `response.usage`; show totals in UI.

## Claude API rules (verified against the current SDK docs — follow exactly)

- `import Anthropic from "@anthropic-ai/sdk"; const client = new Anthropic();` (reads `ANTHROPIC_API_KEY`).
- Default model `claude-opus-5-5` (env `MODEL` overrides). Optional cheaper model for research/analytics
  only if env `WORKER_MODEL` is set; otherwise use the same model.
- Thinking: `thinking: { type: "adaptive" }`. **Never** send `budget_tokens`, `{type:"disabled"}`, `temperature`,
  `top_p`, `top_k` (all return 400). Effort: `output_config: { effort: "medium" }` (use `"low"` for simple steps).
- **No assistant prefill** (400). **No forced `tool_choice` `any`/`tool`** (400) — use `auto`.
- Structured output (QA verdict, manager brief): `output_config: { effort: "...", format: { type: "json_schema", schema: SCHEMA } }`
  on `client.messages.create`. Schema needs `additionalProperties: false` and `required`. Still parse defensively
  (`JSON.parse` in try/catch) and fall back gracefully.
- Always check `response.stop_reason` before reading content: handle `"refusal"` (mark step failed with a clear
  message), `"max_tokens"` (note truncation), `"pause_turn"` (re-send with the assistant content appended to continue).
- Research agent web access: server tool `{ type: "web_search_20260209", name: "web_search", max_uses: 5 }`
  (no separate code_execution tool). Results come back as content blocks; collect the `text` blocks for the output.
- Use `max_tokens: 16000` non-streaming.
- Errors: catch `Anthropic.RateLimitError`, `Anthropic.APIError` (typed classes, most specific first); SDK already
  retries 429/5xx twice. Show errors on the task and the agent, never crash the server.
- Prompt caching: put brand kit + role instructions in `system` as an array of text blocks with
  `cache_control: { type: "ephemeral" }` on the last stable block.

## Security & robustness
- Bind to 127.0.0.1 by default. Escape ALL model/user text before inserting into HTML (no `innerHTML` with raw
  content) — model output is untrusted. Limit request bodies (1 MB), validate JSON & field types/lengths,
  return 400 on bad input, 404 unknown routes. Never send the API key to the frontend.
- Server must not crash on any malformed request or API failure.

## API (minimum; planner may refine in docs/PLAN.md)
- `GET /` UI · `GET /api/state` full state · `GET /api/events` SSE
- `GET /api/roles` catalog · `POST /api/team` hire `{roleId, name?}` · `DELETE /api/team/:id` · `POST /api/team/recommended`
- `GET/PUT /api/brand`
- `POST /api/tasks` · `GET /api/tasks/:id` · `POST /api/tasks/:id/cancel`
- `POST /api/tasks/:id/approve` `{editedOutput?}` · `POST /api/tasks/:id/reject` `{feedback}`
- `PUT /api/settings` `{dailyDigest, maxConcurrent}`
- `GET /api/tasks/:id/export?format=md|json`
