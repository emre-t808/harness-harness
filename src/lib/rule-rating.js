// src/lib/rule-rating.js
//
// Elo-based rule rating.

import fs from 'fs';
import path from 'path';

const STARTING_RATING = 1500;
const K_FACTOR_COLD = 40;
const K_FACTOR_STABLE = 20;
const COLD_START_SESSIONS = 10;

export function evidenceToMatchScore(evidence) {
  switch (evidence) {
    case 'referenced':
    case 'verified-compliance':
    case 'content-verified':
    case 'prevented-mistake':
      return 1.0;
    case 'behavioral-compliance':
    case 'implicit':
      return 0.5;
    case 'ignored':
    default:
      return 0.0;
  }
}

export function expectedScore(selfRating, opponentRating) {
  return 1 / (1 + Math.pow(10, (opponentRating - selfRating) / 400));
}

export function updateRating(entry, matchScore, poolMean) {
  const current = entry || { rating: STARTING_RATING, sessions_injected: 0 };
  const sessions = current.sessions_injected || 0;
  const k = sessions < COLD_START_SESSIONS ? K_FACTOR_COLD : K_FACTOR_STABLE;

  const expected = expectedScore(current.rating, poolMean);
  const newRating = current.rating + k * (matchScore - expected);

  return {
    rating: Math.round(newRating * 10) / 10,
    sessions_injected: sessions + 1,
    last_updated: new Date().toISOString().slice(0, 10),
  };
}

export function processSession(state, sessionScores) {
  if (!sessionScores || sessionScores.length === 0) return state;

  const rules = { ...(state.rules || {}) };

  const currentRatings = sessionScores.map(s => {
    const entry = rules[s.ruleId];
    return entry?.rating ?? STARTING_RATING;
  });
  const poolMean = currentRatings.reduce((a, b) => a + b, 0) / currentRatings.length;

  for (const { ruleId, evidence } of sessionScores) {
    const matchScore = evidenceToMatchScore(evidence);
    const prev = rules[ruleId];
    rules[ruleId] = updateRating(prev, matchScore, poolMean);
  }

  return { ...state, rules };
}

export function updateRatingsFromAggregation(state, aggregated) {
  const perSession = aggregated._perSessionScores;

  if (Array.isArray(perSession) && perSession.length > 0) {
    let current = state;
    for (const sessionScores of perSession) {
      current = processSession(current, sessionScores);
    }
    return current;
  }

  const virtualSession = [];
  for (const [ruleId, data] of Object.entries(aggregated.perRule || {})) {
    const avg = data.totalWeight > 0 ? data.totalWeightedScore / data.totalWeight : 0;
    let evidence;
    if (avg >= 1.5) evidence = 'prevented-mistake';
    else if (avg >= 0.75) evidence = 'referenced';
    else if (avg >= 0.25) evidence = 'behavioral-compliance';
    else evidence = 'ignored';
    virtualSession.push({ ruleId, evidence });
  }
  return processSession(state, virtualSession);
}

export function computePopulationStats(state) {
  const ratings = Object.values(state.rules || {})
    .filter(entry => (entry.sessions_injected || 0) >= 3)
    .map(entry => entry.rating);

  if (ratings.length === 0) {
    return { mean: STARTING_RATING, std_dev: 0, count: 0 };
  }

  const mean = ratings.reduce((a, b) => a + b, 0) / ratings.length;
  const variance = ratings.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / ratings.length;
  const std_dev = Math.sqrt(variance);

  return {
    mean: Math.round(mean * 10) / 10,
    std_dev: Math.round(std_dev * 10) / 10,
    count: ratings.length,
  };
}

export function loadRatingState(paths) {
  if (!paths.ratingStateFile || !fs.existsSync(paths.ratingStateFile)) {
    return { rules: {}, last_updated: null };
  }
  try {
    return JSON.parse(fs.readFileSync(paths.ratingStateFile, 'utf8'));
  } catch {
    return { rules: {}, last_updated: null };
  }
}

export function saveRatingState(paths, state) {
  const toWrite = {
    ...state,
    last_updated: new Date().toISOString().slice(0, 10),
  };
  fs.mkdirSync(path.dirname(paths.ratingStateFile), { recursive: true });
  fs.writeFileSync(paths.ratingStateFile, JSON.stringify(toWrite, null, 2), 'utf8');
}
