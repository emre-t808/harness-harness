// src/lib/rule-scoring.js
//
// Behavioral compliance scoring for Phase 7.

import { minimatch } from './minimatch-simple.js';

/**
 * Score each injected rule using both reference detection and behavioral signals.
 *
 * @param {object[]} traceEvents
 * @param {object[]} injectedRules
 * @returns {{ [ruleId: string]: { score: number|null, evidence: string } }}
 *   score null means 'not-applicable' — the rule declares signals but no
 *   trigger fired this session; callers should exclude it from aggregation.
 */
export function scoreRuleCompliance(traceEvents, injectedRules) {
  if (!injectedRules || injectedRules.length === 0) return {};

  const result = {};

  for (const rule of injectedRules) {
    const ruleId = typeof rule === 'string' ? rule : rule.id;
    const signals = typeof rule === 'object' && Array.isArray(rule.behavioral_signals) && rule.behavioral_signals.length > 0
      ? rule.behavioral_signals
      : null;

    const isReferenced = traceEvents.some(evt =>
      Array.isArray(evt.referenced_context) && evt.referenced_context.includes(ruleId)
    );

    const sig = evaluateSignals(traceEvents, signals);
    const prevented = detectPreventedMistake(traceEvents, ruleId);
    result[ruleId] = assembleScore(sig, isReferenced, !!signals, prevented);
  }

  return result;
}

/**
 * Evaluate all behavioral_signals for one rule against the session's events.
 * Returns which outcome classes any signal produced:
 *   fired      — at least one signal's trigger matched (the rule was applicable)
 *   violated   — an expect.absent trigger fired, or a file_not_modified guard was breached
 *   behavioral — a present / sibling / preceded_by_read / file_not_modified expectation was met
 *   content    — a content_includes expectation was met
 */
function evaluateSignals(traceEvents, signals) {
  const out = { fired: false, violated: false, behavioral: false, content: false };
  if (!signals) return out;

  for (const signal of signals) {
    const { trigger, expect } = signal || {};
    if (!trigger || !expect) continue;

    const triggerEvents = filterTriggerEvents(traceEvents, trigger);
    if (triggerEvents.length === 0) continue;
    out.fired = true;

    if (expect.absent) {
      out.violated = true;
    } else if (expect.present) {
      out.behavioral = true;
    } else if (expect.applicable_only) {
      // Trigger marks applicability only; no expectation to meet.
    } else if (expect.content_includes) {
      if (checkContentIncludes(triggerEvents, expect.content_includes)) out.content = true;
    } else if (expect.sibling_file_touched) {
      if (checkSiblingFileTouched(traceEvents, triggerEvents, expect.sibling_file_touched)) out.behavioral = true;
    } else if (expect.preceded_by_read) {
      if (checkPrecededByRead(traceEvents, triggerEvents, expect.preceded_by_read)) out.behavioral = true;
    } else if (expect.file_not_modified) {
      if (checkFileNotModified(traceEvents, expect.file_not_modified)) out.behavioral = true;
      else out.violated = true;
    }
  }

  return out;
}

function filterTriggerEvents(traceEvents, trigger) {
  return traceEvents.filter(evt => {
    if (trigger.tool && Array.isArray(trigger.tool) && !trigger.tool.includes(evt.tool)) return false;
    if (trigger.tool_glob && !minimatch(evt.tool || '', trigger.tool_glob)) return false;
    if (trigger.input_regex) {
      let re;
      try { re = new RegExp(trigger.input_regex); } catch { return false; }
      if (!re.test(evt.input_summary || '')) return false;
    }
    if (trigger.file_glob) {
      const files = evt.files_touched || [];
      if (!files.some(f => minimatch(f, trigger.file_glob))) return false;
    }
    return true;
  });
}

/**
 * Session-level evidence hierarchy, first match wins. `violated` trumps all
 * positives — behavioral truth beats citation. A rule WITH signals whose
 * triggers never fired scores null ('not-applicable'): it is excluded from
 * aggregation rather than logged as a false-negative 0.
 */
