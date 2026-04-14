// src/lib/rule-scoring.js
//
// Behavioral compliance scoring for Phase 7.

import { minimatch } from './minimatch-simple.js';

/**
 * Score each injected rule using both reference detection and behavioral signals.
 *
 * @param {object[]} traceEvents
 * @param {object[]} injectedRules
 * @returns {{ [ruleId: string]: { score: number, evidence: string } }}
 */
export function scoreRuleCompliance(traceEvents, injectedRules) {
  if (!injectedRules || injectedRules.length === 0) return {};

  const result = {};

  for (const rule of injectedRules) {
    const ruleId = typeof rule === 'string' ? rule : rule.id;
    let score = 0.0;
    let evidence = 'ignored';

    const isReferenced = traceEvents.some(evt =>
      Array.isArray(evt.referenced_context) && evt.referenced_context.includes(ruleId)
    );

    if (isReferenced) {
      score = 1.0;
      evidence = 'referenced';
    }

    const behavioralMatch = typeof rule === 'object' && rule.behavioral_signals
      ? checkBehavioralCompliance(traceEvents, rule.behavioral_signals)
      : false;

    if (behavioralMatch) {
      if (isReferenced) {
        score = 1.5;
        evidence = 'verified-compliance';
      } else {
        score = 0.5;
        evidence = 'behavioral-compliance';
      }
    }

    // Phase 8: content-verified is the strongest non-prevented-mistake evidence
    const contentMatch = typeof rule === 'object' && rule.behavioral_signals
      ? checkContentCompliance(traceEvents, rule.behavioral_signals)
      : false;

    if (contentMatch) {
      if (isReferenced) {
        score = 1.75;
        evidence = 'content-verified';
      } else {
        score = 1.0;
        evidence = 'content-verified';
      }
    }

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
      if (window.some(e => e.tool === 'Edit' || e.tool === 'Write')) {
        score = 2.0;
        evidence = 'prevented-mistake';
        break;
      }
    }

    result[ruleId] = { score, evidence };
  }

  return result;
}

function checkBehavioralCompliance(traceEvents, signals) {
  if (!Array.isArray(signals) || signals.length === 0) return false;

  for (const signal of signals) {
    if (signalMatches(traceEvents, signal)) return true;
  }
  return false;
}

function signalMatches(traceEvents, signal) {
  const { trigger, expect } = signal;
  if (!trigger || !expect) return false;

  const triggerEvents = traceEvents.filter(evt => {
    if (trigger.tool && Array.isArray(trigger.tool)) {
      if (!trigger.tool.includes(evt.tool)) return false;
    }

    if (trigger.file_glob) {
      const files = evt.files_touched || [];
      if (!files.some(f => minimatch(f, trigger.file_glob))) return false;
    }

    return true;
  });

  if (triggerEvents.length === 0) return false;

  if (expect.sibling_file_touched) {
    return checkSiblingFileTouched(traceEvents, triggerEvents, expect.sibling_file_touched);
  }

  if (expect.preceded_by_read) {
    return checkPrecededByRead(traceEvents, triggerEvents, expect.preceded_by_read);
  }

  if (expect.file_not_modified) {
    return checkFileNotModified(traceEvents, expect.file_not_modified);
  }

  // Phase 8: content_includes is handled separately in checkContentCompliance()
  // Return false here so content-only signals don't double-score via behavioral path.
  return false;
}

/**
 * Phase 8: Check whether any behavioral_signal with expect.content_includes
 * matched (i.e., a trigger Edit/Write event contains the required regex in
 * its response_snippet).
 */
function checkContentCompliance(traceEvents, signals) {
  if (!Array.isArray(signals) || signals.length === 0) return false;
  for (const signal of signals) {
    const { trigger, expect } = signal;
    if (!trigger || !expect || !expect.content_includes) continue;

    const triggerEvents = traceEvents.filter(evt => {
      if (trigger.tool && Array.isArray(trigger.tool) && !trigger.tool.includes(evt.tool)) return false;
      if (trigger.file_glob) {
        const files = evt.files_touched || [];
        if (!files.some(f => minimatch(f, trigger.file_glob))) return false;
      }
      return true;
    });

    if (triggerEvents.length === 0) continue;
    if (checkContentIncludes(triggerEvents, expect.content_includes)) return true;
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
