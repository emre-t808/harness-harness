# Changelog

## 0.2.0 (2026-04-06)

### Features

- **Automatic Daily Aggregation** — The Stop hook now checks if 24 hours have passed since the last analysis. If due, it runs the full pipeline inline: aggregate scores, generate proposals, auto-reorder routes, and clean up expired traces. No cron job or LaunchAgent needed.
- **Session Start Notifications** — The SessionStart hook checks for pending notifications and displays a one-liner ("Harness: N pending notification(s)") so users know when new proposals are available.
- **Notification System** — New `notifications.md` in `.harness/memory/` tracks daily analysis results for the next session to pick up.

### Changes

- `session-summary.js` (Stop hook) now calls `runDailyCheckIfDue()` after writing the session summary
- `session-start.sh` (SessionStart hook) checks `notifications.md` for pending items
- `init.js` substitutes `{{HARNESS_PACKAGE_DIR}}` in hook templates for dynamic imports
- `paths.js` adds `notificationsFile` path
- New public API exports: `runDailyCheckIfDue`, `runAggregation`, `getLastAggregationDate`, `writeNotification`
- New package export: `harness-harness/daily-check`

### Migration

Existing users: run `harness-harness init --force` to reinstall hooks with daily aggregation support.

## 0.1.1 (2026-04-02)

### Documentation

- Updated value proposition: "Coding agents harness LLMs — but who harnesses the coding agents?"
- New five-pillar framing: Focused, Updated, Reminded, Refueled, Learning
- Added technical documentation HTML page with architecture diagrams, hook lifecycle timeline, and self-improvement loop visualization
- Added disclaimer about Claude Code-only support
- Added hook compatibility FAQ to README

## 0.1.0 (2026-04-02)

First public release.

### Features

- **Smart Context Assembler** — Intent-based routing that classifies your message (frontend, backend, meta, general) and loads only relevant rules within a token budget
- **Trace Capture** — Every tool call Claude makes is recorded as a JSONL event with rule references, files touched, and outcomes
- **Effectiveness Scoring** — Each injected rule is scored at session end: 0.0 (ignored), 1.0 (referenced), 2.0 (prevented a mistake)
- **Weekly Analysis** — Aggregates scores across sessions, generates proposals to promote/demote rules, auto-reorders by effectiveness
- **Route Overrides** — Apply approved proposals to route configs (demotions, promotions, budget rebalancing)
- **Session Lifecycle** — Create, archive, and clean up session state directories with configurable retention
- **Trace Cleanup** — Delete expired raw trace files while preserving permanent summaries

### Hooks (7 Claude Code events)

- **SessionStart** — Creates session directory, injects git context and state on startup/resume/compact
- **UserPromptSubmit** — Smart Assembler with assembler-fallback safety net
- **PostToolUse** — Trace capture (all tools) + state nudge (Edit/Write)
- **Stop** — Session summary with effectiveness scores and slot utilization
- **PreCompact** — Saves working state snapshot before context compression
- **PostCompact** — Re-injects project identity, session state, and decisions after compaction
- **SessionEnd** — Catches missed Stop hooks, archives session state

### CLI Commands

- `harness-harness init` — Scaffold harness into any project (with `--merge`, `--replace`, `--trace-only` modes)
- `harness-harness health` — Effectiveness dashboard
- `harness-harness analyze` — On-demand weekly analysis with `--dry-run` and `--days` options
- `harness-harness apply` — Execute approved route override proposals
- `harness-harness cleanup` — Trace file retention management
- `harness-harness routes list` — List configured routes with budget breakdown
- `harness-harness routes create` — Create custom routes from templates

### Init Modes

- **Default** — Detects conflicting hooks, warns, installs alongside
- **--merge** — Explicitly installs alongside existing hooks
- **--replace** — Backs up existing UserPromptSubmit hooks, replaces with assembler
- **--trace-only** — Only installs tracing hooks (no context injection)

### Route Templates

- `general.md` — Default fallback for unmatched intents
- `coding-frontend.md` — Frontend/UI development
- `coding-backend.md` — Backend/API development
- `coding-meta.md` — Harness and tooling work
