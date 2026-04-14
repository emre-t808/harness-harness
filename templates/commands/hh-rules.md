---
description: Search rules locally or across repos
---

# /hh-rules

Search for context rules in the current repo or across all registered repos.

## Instructions

1. If the user provides a query (e.g., `/hh-rules authentication`):
   Run: `harness-harness rules $ARGUMENTS`
2. If no query, run: `harness-harness rules list`
3. Present matching rules with their effectiveness scores and source repos
4. If cross-repo results are found, suggest importing with `/hh-share <rule-id>`

## Arguments

- `<query>`: Search across all registered repos
- `list`: List rules in current repo
- `list --tag <tag>`: Filter by tag
- `search <query>`: Search current repo only
- `ingest`: Ingest rules from external formats (CLAUDE.md, .cursorrules, …)
- `prune`: Identify underrated and ghost rules (dry-run, writes proposal)
- `prune --apply`: Apply the reviewed pruning proposal
