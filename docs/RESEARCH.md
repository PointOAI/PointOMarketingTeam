# Research: How to build an AI marketing team (synthesis)

Source: two research agents (human marketing team structure; AI multi-agent design), Nov 2026.
This document is the "research agent" knowledge base. Build agents should treat it as ground truth for product decisions.

## Key conclusions

1. **Organise agents by function, not by platform.** Real-world AI marketing teams (CrewAI marketing crew: 4 agents; Vercel marketing-team template: 1 lead + 5 specialists) use 4–7 functional agents. Vercel's template covers 5 social platforms with ONE social agent. Separate per-platform writers drift in brand voice because writing is sequential, context-heavy work — where multi-agent systems degrade (Anthropic, Google/DeepMind scaling study, Cognition).
2. **Multi-agent helps on parallel, read-only work** (research, news/competitor monitoring) and hurts on sequential shared-context work (writing in one brand voice). Use parallel sub-tasks only for research/monitoring.
3. **Start simple.** Anthropic: "find the simplest solution possible, and only increase complexity when needed." Multi-agent runs use ~15x chat tokens. Cap agent count, loop iterations and revisions.
4. **One separate critic beats self-review.** LLMs self-correct poorly without external feedback (ICLR 2024). Use: (1) deterministic checks in code (length, banned words, links), (2) ONE rubric-based QA reviewer agent, max 2 revision loops, (3) mandatory human approval before anything is published. More LLM review layers add cost without proven quality gain.
5. **Shared brand knowledge base is the single most important piece.** Every agent reads one brand kit (voice, audience, products, approved claims, banned words, competitors) at the start of each task. Keep a log of past outputs + performance.
6. **Never auto-publish.** Every product/template found (HubSpot Breeze, Jasper, Vercel template) keeps a human approve button before posting/sending/deleting. 2025 brand incidents came from unreviewed AI content.
7. **Competitor social monitoring: official APIs / public web only, no logged-in scraping** (LinkedIn sues scrapers; fake accounts violate every platform's ToS).
8. **Close the loop with analytics.** Gartner: analytics influence only 53% of marketing decisions. Analytics learnings must feed the next briefs.
9. **Human teams lose time to approvals** (Adobe 2025: 89% have 3+ approval stages). Use risk-tiered review with exactly one final approver.

## Recommended roster (default team)

| Agent | Responsibilities | Cadence |
|---|---|---|
| Marketing Manager (orchestrator) | Turns goals into a content calendar + briefs, routes work, tracks status. Never writes deliverables itself. | Weekly + on demand |
| Research & Intelligence | News, trends, competitor websites/social (public info), reviews. May fan out parallel sub-queries. | Daily digest |
| SEO Specialist | Keywords, content gaps, on-page recommendations, meta titles/descriptions, AI-answer visibility. | Weekly + per article |
| Content Writer | Blogs, web copy, email, ad copy AND every social platform via per-platform skills (Facebook, Instagram, LinkedIn, TikTok, X). | Per brief |
| Creative Designer | Image prompts / visual concepts, carousel layouts, video scripts & storyboards. | Per brief |
| Brand & QA Reviewer | Scores every output against a rubric (voice, banned words, claims, facts, platform spec). Pass/fail, max 2 revisions, then escalates to human. | Every piece |
| Analytics & Reporting | Weekly performance report; writes learnings to shared memory for future briefs. | Weekly |

Optional add-ons (add only when needed): Paid Ads Specialist, Email/CRM Specialist, Community Manager (drafts replies; human-approved).

Human role: the business owner / marketing lead — sets goals, approves strategy, final approval before publishing, crisis/PR, legal claims.

## Workflow

```
Monthly:  Human sets goals -> Manager builds content calendar
Daily:    Research agent -> news/competitor digest -> Manager
Per task: Manager brief -> (SEO keywords) -> Writer draft (per-platform skills)
          -> Creative visuals -> deterministic checks -> QA reviewer (<=2 revisions)
          -> HUMAN approval queue -> "published" -> Analytics measures -> learnings -> next briefs
```

## Platform specs for deterministic checks (practitioner conventions)

| Platform | Hard limit | Recommended |
|---|---|---|
| X | 280 chars | <= 280, 1–2 hashtags |
| LinkedIn post | 3000 chars | 150–1300 chars, 3–5 hashtags |
| Facebook post | 63206 chars | 40–250 chars |
| Instagram caption | 2200 chars, max 30 hashtags | 125–150 chars visible, 3–10 hashtags |
| TikTok caption | 2200 chars | short, 3–5 hashtags |
| Meta title | 60 chars | 50–60 |
| Meta description | 160 chars | 120–160 |
| Email subject | — | <= 60 chars |
