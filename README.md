# Harness Harness

**The self-improving agentic harness for Claude Code (which is a harness for Claude LLM).**

Coding agents harness LLMs. But who harnesses these coding agents?

Meet **Harness Harness** — a self-organizing harness that works alongside your existing hooks and keeps your agent **focused**, **updated**, **reminded**, **refueled**, and **learning** over time, automatically.

> **Disclaimer:** Harness Harness currently works with Claude Code only. Support for other coding agents is on the way. Use at your own risk (and enjoyment). All comments and suggestions are welcome.

## What It Does

Claude Code is a harness for the Claude LLM. Harness Harness is a harness for Claude Code. It observes what context your agent actually uses, measures its effectiveness, and continuously evolves to deliver better results — without you having to manually tune anything.

- **Focused** — Intent-based routing loads only the rules that matter for each task. Frontend work gets design system rules. Backend work gets API conventions. No more dumping everything into every prompt.
- **Updated** — Session state (objectives, decisions, blockers) persists to the filesystem. When Claude's context compacts, nothing is lost. Your agent always knows what it was doing.
- **Reminded** — Budget-aware assembly fills four priority slots (identity, route rules, working memory, traces) within a token budget. The right rules are always present, in the right order.
- **Refueled** — After compaction, critical context is re-injected automatically. Your agent recovers from context compression instead of losing its way.
- **Learning** — Every rule is scored by how often Claude actually references it. Weekly analysis generates proposals to optimize your config. Rules that help get promoted. Rules that waste tokens get demoted. The harness improves itself.

## How It Works

```
You send a message
    ↓
Smart Assembler classifies intent (frontend? backend? docs?)
    ↓
Loads the matching route config with effectiveness-ranked rules
    ↓
Fills budget slots: Identity → Route Rules → Working Memory → Traces
    ↓
Injects <harness-context> into Claude's system prompt
    ↓
Every tool call is traced (what was read, edited, referenced)
    ↓
Session ends → effectiveness scores calculated per rule
    ↓
Weekly analysis → proposals to promote/demote/rebalance
    ↓
You review → approved changes update route configs
    ↓
Next session starts with a better harness
```

## Installation

```bash
npm install -g harness-harness
```

Or use without installing:

```bash
npx harness-harness init
```

**Requirements:** Node.js 20+, Python 3 (for trace capture hook), Claude Code CLI.

## Quick Start

```bash
# 1. Navigate to your project
cd my-project

# 2. Initialize the harness
harness-harness init

# 3. Edit your routes with project-specific rules
$EDITOR .harness/routes/general.md

# 4. Use Claude Code normally — tracing starts automatically

# 5. After a few sessions, check your dashboard
harness-harness health

# 6. Run analysis to generate optimization proposals
harness-harness analyze
```

## Commands

| Command | Description |
|---------|-------------|
| `init` | Scaffold harness into your project |
| `health` | Show effectiveness dashboard |
| `analyze` | Run effectiveness analysis (weekly or on-demand) |
| `apply` | Apply approved route override proposals |
| `cleanup` | Delete expired trace files (keeps summaries) |
| `routes list` | List configured routes with budget breakdown |
| `routes create <name>` | Create a new custom route |

All mutating commands support `--dry-run` to preview changes.

## What Gets Created

```
your-project/
├── .harness/
│   ├── config.json              # Harness configuration
│   ├── routes/                  # Intent-based route configs
│   │   ├── general.md           # Default fallback route
│   │   ├── coding-frontend.md   # Frontend development
│   │   ├── coding-backend.md    # Backend development
│   │   └── coding-meta.md       # Tooling and harness work
│   ├── memory/
│   │   ├── harness-effectiveness.md  # Rule scores by route
│   │   ├── route-overrides.md        # Pending proposals
│   │   ├── trace-patterns.md         # Session pattern log
│   │   └── work-status.md            # Current work state
│   └── sessions/                # Session state directories
└── .claude/
    ├── hooks/                   # Auto-installed hooks
    │   ├── hh-assembler.js      # Smart context assembler
    │   ├── hh-trace-capture.sh  # Tool call tracer
    │   ├── hh-session-summary.js # Session analysis
    │   ├── hh-state-nudge.sh    # State update nudges
    │   └── hh-assembler-fallback.sh
    └── traces/                  # Raw trace data
        └── {date}/
            ├── {session}.jsonl
            ├── {session}-manifest.json
            └── {session}-summary.md
```

## Route Configuration

Routes are markdown files with YAML frontmatter that tell the assembler what to load for each type of task:

```markdown
---
intent: coding:frontend
budget:
  identity: 10
  route_context: 35
  working_memory: 10
  traces: 10
  reserved: 35
---

## Identity
Your project description and key conventions.

## Route Context
### Must Load
- UI-001: Use design tokens, not raw values
- UI-002: All components must be accessible

### Load If Budget Allows (ordered by effectiveness score)
- docs/design-system.md (full)
- docs/component-patterns.md (full)

### Skip (low effectiveness for this route)
- Backend-only rules
```

**Budget slots** divide the context window:
- **Identity** (10-15%) — Project description, always loaded
- **Route Context** (25-35%) — Task-specific rules and reference files
- **Working Memory** (10-15%) — Session state, active work
- **Traces** (10%) — Patterns from recent similar sessions
- **Reserved** (35%) — Left for Claude's actual work

## Custom Routes

Create routes for your project's specific workflows:

