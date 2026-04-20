---
intent: coding:backend
description: Backend development - APIs, logic, databases, tests
budget:
  identity: 10
  route_context: 30
  working_memory: 15
  traces: 10
  reserved: 35
---

## Identity
Your project identity (backend focus). Language, framework,
database, and key backend conventions.

## Route Context
### Must Load
- Add your backend-specific rules here
- Example: API-001: RESTful naming conventions
- Example: DB-001: Always use parameterized queries
- Example: TEST-001: Unit tests for all business logic

### Load If Budget Allows (ordered by effectiveness score)
- Add files with API docs, database schema, error handling patterns
- Example: docs/api-conventions.md (full)
- Example: docs/error-handling.md (full)
- Example: docs/database-patterns.md (full)

### Skip (low effectiveness for this route)
- Frontend-only rules (styling, components, design system)
- Documentation-only rules

## Working Memory
- .harness/sessions/{current}/state.md
- .harness/memory/work-status.md (Active Work section)

## Trace Insights
- Query: last 5 coding:backend sessions
- Include: API patterns, test coverage, error handling
