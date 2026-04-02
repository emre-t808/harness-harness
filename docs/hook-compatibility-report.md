# Harness Harness: Hook Compatibility Report

## 1. Claude Code Hook System Summary

Claude Code supports **24 hook events**. Hooks run **in parallel** (not sequentially). Multiple hooks for the same event all fire — the most restrictive decision wins for blocking events, and `additionalContext` from all hooks is merged.

### Settings.json Structure (IMPORTANT)

The actual structure uses **matcher groups**, not flat arrays:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "..." }
        ]
      },
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "..." }
        ]
      }
    ]
  }
}
```

Each entry in the event array is a **matcher group** containing a `matcher` regex and a `hooks` array. This is different from what we currently generate.

---

## 2. Hooks Harness Harness Needs

| Hook Event | HH Component | Purpose | Output Type |
|---|---|---|---|
| **UserPromptSubmit** | Smart Assembler | Inject `<harness-context>` block | stdout (context injection) |
| **UserPromptSubmit** | Assembler Fallback | Inject minimal rules if assembler fails | stdout (context injection) |
| **PostToolUse** (all tools) | Trace Capture | Append JSONL event to trace file | none (side-effect only) |
| **PostToolUse** (Edit\|Write) | State Nudge | Return `additionalContext` to update session state | JSON with additionalContext |
| **Stop** | Session Summary | Generate summary, archive session | none (side-effect only) |

**Hooks we should also consider adding:**

| Hook Event | Potential Use | Priority |
|---|---|---|
| **SessionStart** | Create session directory, restore state | High |
| **PreCompact** | Save working state before compaction | High |
| **PostCompact** | Re-inject critical context after compaction | High |
| **SessionEnd** | Final cleanup, ensure summary written | Medium |
| **PreToolUse** | Not needed (we observe, not control) | None |

---

## 3. Conflict Analysis Per Hook Event

### 3.1 UserPromptSubmit — HIGH CONFLICT RISK

**What HH does:** Injects `<harness-context>` XML block via stdout.

**How it works:** Every hook that writes to stdout has its output concatenated and shown to Claude as system context.

#### Scenario A: No existing hooks
- HH installs assembler + fallback. Works perfectly.

#### Scenario B: Non-conflicting existing hooks
- User has a hook that, e.g., logs prompts to a file (no stdout).
- Both run in parallel. No conflict.

#### Scenario C: Conflicting existing hooks
- User already has a context injection hook (e.g., their own rules reminder, a lean-reminder.sh).
- **Problem:** Claude receives TWO context blocks. Double the token overhead. Potentially contradictory rules.
- **Worse:** If the user's hook injects the same rules that HH's route config loads, Claude gets duplicated instructions.

**Resolution strategy:**

| Mode | Behavior |
|---|---|
| `init` (default) | Detect existing UserPromptSubmit hooks. If found, **warn** and ask user to choose mode. |
| `init --merge` | Install alongside. Both fire. User accepts double-injection. |
| `init --replace` | Back up existing hooks to `.harness/hooks-backup/`. Replace with HH assembler. |
| `init --trace-only` | Skip assembler entirely. Only install tracing (PostToolUse + Stop). User keeps their own context system but gains effectiveness scoring. |

**Detection logic:**
```
If settings.hooks.UserPromptSubmit exists AND has entries with hooks that produce stdout:
  → Conflict detected
  → Show warning with options
