// SPDX-License-Identifier: Apache-2.0
'use strict';

// Single source of truth for every tunable, shared by the Windows-side server
// and the WSL-side claim script. Values come from .env, and a real environment
// variable always beats the file so you can override for one run:
//
//   CLAUDE_VISUAL_PORT=9000 node server/server.js

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname);

// Which world are we in? On Windows+WSL the receiver runs as a Windows process
// while the claim script runs in WSL, so the two halves see different path
// forms and need different launch instructions. On macOS and Linux there is no
// split at all — one process, one path form.
//
// Note this file is loaded by BOTH halves, so detection has to work when
// running under Windows node (process.platform === 'win32') and under WSL node.
// CLAUDE_VISUAL_PLATFORM (wsl|mac|linux|windows) forces the answer. It exists so
// the platform-specific install paths can be exercised without owning three
// machines, and as an escape hatch if detection ever guesses wrong.
const forced = String(process.env.CLAUDE_VISUAL_PLATFORM || '').toLowerCase();

const detectWSL = () => {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft|wsl/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
};

const isWindows = forced ? forced === 'windows' : process.platform === 'win32';
const isMac     = forced ? forced === 'mac'     : process.platform === 'darwin';
const isWSL     = forced ? forced === 'wsl'     : detectWSL();
const isLinux   = forced ? forced === 'linux'   : (process.platform === 'linux' && !isWSL);

// True when the receiver and the claim script are the same OS — i.e. everywhere
// except the Windows+WSL pairing.
const isNative = isMac || isLinux;

// Deliberately hand-rolled rather than process.loadEnvFile(): it keeps the
// precedence rule explicit (real env wins) and works on any Node version.
function loadEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;                                   // .env is optional
  }
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnv(path.join(ROOT, '.env'));

const num = (key, dflt) => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(`  ! ${key}="${raw}" is not a number — using ${dflt}`);
    return dflt;
  }
  return n;
};

const str = (key, dflt) => {
  const raw = process.env[key];
  return raw === undefined || raw === '' ? dflt : raw;
};

// Inbox/archive are configured as names relative to the project root, never as
// absolute paths: the same value has to resolve for Windows node (D:\...) and
// WSL node (/mnt/d/...), and only a relative name does that.
const inboxDir   = str('CLAUDE_VISUAL_INBOX_DIR', 'inbox');
const archiveDir = str('CLAUDE_VISUAL_ARCHIVE_DIR', 'archive');

module.exports = {
  platform: { isWindows, isMac, isLinux, isWSL, isNative },

  root:      ROOT,
  inbox:     path.join(ROOT, inboxDir),
  archive:   path.join(ROOT, archiveDir),
  manifest:  path.join(ROOT, str('CLAUDE_VISUAL_MANIFEST', 'manifest.jsonl')),
  tokenFile: path.join(ROOT, 'server', 'token.txt'),
  urlsFile:  path.join(ROOT, 'server', 'urls.txt'),

  host: str('CLAUDE_VISUAL_HOST', '0.0.0.0'),
  port: num('CLAUDE_VISUAL_PORT', 8765),

  // Set to pin the access token; otherwise one is generated into server/token.txt.
  token: str('CLAUDE_VISUAL_TOKEN', null),

  maxFileBytes: Math.round(num('CLAUDE_VISUAL_MAX_FILE_MB', 25) * 1024 * 1024),
  maxBodyBytes: Math.round(num('CLAUDE_VISUAL_MAX_BODY_MB', 60) * 1024 * 1024),

  // How far back a bare `/vis` will reach. The guard that stops a stale photo
  // leaking into an unrelated session.
  windowMin: num('CLAUDE_VISUAL_WINDOW_MIN', 30),

  // Browser-side downscale before upload. 1568 is the largest edge Claude uses.
  maxEdge:     num('CLAUDE_VISUAL_MAX_EDGE', 1568),
  jpegQuality: num('CLAUDE_VISUAL_JPEG_QUALITY', 0.85),

  healthTimeoutMs: num('CLAUDE_VISUAL_HEALTH_TIMEOUT_MS', 600),
};
