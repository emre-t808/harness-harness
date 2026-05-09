# Changelog

## 0.5.0 (2026-05-09)

### Fixed (the headline issues)

- **Session-ID join (Finding 1).** `trace-capture.sh` now reads `session_id` from stdin first (falling back to `CLAUDE_SESSION_ID` env, then `unknown`) instead of relying on the env var alone. Trace files were silently being written to `unknown.jsonl` because the env var isn't set in many Claude Code hook contexts, which broke the join with `session-{id}-manifest.json` and stopped the Stop hook from ever producing summaries. Audit before/after: a Happiness install went from 0 summaries in the last 7 days to summaries on every session.
- **Silent error handling (Finding 3).** Every `} catch { /* non-fatal */ }` in `daily-check.js` is gone. Failures now emit structured `phase: error` records to `.harness/local/events.ndjson` with the step name, error message, and fatal flag, so operators can see exactly what is failing instead of getting a green `Done.` while half the pipeline crashed.

### Added

- **Event log + observability layer.** Every hook now appends a structured NDJSON record to `.harness/local/events.ndjson` with start/end timestamps, exit codes, decisions, and errors. Schema: `ts`, `event_id`, `session_id`, `hook`, `handler`, `phase` (`start`/`end`/`error`/`decision`), `exit_code`, plus optional `inputs`/`outputs`/`step`/`error`/`decision` payloads. Auto-rotates at 10 MB. Two new CLI commands:
  - `harness-harness tail` — `tail -f` the events log
  - `harness-harness explain [session_id]` — reconstruct a session's hook timeline (default: most recent), pairing start/end records into single entries with durations, surfacing orphan starts as crashed hooks. Supports `--json` for scripting.
- **Autonomous rule promotion / demotion (Finding 4).** Default-on. After `generateProposals`, daily-check feeds each proposal through `shouldAutoApply` with three gates:
  - Promotion: `weeks_above_threshold ≥ 3` AND `sessions_injected ≥ 5`
  - Demotion: `avgScore = 0` AND `sessions ≥ 5` on the same route
  - Cool-down: same rule cannot be auto-moved more than once per 7 days
  
  Every auto-application snapshots affected route configs into `.harness/local/reverts/{event_id}.json` first. Every decision (apply or skip) is logged to events.ndjson with the `action` and `reason`. New CLI:
  - `harness-harness revert` — list available rollback snapshots
  - `harness-harness revert <event_id>` — restore a snapshot
  
  Disable: `{ "autonomy": { "enabled": false } }` in `.harness/config.json`.
- **Delegate assembler (Finding 2).** Projects with their own assembler can take over context production via `{ "assembler": { "delegate": "scripts/my-assembler.js" } }`. The harness-harness assembler will exec the configured script with stdin piped through and emit its output verbatim, falling through to its own logic only if the delegate fails. Designed for cases like Happiness, where a richer bespoke assembler was running in parallel with the harness's own — producing two `<harness-context>` blocks per prompt.

### Migration for existing users (0.4.x → 0.5.0)

1. **Update:** `npx harness-harness@0.5.0 init --update`
2. **Old `unknown.jsonl` traces** remain on disk; new traces use `session-{id}.jsonl`. Both are readable by `analyze`.
3. **If you have a custom assembler in your project**, set `assembler.delegate` in `.harness/config.json` and remove the duplicate hook entry from `.claude/settings.json`.
4. **To opt out of autonomous promotion:** `{ "autonomy": { "enabled": false } }` in `.harness/config.json`. With the default gate (3 weeks above threshold + 5 sessions), no rule moves on day one of an upgrade — autonomy only kicks in once a rule has demonstrably been stable for several weekly analyses.

### Why this release matters

These four fixes turn harness-harness from "instrumented but blind" into "instrumented and observable." Before 0.5.0, the harness could detect rule effectiveness but you could not see what it did, why it didn't promote anything, or why summaries stopped appearing. After 0.5.0, every hook invocation is one queryable line in events.ndjson, and the harness can act on its own evidence.

## 0.4.0 (2026-04-14)

### Features

- **Semantic content verification** — New `content_includes` behavioral signal. Rules can verify that agent diffs contain required constructs (e.g., `content_includes: "\\btimingSafeEqual\\b"`). Matches produce a new `content-verified` evidence type scoring 1.0 (or 1.75 when combined with an explicit reference).
- **Rule pruning / write-back** — New `harness-harness rules prune` command. Identifies underrated and ghost rules, writes a review proposal, and on `--apply` rewrites the source files (with backups) and removes entries from `rules.yaml`. Never silent: two-step propose → apply flow.
- **Elo-unified promote/demote** — `weekly-analysis.js` now uses population-anchored thresholds (`mean ± σ`) derived from the Elo rating state. Falls back to the absolute `0.75` / `0.10` constants only when the rated population is under 10 rules. `formatProposals()` reports which threshold system was used.
- **Integration test coverage** — End-to-end tests for `rules ingest` (including nested CLAUDE.md ID uniqueness), propagation state roundtrip, daily-check → rule-rating persistence, and `rules prune` propose + apply.

### Privacy change

- Traces now capture the first 2KB of `Edit` / `Write` content as a base64-encoded `response_snippet` field. This enables `content_includes` verification. Users who want the v0.3.x behavior set `trace.captureResponseSnippets: false` in `.harness/config.json`.

### Migration

Run `harness-harness init --force` to regenerate hooks with the extended trace schema.

## 0.2.1 (2026-04-07)

### Bug Fixes — Multi-Repo & Team Support

This release fixes 10 bugs that prevented Harness Harness from working correctly when multiple developers share a repo. After this update, a second developer can clone a harness-initialized repo, run `init --local-only`, and have fully working context injection with personal overrides.

**Critical:**
- **Assembler now works without npm install** — The generated `hh-assembler.js` hook uses a multi-strategy import (bare specifier first, absolute path fallback) so it works in projects without `harness-harness` in `node_modules`
- **Partial budget overrides no longer clobber team values** — `parseRouteConfig` returns only explicitly-set budget keys; defaults are applied after merging (dev > team > defaults)

**Moderate:**
- **Fixed `\Z` regex anchor** — `loadWorkStatus` now uses `$` (valid JavaScript) instead of `\Z` (Python/PCRE only)
- **Developer identity in audit trail** — `markApplied` now writes "applied (date by developer)" to the overrides file
- **No more "undefined sessions"** — `formatProposals` uses fallback when session count is missing
- **Last `/tmp/` marker fixed** — `assembler-fallback.sh` session marker moved to `~/.cache/harness-harness/`

**Low:**
- **Relative paths in settings.json** — Hook commands now use `./.claude/hooks/...` instead of absolute paths
- **Atomic file locking** — `withFileLock` uses `O_EXCL` for race-free lock acquisition
- **Dead code removed** — Unused `loadFileToRules` function deleted
- **CLI accepts positional path** — `harness-harness init /path` now works (previously required `--project`)

### Migration

Existing users: run `harness-harness init --force` to regenerate hooks with all fixes.

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
