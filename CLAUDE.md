# CLAUDE.md — PointO AI Marketing Team ("Marketing Office")

Handoff for any Claude session (local Claude Code or cloud) picking up this repo.

## What this is

A local web app where a business owner hires a team of AI marketing agents. The agents sit in a
top-down **pixel-art office**, take tasks and hand work to each other. A human approves everything
before it counts as done. Nothing is ever posted to real social accounts.

- Backend and frontend live in **one file: `server.js`** (~6400 lines). The user asked for this. Keep it a single file.
- The only runtime dependency is `@anthropic-ai/sdk` (1.x). Node >= 22, ESM. No frameworks, no CDN, no build step.
- **Demo mode:** with no `ANTHROPIC_API_KEY`, or with `MOCK=1`, agents give realistic simulated output.
  Real mode and demo mode share the same pipeline code.

## Run

```bash
npm install
MOCK=1 npm start                         # demo mode -> http://127.0.0.1:3000
ANTHROPIC_API_KEY=sk-... npm start       # real Claude agents
```

Environment variables:

| Variable | Purpose |
|---|---|
| `PORT` | Port (default 3000) |
| `HOST` | Bind address (default `127.0.0.1`) |
| `DATA_DIR` | Where `state.json` is kept (default `./data`, gitignored) |
| `MOCK` | `1` forces demo mode |
| `MOCK_DELAY_MS` | Delay for demo-mode agent replies |
| `MODEL` | Agent model (default `claude-opus-5-5`) |
| `WORKER_MODEL` | Optional cheaper model for research/analytics |
| `ALLOWED_HOSTS` | Extra Host header names to accept |
| `QUIET` | Turns off logging |

## Map of `server.js`

Search for these section banners. `// =====` marks a top-level section; `// ---` marks a subsection.

1. **Frontend:** `const FRONTEND_HTML = \`...\`` runs to about line 2125. It is a JS template literal served at `GET /`. Sections inside it:
   - Utilities (safe DOM)
   - Client state
   - Render scheduling
   - Top bar & tabs
   - Team panel
   - New task dialog
   - Tasks list & detail
   - Approvals
   - Brand kit
   - Activity, usage, settings
   - Data flow (snapshot + SSE with reconnect)
   - Wiring
   - **Office canvas:** procedural pixel art, 60 fps, `window.__officeDebug` hooks used by tests
   - Boot
2. **Agents** (`// ===== Agents`):
   - Platform rules
   - Role catalog: 7 core roles + 3 optional, with prompts
   - Task types
   - JSON schemas for structured output
   - System prompt builder: the brand kit is the cached prefix
   - Routing (`defaultPlan`)
   - Normalisation of model output
   - Live engine (the Claude wrapper)
   - Mock engine
   - Engine factory
3. **Backend** (`// ===== Backend`):
   - Constants
   - Deterministic checks (`runChecks`)
   - State defaults & normalisation
   - Request validation
   - Persistence: atomic writes to `state.json`; a corrupt file is moved to `state.corrupt-*.json`
   - SSE broadcaster
   - HTTP helpers
   - The application: routes, task queue and the pipeline state machine

**Task pipeline:**

```
queued -> briefing (Manager) -> in_progress (specialist) -> checks -> qa_review
        -> revision (at most 2 automated) -> awaiting_approval (human)
        -> approved | rejected (feedback -> revision) | cancelled | failed
```

## Rules when changing code

- **Frontend is inside a template literal.** In any frontend code you add, escape backticks as `` \` `` and `${` as `\${`, and double every backslash. After the change, load `GET /` in a browser and check the console for errors.
- **Model and user text is untrusted.** Never use `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`. Use `textContent` or `createElement`. Tests check for XSS.
- **Claude API rules** (current SDK; breaking any of these gives a 400 error):
  - Thinking: use `thinking: {type: "adaptive"}` only. No `budget_tokens`, no `temperature`/`top_p`/`top_k`.
  - No assistant prefill, and no forced `tool_choice` (`any` or `tool`).
  - Structured output goes in `output_config: {effort, format: {type: "json_schema", schema}}`. The schema needs `additionalProperties: false`.
  - Web search uses the tool `web_search_20260209`.
  - Always handle the `stop_reason` values `refusal`, `max_tokens` and `pause_turn`.
- **Safety and product rules from `docs/RESEARCH.md`:**
  - A human approves before anything is "published"; never auto-publish.
  - Competitor monitoring uses public information only.
  - One QA reviewer, with at most 2 revisions.
- Bind to `127.0.0.1` by default. There is no authentication; the app is single-user and local.
- Host and Origin checks block cross-site requests (`421`/`403`). If you add a host, use `ALLOWED_HOSTS`; don't remove the checks.

## Tests

No API key is needed. Every test uses demo mode, a random port and a temporary data directory.
Playwright is used through `require('playwright')`.

```bash
node tests/lifecycle.test.mjs              # black-box: every endpoint, full lifecycle, restarts, crash
MOCK_DELAY_MS=5 node tests/agents/test.mjs
node tests/agents/fuzz.mjs
node tests/backend/checks.test.mjs
node tests/backend/http.test.mjs
node tests/backend/real.test.mjs
node tests/backend/pipeline.test.mjs       # builds a fake-agent copy into tests/backend/fake/ (gitignored)
node tests/backend/race.test.mjs
node tests/frontend/smoke.cjs
node tests/frontend/fixture.cjs
node tests/frontend/backoff.cjs
node tests/frontend/e2e.cjs
node tests/qa-agents-claude.test.mjs       # Claude request rules, stop reasons, errors (fake Anthropic API)
node tests/qa-api-backend.test.mjs
node tests/qa-frontend-e2e.cjs
```

Run the full set before pushing. Don't weaken or delete a test to make it pass.

## Status (as of 2026-11-19)

- **Built:** a cloud Claude session ran a multi-agent build: planner, dev supervisor with 3 developers, a QA team of 3, and a release reviewer.
- **Review result:** the release reviewer recommended shipping. All 15 suites pass, and all 11 QA findings were fixed and re-verified.
- **Branch:** `marketing-office-build`. This is the only branch; there is no `main` yet, and no PR is open.

**Open items, none blocking:**

1. **Never tested against the real Claude API** (no key was available).
   Do a live smoke run first: a Manager-routed social post, and a competitor report that uses web search.
2. A task that was running during a crash restarts from the beginning of its pipeline, so live mode repeats (and pays for) those API calls again.
3. Copy-to-clipboard has only been tested through the fallback path.
4. The 24-hour digest schedule has only been tested with short intervals.

**Possible next steps:**
- Create `main` or open a PR.
- Add authentication if this will ever be hosted.
- Real social or analytics integrations. These must still go through human approval.

## Docs

| File | Contents |
|---|---|
| `docs/RESEARCH.md` | Why the team looks like this: roster, workflow, sources |
| `docs/SPEC.md` | Product spec |
| `docs/PLAN.md` | Architecture and the original integration contract (the `parts/` files it mentions were merged into `server.js` and deleted) |
| `docs/RELEASE_REVIEW.md` | Spec checklist, pass/fail |
| `docs/screenshots/` | Screenshots of the app |
| `README.md` | User-facing docs |
