# Harness Harness

**The self-improving agentic harness for Claude Code (which is a harness for Claude LLM).**

Coding agents harness llms. But who harnesses these coding agents? Meet Harness Harness. 

It is a self-organizing harness that works alongside your existing hooks and keeps your agent focused, updated, reminded, refueled and learn over time automatically.

Disclaimer: At the moment Harness Harness is only works with Claude Code, others are on the way. Use at your own risk (and enjoyment). All comments and suggestions are welcome.

## What It Does

Harness Harness is a context management system that sits between you and Claude Code. It observes what context Claude actually uses, measures its effectiveness, and continuously evolves to deliver better results.

**Instead of manually managing CLAUDE.md and hoping for the best, you get:**

- **Intent-based routing** — Different rules for different tasks. Frontend work gets design system rules. Backend work gets API conventions. No more dumping everything into every prompt.
- **Effectiveness scoring** — Every rule is scored by how often Claude actually references it. Rules that help get promoted. Rules that waste tokens get demoted.
- **Budget-aware assembly** — Context fills four priority slots (identity, route rules, working memory, traces) within a token budget. No more overflowing the context window with low-value information.
- **Session continuity** — Working state (objectives, decisions, blockers) persists to the filesystem. When Claude's context compacts, nothing is lost.
- **Self-improvement loop** — Weekly analysis generates proposals to optimize your route configs. Reordering happens automatically; promotions and demotions go through you.

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
Traces capture tool names, file paths, and output sizes — not file contents or message text. Summaries analyze which rules were referenced, not what you discussed.

**Can I use this with other AI coding tools?**
Currently designed for Claude Code's hook system. The libraries are generic and could be adapted for other tools with hook/plugin support.

**What happens if I delete .harness/?**
Claude Code continues to work normally. You lose your route configs, effectiveness history, and session state. Traces in .claude/traces/ are unaffected.

## License

Business Source License 1.1 — Free for personal and non-commercial use. Commercial use requires a license. Converts to Apache 2.0 on April 1, 2029.

See [LICENSE](./LICENSE) for full terms.
