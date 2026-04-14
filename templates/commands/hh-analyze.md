---
description: Run harness effectiveness analysis
---

# /hh-analyze

Run effectiveness analysis on recent sessions.

## Instructions

1. Run: `harness-harness analyze --dry-run $ARGUMENTS`
2. Present the effectiveness scores and any proposals
3. Ask the user if they want to apply proposals (run without --dry-run)

## Arguments

- `--days <n>`: Analysis window in days (default: 7)
- `--team`: Write results to shared config instead of local
