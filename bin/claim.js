#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Claims images out of the shared inbox for the session that runs it.
//
// The inbox is a QUEUE, not a library: claiming moves files out to archive/,
// so inbox/ only ever holds "sent but not yet used". That is what keeps a
// single global inbox usable from every project — the photo you took twenty
// seconds ago is the only thing in there.
//
//   /vis            newest pending from the last 30 minutes
//   /vis 3          newest 3 pending, ignoring the time window
//   /vis all        everything pending
//   /vis arduino    everything pending tagged "arduino"
//
// Run under WSL node. Prints WSL absolute paths, which is what Read consumes.

const fs = require('fs');
const path = require('path');
const cfg = require('../config');

const { inbox: INBOX, archive: ARCHIVE, manifest: MANIFEST, urlsFile: URLS_F } = cfg;
const WINDOW_MIN = cfg.windowMin;

const IMAGE_EXT  = /\.(jpe?g|png|webp|gif|heic)$/i;
const READABLE   = /\.(jpe?g|png|webp|gif)$/i;   // formats Claude's Read can decode

const argv = process.argv.slice(2).filter(Boolean);
const arg  = (argv[0] || '').toLowerCase();

// ---------------------------------------------------------------- helpers

function humanAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 48) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

function humanSize(b) {
  return b >= 1024 * 1024 ? (b / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(b / 1024)) + 'KB';
}

// Tags live in the manifest; the filename is only a fallback.
function tagIndex() {
  const idx = new Map();
  try {
    for (const line of fs.readFileSync(MANIFEST, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.event === 'upload' && r.file) idx.set(r.file, r.tag || null);
      } catch { /* skip a torn line */ }
    }
  } catch { /* no manifest yet */ }
  return idx;
}

function pending() {
  let names;
  try {
    names = fs.readdirSync(INBOX);
  } catch {
    return [];
  }
  const tags = tagIndex();
  const now = Date.now();
  return names
    .filter(n => IMAGE_EXT.test(n))
    .map(n => {
      const st = fs.statSync(path.join(INBOX, n));
      return { name: n, mtime: st.mtimeMs, bytes: st.size, tag: tags.get(n) || null, age: now - st.mtimeMs };
    })
    .sort((a, b) => a.mtime - b.mtime);          // oldest first: multi-shot sets read in order
}

function claim(items) {
  const claimed = [];
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const dir = path.join(ARCHIVE, month);
  fs.mkdirSync(dir, { recursive: true });

  const records = [];
  for (const it of items) {
    const dest = path.join(dir, it.name);
    try {
      fs.renameSync(path.join(INBOX, it.name), dest);
    } catch (e) {
      if (e.code === 'ENOENT') continue;         // another session got there first
      throw e;
    }
    records.push(JSON.stringify({
      event: 'claim',
      t: now.toISOString(),
      file: it.name,
      project: process.cwd(),
      archived: dest,
    }));
    claimed.push({ ...it, path: dest });
  }
  if (records.length) {
    try { fs.appendFileSync(MANIFEST, records.join('\n') + '\n'); } catch { /* non-fatal */ }
  }
  return claimed;
}

// Under WSL the receiver is a *Windows* process, so the "start it" hint has to
// be a Windows path (/mnt/d/... -> D:\...) rather than the WSL one. Everywhere
// else the shell script is the answer.
function winPath(p) {
  const m = /^\/mnt\/([a-z])\/(.*)$/.exec(p);
  return m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}` : p;
}
const STARTER = cfg.platform.isWSL
  ? winPath(cfg.root) + '\\start-server.cmd'
  : path.join(cfg.root, 'start-server.sh');

function serverHint() {
  try {
    const first = fs.readFileSync(URLS_F, 'utf8').split('\n').find(l => l.trim());
    if (first) return first.trim();
  } catch { /* server has not run yet */ }
  return null;
}

async function serverUp(url) {
  if (!url) return null;
  try {
    const base = new URL(url);
    const res = await fetch(`${base.protocol}//${base.host}/health`,
      { signal: AbortSignal.timeout(cfg.healthTimeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const all = pending();

  // Decide what this invocation is asking for.
  let selected, skipped = [], mode;
  if (arg === 'all') {
    selected = all;
    mode = 'all pending';
  } else if (/^\d+$/.test(arg)) {
    const n = Number(arg);
    selected = all.slice(-n);
    skipped = all.slice(0, Math.max(0, all.length - n));
    mode = `newest ${n}`;
  } else if (arg) {
    selected = all.filter(f => f.tag === arg);
    skipped = all.filter(f => f.tag !== arg);
    mode = `tagged "${arg}"`;
  } else {
    const cutoff = WINDOW_MIN * 60 * 1000;
    selected = all.filter(f => f.age <= cutoff);
    skipped = all.filter(f => f.age > cutoff);
    mode = `last ${WINDOW_MIN} min`;
  }

  if (!selected.length) {
    if (!all.length) {
      const url = serverHint();
      const up = await serverUp(url);
      console.log('INBOX EMPTY — nothing has been sent from the phone yet.');
      if (url && up === false) {
        console.log('The receiver is NOT responding. Start it: ' + STARTER);
      } else if (url) {
        console.log('Send one from the phone: ' + url);
      } else {
        console.log('The receiver has never run. Start it: ' + STARTER);
      }
      console.log('Do NOT read any image paths — there are none. Tell the user the inbox is empty.');
      return;
    }
    console.log(`NOTHING MATCHED (${mode}), but ${all.length} image(s) are pending:`);
    for (const f of all) {
      console.log(`  ${f.name}  (${humanAge(f.age)}${f.tag ? ', #' + f.tag : ''}, ${humanSize(f.bytes)})`);
    }
    console.log('Do NOT read anything yet. Ask the user whether to run `/vis all`.');
    return;
  }

  const claimed = claim(selected);
  if (!claimed.length) {
    console.log('NOTHING CLAIMED — another session took these first. Do not read anything.');
    return;
  }

  console.log(`CLAIMED ${claimed.length} image(s) (${mode}) → read these paths with the Read tool:`);
  for (const f of claimed) {
    const bits = [humanAge(f.age), humanSize(f.bytes)];
    if (f.tag) bits.splice(1, 0, '#' + f.tag);
    console.log(`  ${f.path}   (${bits.join(', ')})`);
  }

  const unreadable = claimed.filter(f => !READABLE.test(f.name));
  if (unreadable.length) {
    console.log('');
    console.log(`WARNING: ${unreadable.length} file(s) are HEIC, which cannot be read.`);
    console.log('Ask the user to re-send with "Send original" unchecked — the page converts to JPEG.');
  }

  if (skipped.length) {
    console.log('');
    console.log(`PENDING, not claimed (${skipped.length}) — run \`/vis all\` to include:`);
    for (const f of skipped) {
      console.log(`  ${f.name}  (${humanAge(f.age)}${f.tag ? ', #' + f.tag : ''})`);
    }
  }
}

main().catch(e => {
  console.error('claim failed: ' + e.message);
  process.exit(1);
});
