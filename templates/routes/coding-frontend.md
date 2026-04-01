---
intent: coding:frontend
description: Frontend development - UI, components, styling
budget:
  identity: 10
  route_context: 35
  working_memory: 10
  traces: 10
  reserved: 35
---

## Identity
Your project identity (frontend focus). Tech stack, component library,
design system, and key frontend conventions.

## Route Context
### Must Load
- Add your frontend-specific rules here
- Example: UI-001: Use design system tokens, not raw values
- Example: UI-002: All components must be accessible (WCAG 2.1 AA)
- Example: UI-003: Mobile-first responsive design

### Load If Budget Allows (ordered by effectiveness score)
- Add files with frontend conventions, design tokens, component patterns
- Example: docs/design-system.md (full)
- Example: docs/component-patterns.md (full)
- Example: docs/accessibility-checklist.md (full)

### Skip (low effectiveness for this route)
- Backend-only rules (API conventions, database patterns)
- Infrastructure/DevOps rules

## Working Memory
- .harness/sessions/{current}/state.md
- .harness/memory/work-status.md (Active Work section)

## Trace Insights
- Query: last 5 coding:frontend sessions
- Include: which UI rules were referenced, component patterns used
