/**
 * staleness.js — Cross-repo staleness scoring and recommendation engine
 */

function daysSince(dateStr) {
  if (!dateStr || dateStr === 'never') return Infinity;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return Infinity;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * Compute staleness score (0.0 = fresh, 1.0 = completely stale).
 *
 * staleness = recency * 0.3 + ruleAge * 0.3 + ineffectiveness * 0.4
 */
export function computeStaleness(repo) {
  const days = daysSince(repo.last_trace);

  const recency = Math.min(days / 90, 1.0);
  const ruleAge = Math.min(days / 180, 1.0);
  const effectiveness = typeof repo.avg_effectiveness === 'number' ? repo.avg_effectiveness : 0;
  const ineffectiveness = 1.0 - Math.min(effectiveness, 1.0);

  const score = recency * 0.3 + ruleAge * 0.3 + ineffectiveness * 0.4;
  return Math.round(score * 100) / 100;
}

/**
 * Generate a human-readable recommendation. Returns null if healthy.
 */
export function generateRecommendation(repo) {
  const days = daysSince(repo.last_trace);
  const staleness = repo.staleness_score ?? computeStaleness(repo);

  if (staleness < 0.3) return null;

  if (days > 14 && (!repo.sessions_7d || repo.sessions_7d === 0)) {
    return `No traces in ${Math.round(days)} days. Context rules may be outdated.`;
  }

  const eff = repo.avg_effectiveness || 0;
  if (eff < 0.3 && repo.sessions_7d > 0) {
    return `Low effectiveness (${eff}). Consider reviewing route configs.`;
  }

  if (!repo.rule_count || repo.rule_count === 0) {
    return 'No rules configured. Run: harness-harness init';
  }

  if (days > 30) {
    return `Last used ${Math.round(days)} days ago. Rules may reference outdated code.`;
  }

  return null;
}

export { daysSince };
