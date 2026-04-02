# Harness Harness — Audience Descriptions

Three versions of the same product, written for three different readers.

---

## Version 1: For Non-Technical People

**Who this is for:** Managers, founders, people evaluating AI coding tools, anyone who doesn't write code daily.

---

### Harness Harness

**Your AI coding assistant gets better at its job over time — without you doing anything.**

When developers use AI to write code, they give the AI instructions: "follow these rules," "remember these conventions," "here's how our project works." The problem is, AI assistants have a limited memory. They forget rules. They load irrelevant instructions. They lose track of what they were doing mid-task.

Harness Harness fixes this by sitting between the developer and their AI assistant. It watches what happens during each coding session and figures out:

- **Which instructions actually help** — and makes sure those show up first
- **Which instructions are being ignored** — and stops wasting memory on them
- **What the AI was working on** — and restores that context if memory runs low

Think of it like a personal assistant for your AI assistant. It keeps the AI focused on the right task, reminds it of the important rules, and learns from each session what works and what doesn't.

The result: the AI produces better code, wastes less time, and improves its own configuration over weeks — all automatically. The developer just uses their AI coding tool normally. Harness Harness handles the rest.

**Currently works with Claude Code. Support for other AI coding tools is planned.**

---

## Version 2: For Vibe Coders and Knowledge Workers

**Who this is for:** People who use Claude Code (or similar AI coding agents) regularly but aren't interested in configuring hooks or reading source code. They want it to work.

---

### Harness Harness

**Your Claude Code agent, but it actually remembers what matters.**

You know that thing where Claude forgets a rule you told it 20 minutes ago? Or where it loads your entire CLAUDE.md — design system rules, API conventions, database patterns — even when you're just writing a README? Or where it loses all context after a compaction and you have to re-explain everything?

Harness Harness stops all of that.

**What changes when you install it:**

- **It reads the room.** Ask about frontend? It loads your design rules. Ask about the API? It loads your backend conventions. No more dumping everything everywhere.
- **It remembers across sessions.** Your objectives, decisions, and blockers are written to a file. When context compacts, they come back automatically.
- **It gets smarter each week.** Every rule it injects is scored: did Claude actually use it, or did it waste tokens? Low-scoring rules get demoted. High-scoring ones get promoted. You don't have to do anything.

**Getting started:**

```bash
npx harness-harness init
# That's it. Use Claude Code normally.
# After a few sessions: npx harness-harness health
```

It installs alongside your existing setup. Nothing breaks. If you don't like it, delete the `.harness/` folder and everything goes back to normal.

One thing it won't do: make changes to your rules without asking. It proposes promotions and demotions, but you approve them. The only thing it does automatically is reorder rules by effectiveness — the safe stuff.

**Works with Claude Code today. Other agents later.**

---

## Version 3: For Harness Engineers

**Who this is for:** People building or maintaining context engineering systems for AI coding agents. Familiar with hook architectures, token budgets, system prompt injection, and feedback loops.

---

### Harness Harness

**A closed-loop context management system for Claude Code that optimizes its own injection strategy via per-rule effectiveness scoring.**

#### The Problem

Static context injection (CLAUDE.md, manual hooks) has no feedback mechanism. You inject N rules at K tokens per prompt, but you don't know which rules the model actually conditions on, which ones are noise, and how to reallocate budget across task types. Manual tuning doesn't scale — rule effectiveness varies by intent, changes over time, and has non-obvious interactions (a rule that scores 0.0 on average might be a silent safety net that prevents mistakes once a month).

#### Architecture

Harness Harness operates as a hook-based middleware layer:

```
UserPromptSubmit  →  Smart Assembler (classify intent → load route → fill budget slots → inject)
PostToolUse       →  Trace Capture (JSONL event stream, no stdout, no blocking)
PostToolUse       →  State Nudge (Edit|Write only, additionalContext for session state)
PreCompact        →  State Snapshot (flush working memory to disk pre-compression)
PostCompact       →  Context Refuel (re-inject identity + session state post-compression)
Stop              →  Session Summary (score rules, compute slot utilization, write manifest)
SessionStart      →  Session Init (create state dir, inject git context, restore state)
```

