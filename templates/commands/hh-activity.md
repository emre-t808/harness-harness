---
description: Show agent file activity heatmap
---

# /hh-activity

Show which files agents access most frequently.

## Instructions

1. Run: `harness-harness activity $ARGUMENTS`
2. Present the most accessed files with read/edit counts
3. Highlight files with high edit counts as potential hotspots
4. If cross-repo data is available, note cross-repo edit clusters

## Arguments

- (none): Current repo activity
- `--all`: Activity across all registered repos
- `--period <Nd>`: Time period (default: 7d)
