---
description: Show harness effectiveness dashboard
---

# /hh-health

Run the Harness Harness health dashboard.

## Instructions

1. Run this command in the terminal: `harness-harness health $ARGUMENTS`
2. Parse the output and present it to the user conversationally
3. If there are pending proposals, summarize them and ask if the user wants to review
4. If `--all` flag is present, show the cross-repo health matrix
5. Highlight repos with STALE or CRITICAL status

## Arguments

- (none): Current repo health dashboard
- `--all`: Health across all registered repos
- `--repos <names>`: Specific repos, comma-separated (e.g., `--repos billing,auth`)