All hooks are prefixed `hh-` and use the matcher-group format in `settings.json`. They coexist with arbitrary user hooks via parallel execution — side-effect hooks produce no stdout, context injectors are additive.

#### Intent-Based Routing

Messages are classified into intent categories via keyword matching (extensible via `config.json`). Each intent maps to a route config (`.harness/routes/{intent}.md`) that specifies:

- **Budget allocation** — per-slot token percentages (identity/route_context/working_memory/traces/reserved)
- **Must Load** — rules always injected for this intent
- **Load If Budget Allows** — files loaded in effectiveness-score order until the slot budget is exhausted
- **Skip** — rules explicitly excluded for this intent (with score annotations)

#### Effectiveness Scoring

Per-session, per-rule scoring at four levels:

| Score | Evidence | Detection |
|-------|----------|-----------|
| 0.0 | ignored | Rule ID absent from all trace event `referenced_context` arrays |
| 0.5 | implicit | Behavioral compliance without explicit citation (future: classifier) |
| 1.0 | referenced | Rule ID present in at least one trace event's `referenced_context` |
| 2.0 | prevented-mistake | Rule ID found in `referenced_context` of a Read event on an anti-pattern file, followed by an Edit/Write within a 3-event window |

The 2.0 score is critical for safety: it protects rules that appear useless (0.0 average) but occasionally prevent expensive mistakes. Any rule with a single prevented-mistake event in its history is excluded from demotion proposals.

#### Self-Improvement Loop

The weekly analysis (`harness-harness analyze`) implements a constrained optimization:

1. **Aggregation** — Exponential moving average across sessions (recent sessions weighted 2x). Per-rule, per-route score matrices.
2. **Proposal generation** — Threshold-based: promote (>0.75 global), demote (<0.10 per-route), budget rebalance (utilization >70% or <40%).
3. **Auto-apply** — Only reordering within "Load If Budget Allows" sections. No additions, removals, or cross-section moves.
4. **Human gate** — Promotions, demotions, and budget changes require explicit approval via `route-overrides.md` status field.
5. **Rejection persistence** — Rejected proposals are recorded with reason and never re-generated.

All mutations are committed to git. The system maintains a full audit trail of its own evolution.

#### Conflict Model

Hook coexistence is analyzed per-event:

| Event | Output Type | Conflict Risk | Mitigation |
|-------|-------------|---------------|------------|
| UserPromptSubmit | stdout | High | Detect existing hooks, offer merge/replace/trace-only |
| PostToolUse (all) | none | None | Pure side-effect, always safe |
| PostToolUse (Edit\|Write) | additionalContext | Low | Merged with other additionalContext, <50 chars |
| PreCompact/PostCompact | none/stdout | Low | Additive stdout, side-effect pre |
| Stop/SessionEnd | none | None | Writes to own paths, never blocks |

The `--trace-only` init mode installs only observation hooks (PostToolUse + Stop), enabling effectiveness scoring without any context injection — useful for evaluating the system against an existing harness before migration.

#### Key Design Decisions

- **File-based state, not database** — routes, scores, proposals, session state are all markdown/JSON files in `.harness/`. Git-native, human-readable, editable.
- **Keyword classification, not embeddings** — intent classification uses regex word-boundary matching. Fast (<1ms), deterministic, no model dependency. Custom intents are arrays of `[intent, keywords[]]`.
- **Token estimation via chars/4** — rough but sufficient for budget allocation. No tokenizer dependency.
- **Manifest per turn** — the assembler writes a JSON manifest alongside each trace day-directory, recording exactly what was injected. The session summary reads this for ground-truth scoring (not inferred from ALWAYS_INJECTED lists).
- **No auto-deletion of rules** — the system can propose, reorder, and annotate, but only a human can remove a rule from a route. This constraint is load-bearing for safety-net rules.

```
npm install -g harness-harness    # or npx
harness-harness init              # scaffold + hook installation
harness-harness health            # effectiveness dashboard
harness-harness analyze           # run aggregation + proposals
harness-harness apply --dry-run   # preview approved changes
```

**v0.1.1 — Claude Code only. BSL 1.1 (Apache 2.0 after April 2029).**