```bash
# Create a route for Python data science work
harness-harness routes create coding-python

# Create a route for infrastructure/DevOps
harness-harness routes create infra

# Edit the route with your rules
$EDITOR .harness/routes/coding-python.md
```

Add custom intent keywords in `.harness/config.json`:

```json
{
  "customIntents": [
    ["coding:python", ["pandas", "numpy", "jupyter", "dataframe", "matplotlib"]],
    ["infra", ["terraform", "docker", "k8s", "deploy", "ci", "pipeline"]]
  ]
}
```

## Effectiveness Scoring

Every rule injected into Claude's context is scored at session end:

| Score | Evidence | Meaning |
|-------|----------|---------|
| 0.0 | ignored | Rule was injected but never referenced |
| 0.5 | implicit | Claude followed the rule without citing it |
| 1.0 | referenced | Claude explicitly mentioned the rule |
| 2.0 | prevented-mistake | Claude read an anti-pattern and avoided the mistake |

Over time, these scores drive automatic optimization:
- Rules scoring >0.75 everywhere → promoted to Identity layer
- Rules scoring <0.10 in a route → proposed for demotion to Skip
- "Load If Budget Allows" items → auto-reordered by score (no approval needed)

## The Self-Improvement Loop

```
  Observe          Analyze          Propose          Review          Apply
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│  Trace    │──→│  Weekly  │──→│ Generate │──→│  Human   │──→│  Update  │
│  every    │   │  score   │   │ promote/ │   │ approve/ │   │  route   │
│  tool     │   │  aggre-  │   │ demote/  │   │  reject  │   │  configs │
│  call     │   │  gation  │   │ reorder  │   │          │   │          │
└──────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘
      ↑                                                            │
      └────────────────────────────────────────────────────────────┘
                        Next session uses improved harness
```

**Safety guarantees:**
- Rules with "prevented-mistake" evidence are never proposed for demotion
- Only reordering is auto-applied; promotions/demotions require your approval
- All changes are committed to git with full history
- `--dry-run` flag on every mutating command

## File-to-Rules Mapping

Map your rule files to their IDs for effectiveness-based ordering:

```json
{
  "fileToRules": {
    "design-system.md": ["UI-001", "UI-002", "UI-003"],
    "api-conventions.md": ["API-001", "API-002"],
    "testing-standards.md": ["TEST-001", "TEST-002"]
  }
}
```

This tells the assembler which rule IDs correspond to which files, enabling accurate effectiveness scoring and budget-aware loading.

## FAQ

**Does this slow down Claude Code?**
No. The assembler runs in <100ms. Trace capture is async and adds <20ms per tool call. Session summaries run at session end only.

**Does this read my code or messages?**
Traces capture tool names, file paths, output sizes, and (as of v0.4.0) the first 2KB of content written by `Edit` / `Write` tool calls (base64-encoded, stored as `response_snippet`). The snippet powers semantic verification of behavioral rules via the `content_includes` signal. If you prefer the v0.3.x behavior, set `trace.captureResponseSnippets: false` in `.harness/config.json`. Summaries still analyze which rules were referenced, not what you discussed.

**Can I use this with other AI coding tools?**
Currently designed for Claude Code's hook system. Support for other coding agents is planned. The core libraries (intent classification, effectiveness scoring, budget assembly) are generic and could be adapted for any tool with hook/plugin support.

**What happens if I delete .harness/?**
Claude Code continues to work normally. You lose your route configs, effectiveness history, and session state. Traces in .claude/traces/ are unaffected.

**Does this work with my existing hooks?**
Yes. Harness Harness is designed to work *alongside* your existing hooks, not replace them. All HH hooks are prefixed `hh-` to avoid collisions. The `init` command detects conflicts and offers three modes: `--merge` (install alongside), `--replace` (backup and replace), or `--trace-only` (just observe, don't inject context).

## Team Usage

### Initial Setup (team lead, once per repo)

```bash
harness-harness init
git add .harness/routes/ .harness/config.json .harness/memory/
git commit -m "feat: add harness-harness config"
```

### Developer Onboarding (each developer, on clone)

```bash
git clone <repo>
npm install        # or: npm i -g harness-harness
harness-harness init --local-only
```

### What to Commit vs Gitignore

| Commit (shared team config) | Gitignore (per-developer) |
|------------------------------|---------------------------|
| `.harness/routes/` | `.harness/local/` |
| `.harness/config.json` | `.claude/hooks/hh-*` |
| `.harness/memory/harness-effectiveness.md` | `.claude/settings.json` |
| `.harness/memory/route-overrides.md` | `.claude/traces/` |

### Developer Overrides

Create files in `.harness/local/` to override team config without affecting others:

```bash
# Override a route's budget and rules
cp .harness/routes/coding-backend.md .harness/local/routes/coding-backend.md
# Edit .harness/local/routes/coding-backend.md with your preferences

# Override project config (custom intents, fileToRules)
echo '{"customIntents": [["coding:python", ["pandas"]]]}' > .harness/local/config.json
```

Developer overrides are gitignored. No PR needed, no team impact.

### Sharing Improvements

1. Run `harness-harness analyze` locally
2. Review proposals: `cat .harness/local/memory/route-overrides.md`
3. If a proposal benefits the team, edit the shared route in `.harness/routes/`
4. Open a PR for team review

## License

Business Source License 1.1 — Free for personal and non-commercial use. Commercial use requires a license. Converts to Apache 2.0 on April 1, 2029.

See [LICENSE](./LICENSE) for full terms.