```

---

### 3.2 PostToolUse (all tools) — LOW CONFLICT RISK

**What HH does:** Trace capture writes one JSONL line to a file. No stdout. No additionalContext.

**How it works:** Pure side-effect. Reads stdin JSON, appends to `.claude/traces/{date}/{session}.jsonl`, exits 0 with no output.

#### Scenario A: No existing hooks
- HH installs trace capture with empty matcher (all tools). Works perfectly.

#### Scenario B: Non-conflicting existing hooks
- User has a PostToolUse hook for `Edit|Write` that runs prettier.
- Both run in parallel. HH traces the event, user's hook formats the file. No conflict.

#### Scenario C: Conflicting existing hooks
- User has their own PostToolUse hook with empty matcher that also writes to stdout or returns additionalContext.
- **No conflict for trace capture** — it produces no output.
- Two hooks with empty matcher both fire for every tool call. This is fine because HH's hook is side-effect-only.

**Resolution:** No special handling needed. Always safe to install alongside any existing PostToolUse hooks.

---

### 3.3 PostToolUse (Edit|Write) — MEDIUM CONFLICT RISK

**What HH does:** State nudge returns `{"additionalContext": "..."}` JSON.

**How it works:** Returns JSON with additionalContext asking Claude to update session state.

#### Scenario A: No existing hooks
- HH installs state nudge with `Edit|Write` matcher. Works perfectly.

#### Scenario B: Non-conflicting existing hooks
- User has a PostToolUse hook for `Edit|Write` that runs a formatter (no additionalContext).
- Both run in parallel. Formatter formats, nudge nudges. No conflict.

#### Scenario C: Conflicting existing hooks
- User has a PostToolUse hook for `Edit|Write` that also returns `additionalContext`.
- **Both additionalContext strings are merged** and shown to Claude.
- Risk: Claude gets two nudges per edit, which is noisy but not breaking.

**Resolution:** Low risk. The nudge is small (<50 chars). Accept the merge. If users complain about noise, they can disable the nudge:
```bash
harness-harness init --no-nudge
```

---

### 3.4 Stop — LOW CONFLICT RISK

**What HH does:** Session summary reads trace JSONL, scores effectiveness, writes summary file, archives session.

**How it works:** Pure side-effect. No stdout. No additionalContext. No blocking (exit 0).

#### Scenario A: No existing hooks
- HH installs session summary. Works perfectly.

#### Scenario B: Non-conflicting existing hooks
- User has a Stop hook that runs tests or commits. Both fire in parallel. No conflict.

#### Scenario C: Conflicting existing hooks
- User has a Stop hook that ALSO reads trace files or writes summaries.
- **Race condition:** Both hooks read the same JSONL file simultaneously. Reading is safe.
- **File write conflict:** If both write to the same file, last-write-wins. But HH writes to its own paths (`.claude/traces/` and `.harness/memory/`), so no conflict unless user deliberately targets the same paths.

**Resolution:** No special handling needed. HH writes to its own paths.

**Important:** Stop hooks can return `decision: "block"` to force Claude to continue working. HH's session summary must NEVER block — it should always exit 0. This is already correct.

Also: Stop hooks must check `stop_hook_active` to prevent infinite loops. Our session-summary.js should add this check.

---

### 3.5 SessionStart — NOT YET IMPLEMENTED

**Should HH use this?** Yes. This is a better place than UserPromptSubmit for:
- Creating the session directory
- Restoring session state from filesystem
- First-turn context injection

**Current approach:** The assembler detects first turn via a marker file. This is fragile.

**Better approach:** Use SessionStart to:
1. Create session directory via session-lifecycle
2. Write session ID to a known location
3. Inject initial context (project identity, work status)

**Conflict risk:** Low. SessionStart hooks are additive — all stdout is merged into initial context.

---

### 3.6 PreCompact / PostCompact — NOT YET IMPLEMENTED

**Should HH use this?** Yes. These are critical for session continuity.

**PreCompact:** Save current working state to filesystem before context is compressed.
- Write current session state to `.harness/sessions/{id}/state.md`
- Ensure trace JSONL is flushed

**PostCompact:** Re-inject essential context after compaction.
- Load session state from filesystem
- Re-inject identity and active route rules
- This is the killer feature — compaction becomes beneficial GC instead of information loss

**Conflict risk:** Low. Side-effect hooks (PreCompact) and additive context (PostCompact).

---

### 3.7 SessionEnd — NOT YET IMPLEMENTED

**Should HH use this?** Yes, as a complement to Stop.

**Difference:** Stop fires when Claude finishes a response. SessionEnd fires when the session actually terminates (user exits, clears, etc.).

**Use:** Final cleanup — ensure summary is written even if Stop hook failed.

**Conflict risk:** None. Pure side-effect.

---

## 4. Critical Fix: Settings.json Structure

Our current `init` generates a FLAT structure:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "type": "command", "command": "node hh-assembler.js" },
      { "type": "command", "command": "bash hh-assembler-fallback.sh" }
    ]
  }
}
```

