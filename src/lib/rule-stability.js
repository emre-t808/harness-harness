/**
 * rule-stability.js — calendar-week stability from canonical v2 evidence
 * (harness-reliability PRD §5.2).
 *
 * Weeks are completed UTC Monday–Sunday weeks. Stability is a pure function
 * of the evidence store and an injected clock: repeated invocations within a
 * week cannot move it. A rule qualifies for a week only with at least one
 * eligible applicable observation ending in that week, a rating at or above
 * the mean-plus-standard-deviation threshold of the through-week snapshot,
 * and nonzero dispersion in that population. No-evidence and below-threshold
 * weeks reset the consecutive streak. Incomplete weeks never count, and the
 * first partial epoch week counts only when the epoch starts exactly at
 * Monday 00:00 UTC.
 */

import { computePopulationStats, processSession } from './rule-rating.js';
import { computeGeneration, eligibleObservations } from './evidence-state.js';

export const STABILITY_SCHEMA_VERSION = 2;
const WEEK_MS = 7 * 86400000;

export function weekStartOf(instantMs) {
  const d = new Date(instantMs);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  return midnight - daysSinceMonday * 86400000;
}

/** Completed countable weeks [{start, end}] between epoch start and now. */
export function completedWeeks(epochStartedAt, now) {
  const epochMs = Date.parse(epochStartedAt);
  if (!Number.isFinite(epochMs)) return [];
  let firstStart = weekStartOf(epochMs);
  if (epochMs !== firstStart) firstStart += WEEK_MS;
  const currentWeekStart = weekStartOf(now.getTime());
  const weeks = [];
  for (let start = firstStart; start + WEEK_MS <= currentWeekStart; start += WEEK_MS) {
    weeks.push({ start, end: start + WEEK_MS });
  }
  return weeks;
}

function applicableRules(observation) {
  return observation.scores.filter((s) => s.score !== null).map((s) => s.rule);
}

function snapshotRatings(observations, boundaryMs) {
  let state = { rules: {} };
  for (const observation of observations) {
    const time = Date.parse(observation.lastEventAt);
    if (!Number.isFinite(time) || time >= boundaryMs) continue;
    state = processSession(
      state,
      observation.scores
        .filter((s) => s.score !== null)
        .map((s) => ({ ruleId: s.rule, evidence: s.evidence })),
      { asOf: observation.lastEventAt.slice(0, 10) },
    );
  }
  return state;
}

function weekReason(rule, inWeek, snapshot, population) {
  const applicable = inWeek.some((o) => applicableRules(o).includes(rule));
  if (!applicable) return 'insufficient-evidence';
  if (population.count === 0 || population.std_dev === 0) return 'zero-dispersion';
  const rating = snapshot.rules[rule]?.rating ?? 0;
  if (rating < population.mean + population.std_dev) return 'below-threshold';
  return 'qualified';
}

function reviewSignal(weeklyDetail) {
  const evidenceWeeks = weeklyDetail.filter((w) => w.hadEvidence);
  if (evidenceWeeks.length < 3) return { recommended: false, evidenceWeeks: evidenceWeeks.length };
  const lastThree = evidenceWeeks.slice(-3);
  const anyQualified = lastThree.some((w) => Object.values(w.rules).includes('qualified'));
  return { recommended: !anyQualified, evidenceWeeks: evidenceWeeks.length };
}

/**
 * Retrospective event-time stability evaluation.
 * @returns {{ schemaVersion, generation, throughWeek, rules, weeklyDetail, thresholdReview }}
 */
export function evaluateStability(store, { now = new Date() } = {}) {
  const weeks = completedWeeks(store.epoch.startedAt, now);
  const observations = eligibleObservations(store);
  const allRules = [...new Set(observations.flatMap(applicableRules))].sort();
  const streaks = {};
  const latestReasons = {};
  const weeklyDetail = [];
  let latestPopulation = { mean: 1500, std_dev: 0, count: 0 };

  for (const week of weeks) {
    const snapshot = snapshotRatings(observations, week.end);
    const population = computePopulationStats(snapshot);
    latestPopulation = population;
    const inWeek = observations.filter((o) => {
      const time = Date.parse(o.lastEventAt);
      return time >= week.start && time < week.end;
    });
    const detail = { weekStart: new Date(week.start).toISOString(), hadEvidence: inWeek.length > 0, rules: {} };
    for (const rule of allRules) {
      const reason = weekReason(rule, inWeek, snapshot, population);
      streaks[rule] = reason === 'qualified' ? (streaks[rule] || 0) + 1 : 0;
      latestReasons[rule] = reason;
      detail.rules[rule] = reason;
    }
    weeklyDetail.push(detail);
  }

  const review = reviewSignal(weeklyDetail);
  return {
    schemaVersion: STABILITY_SCHEMA_VERSION,
    generation: computeGeneration(store),
    throughWeek: weeks.length > 0 ? new Date(weeks.at(-1).end).toISOString() : null,
    rules: Object.fromEntries(allRules.map((rule) => [rule, {
      consecutiveQualifiedWeeks: streaks[rule] || 0,
      latestReason: latestReasons[rule] ?? 'insufficient-evidence',
    }])),
    weeklyDetail,
    thresholdReview: {
      recommended: review.recommended,
      evidenceWeeks: review.evidenceWeeks,
      population: latestPopulation,
    },
  };
}
