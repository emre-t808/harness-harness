---
description: Import a rule from another repo
---

# /hh-share

Import a rule from another registered repo into the current repo.

## Instructions

1. Run: `harness-harness share $ARGUMENTS --to .`
2. The `--to .` flag is automatically added (always imports to current repo)
3. Tell the user which repo the rule came from and its effectiveness score
4. Remind them to add the rule ID to a route's Must Load section to activate it

## Arguments

- `<rule-id>`: The ID of the rule to import (e.g., `AUTH-001`)
