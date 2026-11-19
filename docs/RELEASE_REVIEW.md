# Release review: PointO AI Marketing Team

Date: 2026-11-19 · Reviewer: final release reviewer (automated) · Mode tested: demo (`MOCK=1`); no API key is available here.

**Verdict: SHIP.** No blocking gaps. All 15 test suites pass. The only items not verified are ones this
environment cannot reach (listed under Known limitations).

## Test runs (this review)

| Suite | Result |
|---|---|
| tests/lifecycle.test.mjs (black-box, spawns `node server.js`) | 11/11 pass |
| tests/qa-agents-claude.test.mjs | 22/22 pass |
| tests/qa-api-backend.test.mjs | 27/27 pass |
| tests/agents/test.mjs | 32/32 pass |
| tests/agents/fuzz.mjs | 3000 runs, 0 check errors |
| tests/backend/checks.test.mjs | 25 pass |
| tests/backend/http.test.mjs | 8 pass |
| tests/backend/real.test.mjs | 6 pass |
| tests/backend/pipeline.test.mjs (fake agents) | 13 pass |
| tests/backend/race.test.mjs | pass |
| tests/frontend/smoke.cjs | pass, no console errors |
| tests/frontend/fixture.cjs | all pass |
| tests/frontend/backoff.cjs | all pass |
| tests/frontend/e2e.cjs | 40/40 pass |
| tests/qa-frontend-e2e.cjs | 33/33 pass |

Screenshots taken at deviceScaleFactor 2 with Playwright against a live mock server: `docs/screenshots/office.png`,
`office-handoff.png`, `needs-approval.png`, `approvals.png`, `narrow-800.png`. No console errors were logged
during the capture, and the 800 px layout had no horizontal overflow.

## Spec checklist

### Hard constraints
| Item | Result | Evidence |
|---|---|---|
| One source file `server.js` (backend + frontend served at `/`) | PASS | The frontend is an embedded template string; `node --check` passes |
| Only runtime dependency `@anthropic-ai/sdk` 1.x; Node built-ins only | PASS | package.json; installed 1.10.0; all other imports are `node:*` |
| No frameworks, no CDN assets, procedural canvas art | PASS | CSP headers; e2e asserts no external requests |
| `node server.js`, default 127.0.0.1:3000, `PORT`/`HOST` | PASS | http.test "default binding" |
| Demo mode when no key or `MOCK=1`, "Demo mode" badge, same pipeline | PASS | Badge visible in screenshot; qa-agents "MOCK=1 with key present" |
| Atomic JSON persistence in `DATA_DIR`; corrupt or missing file starts fresh | PASS | Write to temp file then rename; lifecycle corrupt-state and restart checks |

### Features
| Item | Result | Evidence |
|---|---|---|
| Role catalog (7 core + 3 optional) | PASS | Team tab; agents tests |
| Hire with a custom name, fire, "Recommended team" one-click | PASS | lifecycle; e2e; screenshot shows 7/10 |
| Each member gets a desk and a distinct character | PASS | office.png; lifecycle checks distinct desks |
| Warn, not block, on a missing role (e.g. no QA) | PASS | `missingRoleWarnings`; pipeline tests |
| Brand kit form with all fields; injected as a cached system prefix | PASS | `buildSystemBlocks`: `cache_control` on the brand kit block |
| Task create: title, description, 10 types, platforms, member or "Let the Manager decide" | PASS | API and dialog; e2e |
| State machine queued -> briefing -> in_progress -> checks -> qa_review -> revision (max 2) -> awaiting_approval -> approved / rejected -> revision | PASS | lifecycle walks every state |
| Visible hand-off walks | PASS | office-handoff.png; e2e hand-off checks |
| Deterministic checks: platform limits, hashtags, banned words, empty output, URLs | PASS | checks.test (25 cases); fuzz |
| QA verdict `{pass, score, issues, suggestions}` via json_schema | PASS | SCHEMAS.verdict; agents tests |
| Approval queue: per-platform tabs, QA score, checks, approve / reject with feedback / edit then approve, copy, export MD/JSON | PASS | approvals.png; lifecycle; e2e |
| Never auto-publishes | PASS | There is no publishing code path; the UI says "Nothing is published automatically" |
| Daily digest toggle (persisted, setInterval) | PASS | Settings; pipeline/real tests with short intervals |
| Activity feed with timestamps | PASS | Activity tab; e2e |
| Concurrency cap (default 2) with queueing; cancel; retry | PASS | real.test concurrency; race.test |
| Office: wood floor, blue carpet room, walls, desks, monitors, bookshelves, plants, sofa, picture | PASS | Closely matches reference-office.webp |
| Sprite states and dark rounded bubbles (Idle / Working / Reviewing / Needs you! / walking) | PASS | Screenshots |
| Click an agent opens a side panel (role, responsibilities, current task, outputs, Assign, Remove) | PASS | e2e |
| `imageSmoothingEnabled = false`, requestAnimationFrame loop, responsive at 1440/1024/800 | PASS | backoff (DPR) and e2e layout checks |
| SSE `/api/events` with automatic reconnect and backoff | PASS | backoff.cjs; lifecycle SSE |
| Token usage per agent and per task, shown in the UI | PASS | Usage tab; top-bar total (labelled "simulated" in demo mode) |

### Claude API rules (code review plus fake-client tests)
| Item | Result |
|---|---|
| `new Anthropic()`, default model `claude-opus-5-5`, `MODEL`/`WORKER_MODEL` env | PASS |
| `thinking: {type:"adaptive"}`; no budget_tokens, temperature, top_p, top_k or disabled thinking | PASS (grep finds none in request params) |
| `output_config.effort` (low/medium); `format: json_schema` for brief, verdict and deliverable | PASS |
| No prefill, no forced tool_choice | PASS |
| stop_reason handling: refusal (step fails), max_tokens (marked truncated), pause_turn (re-send with assistant content, capped at 5) | PASS |
| `web_search_20260209`, `max_uses: 5`, text blocks collected for Research | PASS |
| `max_tokens: 16000`, non-streaming | PASS |
| Typed errors, most specific first (RateLimitError before APIError); never crash | PASS |
| Prompt caching on the last stable system block | PASS |

### Security and robustness
| Item | Result |
|---|---|
| No innerHTML, outerHTML, insertAdjacentHTML or document.write; XSS payloads render as text | PASS |
| 1 MB body limit; JSON and field validation; 400/404/405/409/413/415 | PASS |
| API key never sent to the client | PASS (lifecycle scans every response and SSE event) |
| Hostile traffic and kill -9 mid-task never lose the server or the task | PASS |

## Known limitations (not blocking)

1. **Live Claude API calls have not run against the real API**, because this environment has no key. The
   request shape, stop reasons, errors and abort are covered only by fake-client tests. Do one live smoke run with a real key
   before announcing the release.
2. Copy-to-clipboard is tested only through the permission and fallback path, not on a real OS clipboard.
3. The 24 h digest timing is tested with short intervals, not in real time.
4. The Designer produces concepts and prompts, not image files. Nothing is published to social networks (by design).
5. The app is single-user and local, with no authentication. It is not meant to be exposed to the internet as is.
6. Tasks that were running during a crash restart from the beginning of their pipeline, which repeats those API calls.

## Open items

None blocking. Recommended follow-up: one live run with `ANTHROPIC_API_KEY` set (a social post task through the Manager, and a
competitor report that uses web search) to confirm that the API accepts the requests end to end.
