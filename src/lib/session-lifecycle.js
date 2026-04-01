/**
 * session-lifecycle.js — Session directory manager
 *
 * Manages session state directories under .harness/sessions/.
 */

import fs from 'fs';
import path from 'path';
import { resolvePaths } from './paths.js';

const MAX_ACTIVE = 10;
const ARCHIVE_MAX_DAYS = 30;

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function isoNow() {
  return new Date().toISOString();
}

function stateTemplate(sessionId) {
  return `---
session: ${sessionId}
started: ${isoNow()}
intent: general
branch: main
---

## Current Objective
(not set)

## Working Context
(none yet)

## Active Decisions
(none yet)

## Blockers
(none)
`;
}

function decisionsTemplate() {
  return `## Decisions Log

(no decisions yet)
`;
}

export function create(sessionId, projectDir) {
  const paths = resolvePaths(projectDir);
  const sessionDir = path.join(paths.sessionsDir, sessionId);

  if (fs.existsSync(sessionDir)) {
    return sessionDir;
  }

  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'state.md'), stateTemplate(sessionId));
  fs.writeFileSync(path.join(sessionDir, 'decisions.md'), decisionsTemplate());

  return sessionDir;
}

export function archive(sessionId, projectDir) {
  const paths = resolvePaths(projectDir);
  const sessionDir = path.join(paths.sessionsDir, sessionId);

  if (!fs.existsSync(sessionDir)) return null;

  const date = todayDate();
  const archiveTarget = path.join(paths.sessionsArchiveDir, date, sessionId);
  fs.mkdirSync(path.dirname(archiveTarget), { recursive: true });

  if (fs.existsSync(archiveTarget)) {
    fs.rmSync(archiveTarget, { recursive: true, force: true });
  }
  fs.renameSync(sessionDir, archiveTarget);

  return archiveTarget;
}

export function cleanup(projectDir) {
  const paths = resolvePaths(projectDir);
  const activeSessions = listSessionDirs(paths);
  const toArchive = activeSessions.slice(MAX_ACTIVE);

  for (const { name } of toArchive) {
    archive(name, projectDir);
  }

  if (!fs.existsSync(paths.sessionsArchiveDir)) {
    return { archived: toArchive.length, deleted: 0 };
  }

  const cutoff = Date.now() - ARCHIVE_MAX_DAYS * 24 * 60 * 60 * 1000;
  let deleted = 0;
  const dateDirs = fs.readdirSync(paths.sessionsArchiveDir).filter(d => !d.startsWith('.'));

  for (const dateDir of dateDirs) {
    const datePath = path.join(paths.sessionsArchiveDir, dateDir);
    const stat = fs.statSync(datePath);
    if (!stat.isDirectory()) continue;

    if (stat.mtime.getTime() < cutoff) {
      fs.rmSync(datePath, { recursive: true, force: true });
      deleted++;
    }
  }

  return { archived: toArchive.length, deleted };
}

function listSessionDirs(paths) {
  if (!fs.existsSync(paths.sessionsDir)) return [];

  return fs.readdirSync(paths.sessionsDir)
    .filter(name => {
      const full = path.join(paths.sessionsDir, name);
      return name !== 'archive' && !name.startsWith('.') && fs.statSync(full).isDirectory();
    })
    .map(name => ({
      name,
      mtime: fs.statSync(path.join(paths.sessionsDir, name)).mtime,
    }))
    .sort((a, b) => b.mtime - a.mtime);
}

export function list(projectDir) {
  const paths = resolvePaths(projectDir);
  return listSessionDirs(paths);
}

export { MAX_ACTIVE, ARCHIVE_MAX_DAYS };