function assembleScore(sig, isReferenced, hasSignals, prevented) {
  if (sig.violated) return { score: 0.0, evidence: 'violated' };
  if (prevented) return { score: 2.0, evidence: 'prevented-mistake' };
  if (sig.content) return { score: isReferenced ? 1.75 : 1.0, evidence: 'content-verified' };
  if (sig.behavioral && isReferenced) return { score: 1.5, evidence: 'verified-compliance' };
  if (isReferenced) return { score: 1.0, evidence: 'referenced' };
  if (sig.behavioral) return { score: 0.5, evidence: 'behavioral-compliance' };
  if (sig.fired) return { score: 0.0, evidence: 'applicable-unmet' };
  if (hasSignals) return { score: null, evidence: 'not-applicable' };
  return { score: 0.0, evidence: 'ignored' };
}

function detectPreventedMistake(traceEvents, ruleId) {
  for (let i = 0; i < traceEvents.length; i++) {
    const evt = traceEvents[i];
    const isAntiPatternRead =
      evt.tool === 'Read' &&
      typeof evt.input_summary === 'string' &&
      evt.input_summary.includes('anti-pattern') &&
      Array.isArray(evt.referenced_context) &&
      evt.referenced_context.includes(ruleId);

    if (!isAntiPatternRead) continue;

    const window = traceEvents.slice(i + 1, i + 4);
    if (window.some(e => e.tool === 'Edit' || e.tool === 'Write')) return true;
  }
  return false;
}

/**
 * Decode base64 response_snippet fields and test whether the regex matches.
 * Only Edit/Write events carry snippets.
 */
function checkContentIncludes(triggerEvents, regexStr) {
  let regex;
  try {
    regex = new RegExp(regexStr);
  } catch {
    return false;
  }

  for (const evt of triggerEvents) {
    if (evt.tool !== 'Edit' && evt.tool !== 'Write') continue;
    if (!evt.response_snippet) continue;

    let snippet;
    try {
      snippet = Buffer.from(evt.response_snippet, 'base64').toString('utf8');
    } catch {
      continue;
    }

    if (regex.test(snippet)) return true;
  }

  return false;
}

function checkSiblingFileTouched(allEvents, triggerEvents, siblingGlob) {
  const allTouchedFiles = new Set();
  for (const evt of allEvents) {
    for (const f of (evt.files_touched || [])) allTouchedFiles.add(f);
  }

  for (const trigger of triggerEvents) {
    const triggerFiles = trigger.files_touched || [];
    for (const triggerFile of triggerFiles) {
      const dir = triggerFile.includes('/') ? triggerFile.slice(0, triggerFile.lastIndexOf('/')) : '';
      const base = triggerFile.slice(triggerFile.lastIndexOf('/') + 1);
      const baseNoExt = base.replace(/\.[^.]+$/, '');

      const expectedSibling = siblingGlob.replace(/\*/g, baseNoExt);
      const fullSiblingPath = dir ? `${dir}/${expectedSibling}` : expectedSibling;

      if (allTouchedFiles.has(fullSiblingPath)) return true;

      for (const f of allTouchedFiles) {
        if (f === triggerFile) continue;
        const fDir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
        if (fDir !== dir) continue;
        const fBase = f.slice(f.lastIndexOf('/') + 1);
        if (minimatch(fBase, siblingGlob)) return true;
      }
    }
  }

  return false;
}

function checkPrecededByRead(allEvents, triggerEvents, readPath) {
  const earliestTriggerIdx = allEvents.indexOf(triggerEvents[0]);
  if (earliestTriggerIdx <= 0) return false;

  const isBasenameOnly = !readPath.includes('/');

  for (let i = 0; i < earliestTriggerIdx; i++) {
    const evt = allEvents[i];
    if (evt.tool !== 'Read') continue;

    const candidates = [];
    if (typeof evt.input_summary === 'string') candidates.push(evt.input_summary);
    for (const f of (evt.files_touched || [])) candidates.push(f);

    for (const candidate of candidates) {
      if (!candidate) continue;
      if (candidate === readPath) return true;
      if (minimatch(candidate, readPath)) return true;
      if (isBasenameOnly) {
        const base = candidate.split('/').pop() || '';
        if (minimatch(base, readPath)) return true;
      }
      if (candidate.endsWith(readPath)) return true;
    }
  }

  return false;
}

function checkFileNotModified(allEvents, forbiddenGlob) {
  for (const evt of allEvents) {
    if (evt.tool !== 'Edit' && evt.tool !== 'Write') continue;
    const files = evt.files_touched || [];
    for (const f of files) {
      if (minimatch(f, forbiddenGlob)) return false;
    }
  }
  return true;
}
