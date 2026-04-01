---
intent: coding:meta
description: Harness and tooling work - hooks, routes, skills, agents
budget:
  identity: 15
  route_context: 25
  working_memory: 15
  traces: 10
  reserved: 35
---

## Identity
Your project identity (meta/tooling focus). Harness configuration,
hook architecture, and Claude Code integration patterns.

## Route Context
### Must Load
- Add rules about your harness configuration here
- Example: META-001: Hooks must never produce stdout unless intentional
- Example: META-002: Route configs must have valid YAML frontmatter
- Example: META-003: All scripts must support --dry-run

### Load If Budget Allows (ordered by effectiveness score)
- Add harness documentation and architecture files
- Example: .harness/README.md (full)
- Example: docs/hooks-architecture.md (full)

### Skip (low effectiveness for this route)
- Domain-specific business rules
- Frontend/backend implementation rules

## Working Memory
- .harness/sessions/{current}/state.md
- .harness/memory/work-status.md (Active Work section)

## Trace Insights
- Query: last 5 coding:meta sessions
- Include: hook modifications, route changes, config updates
