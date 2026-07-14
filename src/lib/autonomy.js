/**
 * autonomy.js — Gate logic for autonomous rule promotion / demotion.
 *
 * The harness can move rules between must-load / load-if-budget / skip slots
 * without human review, but only when the evidence is overwhelming AND we
 * haven't moved the same rule recently. Three gates protect against false
 * positives from noisy single-session data:
 *
 *   1. Stability   — promotion needs the rule to be above-threshold for at
 *                    least PROMOTE_MIN_WEEKS consecutive analysis runs.
 *   2. Sample size — both promotion and demotion need ≥ MIN_SESSIONS data
 *                    points so a single great/terrible session can't move it.
 *   3. Cool-down   — same rule cannot be auto-moved more than once per
 *                    COOLDOWN_DAYS window. Stops oscillation.
 *
 * A FOURTH gate, and the important one:
 *
 *   4. Direction   — auto-DEMOTION is opt-in (`autonomy.autoDemote: true`) and
 *                    defaults to OFF, because the demote signal is unsound.
 *
 * Promotion fires on positive evidence: the rule was referenced, repeatedly, over
 * weeks. That is a real signal. Demotion fires on `avgScore <= 0` — i.e. on the
 * ABSENCE of evidence. But a rule only scores when its ID surfaces in a tool
 * response, so a rule the model simply *obeys* scores 0.00 forever. Demoting on
 * that is demoting for being quietly followed.
 *
 * Concretely, in the project this was found in: FD-001/002/003 (the frontend design
 * rules) sat at 0.00 across 5+ sessions purely because nobody did frontend work that
 * week — and they are Must-Load rules on the *frontend* route. Auto-demote would have
 * stripped the frontend rules off the frontend route for lack of frontend work.
 *
 * Demotion proposals are still generated and written to route-overrides.md for a
 * human to approve. They are just not applied by a bot on absence of evidence.
 *
 * Returns { apply: boolean, reason: string } so callers can log the decision.
 */

export const PROMOTE_MIN_WEEKS = 3;
export const PROMOTE_MIN_SESSIONS = 5;
export const DEMOTE_MIN_SESSIONS = 5;
export const COOLDOWN_DAYS = 7;

export function shouldAutoApply(proposal, ratingState, cooldownState, opts = {}) {
  const { mode = 'off', now = new Date(), autoDemote = false } = opts;
  if (mode === 'off') return { apply: false, reason: 'autonomy disabled' };

  if (proposal.kind === 'demote' && !autoDemote) {
    return {
      apply: false,
      reason: 'auto-demote is opt-in (autonomy.autoDemote) — a 0.00 score is absence of evidence, not evidence of uselessness; proposal left for human review',
    };
  }

  const cd = cooldownState[proposal.rule];
  if (cd?.last_applied) {
    const ageDays = (now - new Date(cd.last_applied)) / 86400000;
    if (ageDays < COOLDOWN_DAYS) {
      return { apply: false, reason: `cool-down: ${ageDays.toFixed(1)} days since last apply (need ${COOLDOWN_DAYS})` };
    }
  }

  if (proposal.kind === 'promote') {
    const r = ratingState.rules?.[proposal.rule];
    if (!r) return { apply: false, reason: 'no rating data' };
    if ((r.sessions_injected ?? 0) < PROMOTE_MIN_SESSIONS) {
      return { apply: false, reason: `sessions_injected ${r.sessions_injected ?? 0} < ${PROMOTE_MIN_SESSIONS}` };
    }
    if ((r.weeks_above_threshold ?? 0) < PROMOTE_MIN_WEEKS) {
      return { apply: false, reason: `weeks_above_threshold ${r.weeks_above_threshold ?? 0} < ${PROMOTE_MIN_WEEKS}` };
    }
    return { apply: true, reason: `promote: ${r.weeks_above_threshold}w stable, ${r.sessions_injected} sessions` };
  }

  if (proposal.kind === 'demote') {
    if ((proposal.sessions ?? 0) < DEMOTE_MIN_SESSIONS) {
      return { apply: false, reason: `sessions ${proposal.sessions ?? 0} < ${DEMOTE_MIN_SESSIONS}` };
    }
    if ((proposal.avgScore ?? 1) > 0) {
      return { apply: false, reason: `avgScore ${proposal.avgScore} > 0` };
    }
    return { apply: true, reason: `demote: 0 score across ${proposal.sessions} sessions on ${proposal.route ?? 'general'}` };
  }

  return { apply: false, reason: `unknown kind: ${proposal.kind}` };
}
