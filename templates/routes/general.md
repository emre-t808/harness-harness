---
intent: general
description: Default route for unmatched intents
budget:
  identity: 15
  route_context: 25
  working_memory: 15
  traces: 10
  reserved: 35
---

## Identity
Your project identity goes here. Describe what this project is,
the tech stack, and key conventions Claude should always know.

Edit this section or point to your CLAUDE.md.

## Route Context
### Must Load
- Add your most important rules here
- Example: STYLE-001: Use 2-space indentation, single quotes
- Example: ARCH-001: No circular dependencies between modules

### Load If Budget Allows (ordered by effectiveness score)
- Add files that provide useful context for general tasks
- Example: docs/conventions.md (full)
- Example: docs/architecture.md (overview section)

### Skip (low effectiveness for this route)
- (none — general route loads a balanced subset)

## Working Memory
- .harness/sessions/{current}/state.md
- .harness/memory/work-status.md (Active Work section)

## Trace Insights
- Query: last 5 sessions from trace-patterns.md
- Include: effectiveness scores, referenced rules
