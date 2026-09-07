/**
 * migrate-evidence — initialize the v2 evidence epoch for a project.
 *
 * Default is a DRY RUN: inventory legacy state, print the proposed epoch and
 * counts, change nothing. --apply saves byte-preserving backups of existing
 * derived state, then creates .harness/memory/evidence-state.json with a
 * fresh epoch. Legacy summaries and ratings become historical data only —
 * nothing is deleted, no routes are touched, and re-running --apply never
 * resets an existing valid epoch.
 */

import fs from 'fs';
import path from 'path';
import { resolvePaths } from '../lib/paths.js';
import {
  EVIDENCE_SCHEMA_VERSION,
  createEvidenceStore,
  loadEvidenceState,
  saveEvidenceState,
} from '../lib/evidence-state.js';

const LEGACY_STATE_KEYS = ['ratingStateFile', 'propagationStateFile', 'autonomyStateFile', 'effectivenessFile'];

function countSummaryArtifacts(tracesDir) {
  const counts = { markdown: 0, sidecars: 0 };
  if (!fs.existsSync(tracesDir)) return counts;
  for (const dir of fs.readdirSync(tracesDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) {
    const dirPath = path.join(tracesDir, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    for (const file of fs.readdirSync(dirPath)) {
      if (file.endsWith('-summary.md')) counts.markdown += 1;
      if (file.endsWith('-summary.json')) counts.sidecars += 1;
    }
  }
  return counts;
}

function inventory(paths) {
  const legacyFiles = LEGACY_STATE_KEYS
    .map((key) => paths[key])
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ file, bytes: fs.statSync(file).size }));
  return { legacyFiles, summaries: countSummaryArtifacts(paths.tracesDir) };
}

function backupLegacyState(paths, legacyFiles, stamp) {
  const backupDir = path.join(paths.localDir, 'reliability-backups', stamp);
  const backups = [];
  for (const { file } of legacyFiles) {
    const target = path.join(backupDir, path.basename(file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
    if (fs.readFileSync(file).compare(fs.readFileSync(target)) !== 0) {
      throw new Error(`Backup verification failed for ${file}`);
    }
    backups.push(target);
  }
  return backups;
}

export async function migrateEvidence(projectDir, flags, log = console.log) {
  const apply = flags.includes('--apply');
  const paths = resolvePaths(projectDir);
  if (!fs.existsSync(paths.harnessDir)) {
    throw new Error(`${paths.harnessDir} does not exist — nothing to migrate.`);
  }

  // Corrupt or unknown-schema existing store is a hard failure, never a reset.
  const existing = loadEvidenceState(paths);
  const inv = inventory(paths);
  const now = new Date();

  log(`migrate-evidence (${apply ? 'APPLY' : 'dry run'}) — project ${projectDir}`);
  log(`  Legacy state files: ${inv.legacyFiles.length ? inv.legacyFiles.map((f) => `${path.basename(f.file)} (${f.bytes}B)`).join(', ') : 'none'}`);
  log(`  Summary artifacts: ${inv.summaries.markdown} markdown, ${inv.summaries.sidecars} v2 sidecars`);
  log(`  Target schema: evidence-state v${EVIDENCE_SCHEMA_VERSION}`);

  if (existing) {
    log(`  Already migrated: epoch ${existing.epoch.startedAt} with ${Object.keys(existing.observations).length} observation(s) — preserved.`);
    return { applied: false, alreadyMigrated: true, epoch: existing.epoch.startedAt };
  }
  if (!apply) {
    log(`  Proposed epoch start: ${now.toISOString()} (legacy history stays report-only; new qualifying evidence required)`);
    log('  Dry run: no changes made. Re-run with --apply to initialize.');
    return { applied: false, alreadyMigrated: false, proposedEpoch: now.toISOString(), inventory: inv };
  }

  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const backups = backupLegacyState(paths, inv.legacyFiles, stamp);
  const store = createEvidenceStore(now.toISOString());
  store.migration = {
    migratedAt: now.toISOString(),
    backups,
    legacySummaryCounts: inv.summaries,
    note: 'Legacy ratings/summaries are historical data only; they seed nothing.',
  };
  saveEvidenceState(paths, store);
  log(`  Initialized ${paths.evidenceStateFile} (epoch ${store.epoch.startedAt})`);
  log(`  Backups: ${backups.length ? backups.join(', ') : 'none needed'}`);
  return { applied: true, alreadyMigrated: false, epoch: store.epoch.startedAt, backups };
}
