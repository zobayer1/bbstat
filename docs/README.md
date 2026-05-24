# ShipShow! documentation

Each doc is the canonical reference for one slice of the system. Cross-links
are inline; if you find yourself wanting the same content in two places, the
right move is usually to extract it here and link from both.

## Main feature docs

| Doc                        | Covers                                                                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`ROADMAP.md`](ROADMAP.md) | Phased plan, what's landed, what's deferred, what's next. Start here for the bird's-eye view.                                                                                                            |
| [`sync.md`](sync.md)       | Backpressure algorithm, the five sync queues, commit / PR / diff-stats / deepen / is-merge ticks, the `/api/activity` feed, live updates (SSE), tuning playbook. The workhorse doc.                      |
| [`scoring.md`](scoring.md) | ShipShow Score: per-commit scoring, 30-day-half-life decay, consistency, badge cascade, Steady Eddie tiers, member persona categorization (active / dormant / ex-member), recompute hooks.               |
| [`members.md`](members.md) | `/members` page surface — eligibility, sort / search / pagination, activity-status donut, Lorenz curve, sparkline column, SSE wiring, git-author email capture + admin backfill. Doubles as leaderboard. |

## Reference docs

| Doc                                      | Covers                                                                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`admin.md`](admin.md)                   | Every `/api/admin/*` endpoint — sync triggers, curated-set management, archive / rename / include, diff-stats exclusions, score recompute, email backfill. With curl examples.        |
| [`frontend-cache.md`](frontend-cache.md) | The `CACHE_VERSION` mechanism that wipes stale Pinia `localStorage` on shape changes. When to bump, side effects, multi-tab edge case, the matching manual Redis-bust for `bbstat:*`. |

## Where everything else lives

- **Architecture rules** (Postgres = truth, Redis = user-summary only, Pinia = browser cache, no auth today) — top-level [`CLAUDE.md`](../CLAUDE.md).
- **Run modes, deploy flows, env vars** — top-level [`README.md`](../README.md).
- **Release notes** — top-level [`CHANGELOG.md`](../CHANGELOG.md).
- **Memory** — `~/.claude/projects/-home-zobayer-Projects-personal-bbstat/memory/` (per-developer; not committed).