The CORRECT structure uses **matcher groups**:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "node hh-assembler.js", "timeout": 10 },
          { "type": "command", "command": "bash hh-assembler-fallback.sh", "timeout": 5 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "bash hh-trace-capture.sh", "timeout": 5 }
        ]
      },
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "bash hh-state-nudge.sh", "timeout": 5 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node hh-session-summary.js", "timeout": 30 }
        ]
      }
    ]
  }
}
```

**This is a breaking bug in our current init command.** Must fix before any user testing.

---

## 5. Merge Strategy

### When merging with existing settings.json:

```
For each HH hook event:
  1. Read existing matcher groups for that event
  2. Check if any existing group conflicts:
     - Same matcher + produces stdout/additionalContext = CONFLICT
     - Same matcher + side-effect only = SAFE
     - Different matcher = SAFE
  3. For SAFE: add HH matcher group alongside existing groups
  4. For CONFLICT: warn user, offer modes (merge/replace/trace-only)
  5. Never delete or modify existing hook entries
  6. Use "hh-" prefix on all hook filenames for easy identification
```

### Deduplication

Claude Code auto-deduplicates hooks with identical `command` strings. So if a user runs `init` twice, the second run won't create duplicates. However, we should still clean up old HH hooks before adding new ones (which we already do by filtering `hh-` prefixed commands).

---

## 6. Recommended Init Modes

| Mode | Flag | Installs | Best For |
|---|---|---|---|
| **Full** | (default) | Assembler + Trace + Summary + Nudge | New projects with no existing hooks |
| **Merge** | `--merge` | All hooks alongside existing | Projects with non-conflicting hooks |
| **Replace** | `--replace` | Backs up existing UserPromptSubmit, replaces with assembler | Projects migrating from manual hooks |
| **Trace Only** | `--trace-only` | Trace + Summary only (no assembler, no nudge) | Projects that want scoring without changing context injection |
| **Minimal** | `--minimal` | Trace only (no summary, no nudge) | Maximum compatibility, just data collection |

---

## 7. Implementation Priority

### Must Fix (Before Testing)

1. **Fix settings.json structure** — switch to matcher group format
2. **Add UserPromptSubmit conflict detection** — warn if existing hooks inject context
3. **Add stop_hook_active check** to session-summary.js

### Should Add (v0.2)

4. **SessionStart hook** — proper session initialization
5. **PreCompact hook** — save state before compaction
6. **PostCompact hook** — re-inject context after compaction
7. **Init modes** — --merge, --replace, --trace-only flags
8. **Use $CLAUDE_PROJECT_DIR** in hook commands instead of hardcoded paths

### Nice to Have (v0.3)

9. **SessionEnd hook** — final cleanup
10. **FileChanged hook** — watch route config changes, auto-reload
11. **ConfigChange hook** — detect settings.json modifications
12. **HTTP hook option** — for teams that want centralized trace collection

---

## 8. Hook Reference Quick Card

| Event | HH Uses | Output | Conflict Risk | Merger Strategy |
|---|---|---|---|---|
| SessionStart | v0.2 | stdout (context) | Low | Additive |
| UserPromptSubmit | **v0.1** | stdout (context) | **HIGH** | Detect + warn |
| PreToolUse | No | — | — | — |
| PostToolUse (all) | **v0.1** | none | **None** | Always safe |
| PostToolUse (Edit\|Write) | **v0.1** | additionalContext | Low | Merge nudges |
| Stop | **v0.1** | none | **None** | Always safe |
| PreCompact | v0.2 | none | None | Always safe |
| PostCompact | v0.2 | stdout (context) | Low | Additive |
| SessionEnd | v0.3 | none | None | Always safe |
