// src/lib/bloat-detector.js
//
// Detects rule bloat using Elo rating distribution + extraction coverage.

const MIN_INJECTIONS_FOR_BLOAT = 5;
const LOW_COVERAGE_THRESHOLD = 0.03;

/**
 * Compute a bloat score for a repo (0.0 = healthy, 1.0 = heavily bloated).
 */
export function computeBloatScore(stats) {
  const {
    total_rules = 0,
    underperforming_rules = 0,
    avg_rule_age_days = 0,
    min_coverage_ratio = 1.0,
    rating_std_dev = 0,
  } = stats;

  if (total_rules === 0) return 0;

  const lowRatingRatio = (underperforming_rules / total_rules) * 0.5;
  const countPenalty = total_rules > 30 ? 0.3 : 0;
  const agePenalty = avg_rule_age_days > 90 ? 0.2 : 0;

  const coverageConfidence = min_coverage_ratio < LOW_COVERAGE_THRESHOLD ? 0.3 : 1.0;
  const distributionConfidence = rating_std_dev < 50 ? 0.3 : 1.0;

  const raw = lowRatingRatio + countPenalty + agePenalty;
  const adjusted = raw * coverageConfidence * distributionConfidence;

  return Math.min(1.0, Math.round(adjusted * 100) / 100);
}

export function bloatRecommendation(stats, bloatScore) {
  if (bloatScore < 0.5) return null;

  const reasons = [];
  if (stats.underperforming_rules > 5) {
    reasons.push(`${stats.underperforming_rules} rules rated below pool mean − 1σ (injected in ≥${MIN_INJECTIONS_FOR_BLOAT} sessions)`);
  }
  if (stats.total_rules > 30) {
    reasons.push(`${stats.total_rules} total rules (threshold: 30)`);
  }
  if (stats.avg_rule_age_days > 90) {
    reasons.push(`avg rule age ${Math.round(stats.avg_rule_age_days)} days`);
  }

  const warnings = [];
  if (stats.min_coverage_ratio < LOW_COVERAGE_THRESHOLD) {
    warnings.push(`NOTE: one or more ingested sources have <3% extraction coverage — bloat signal downweighted.`);
  }
  if (stats.rating_std_dev < 50) {
    warnings.push(`NOTE: rating distribution is narrow (σ=${Math.round(stats.rating_std_dev)}) — insufficient spread.`);
  }

  const base = `Bloat detected: ${reasons.join('; ')}. Run: harness-harness rules list --underrated`;
  return warnings.length > 0 ? `${base}\n  ${warnings.join('\n  ')}` : base;
}

export function bloatStatus(bloatScore) {
  if (bloatScore < 0.3) return '[HEALTHY]';
  if (bloatScore < 0.5) return '[WATCH]';
  if (bloatScore < 0.75) return '[BLOATED]';
  return '[CRITICAL]';
}

export { MIN_INJECTIONS_FOR_BLOAT, LOW_COVERAGE_THRESHOLD };
