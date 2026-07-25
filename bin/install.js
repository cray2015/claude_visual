#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
'use strict';

// One-time setup:  node bin/install.js [--autostart]
//
// Installs the /vis slash command pointing at THIS checkout (the path differs on
// every machine, so the command file has to be generated rather than copied),
// and creates .env from the example. Idempotent — safe to re-run after moving
// the project.
//
// Two shapes of install:
//   Windows + WSL   receiver is a Windows process (so the phone can reach it
//                   without a portproxy); claim.js runs in WSL. Both halves must
//                   see the same directory, which only works under /mnt/<drive>.
//   macOS / Linux   one process, one path form, nothing special.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOME = os.homedir();
const COMMANDS = path.join(HOME, '.claude', 'commands');
const autostart = process.argv.includes('--autostart');

const cfg = require('../config');
const P = cfg.platform;

const ok = m => console.log('  \u2713 ' + m);
const warn = m => console.log('  ! ' + m);
const note = m => console.log('  \u00b7 ' + m);
const problems = [];

const platformName = P.isWSL ? 'Windows + WSL' : P.isMac ? 'macOS' : P.isLinux ? 'Linux' : process.platform;
console.log(`\nclaude_visual setup  (${platformName})\n`);

function winPath(p) {
  const m = /^\/mnt\/([a-z])\/(.*)$/.exec(p);
  return m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}` : p;
}

// --- 1. location + runtime -------------------------------------------------

let starter;

if (P.isWSL) {
  // The receiver is a Windows process, so the project has to sit somewhere
  // Windows can see. A checkout inside the WSL filesystem fails much later,
  // confusingly, so catch it here.
  const mnt = /^\/mnt\/([a-z])\/(.*)$/.test(ROOT);
  if (!mnt) {
    warn(`project is at ${ROOT}, which Windows cannot see.`);
    warn('Move it onto a Windows drive (e.g. /mnt/d/code/claude_visual) and re-run.');
    problems.push('project location');
  } else {
    ok(`visible to both sides: ${ROOT}  =  ${winPath(ROOT)}`);
  }

  const winNode = [
    '/mnt/c/Program Files/nodejs/node.exe',
    '/mnt/c/Program Files (x86)/nodejs/node.exe',
  ].find(p => fs.existsSync(p));
  if (winNode) {
    let v = '';
    try { v = execFileSync(winNode, ['-v'], { encoding: 'utf8' }).trim(); } catch { /* ignore */ }
    ok(`Windows node found: ${winNode}${v ? '  ' + v : ''}`);
  } else {
    warn('No Windows-side node.exe found. Install Node for Windows from nodejs.org —');
    warn('the receiver runs as a Windows process so the phone can reach it directly.');
    problems.push('windows node');
  }
  starter = winPath(ROOT) + '\\start-server.cmd';
} else {
  ok(`node ${process.version} at ${process.execPath}`);
  starter = path.join(ROOT, 'start-server.sh');
  try {
    fs.chmodSync(starter, 0o755);
    ok('start-server.sh made executable');
  } catch {
    warn('could not chmod start-server.sh — run it as: node server/server.js');
  }
}

// --- 2. .env ---------------------------------------------------------------
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  ok('.env already exists (left untouched)');
} else {
  fs.copyFileSync(path.join(ROOT, '.env.example'), envFile);
  ok('.env created from .env.example');
}

// --- 3. the /vis command ---------------------------------------------------
// ~/.claude/commands is often a symlink into a dotfiles repo, and that link is
// sometimes dangling — mkdir on the link itself fails, so resolve it first.
// A dangling link silently stops *every* custom slash command from loading.
let commandsTarget = COMMANDS;
try {
  if (fs.lstatSync(COMMANDS).isSymbolicLink()) {
    const dest = fs.readlinkSync(COMMANDS);
    commandsTarget = path.resolve(path.dirname(COMMANDS), dest);
    if (!fs.existsSync(commandsTarget)) {
      fs.mkdirSync(commandsTarget, { recursive: true });
      ok(`repaired dangling symlink target: ${commandsTarget}`);
    }
  }
} catch {
  // does not exist at all — mkdir below handles it
}
fs.mkdirSync(commandsTarget, { recursive: true });

const visFile = path.join(commandsTarget, 'vis.md');
const visBody = `---
description: Pull the newest image(s) sent from the phone and look at them
argument-hint: "[n | all | tag]"
allowed-tools: Bash(node:*), Read
---

!\`node ${path.join(ROOT, 'bin', 'claim.js')} $ARGUMENTS\`

The block above is from the image inbox. Follow it literally:

- If it says CLAIMED, read every listed path with the Read tool, then answer whatever
  the user asked. If they asked nothing specific, describe what you see and what you
  think they want done with it.
- If it says INBOX EMPTY, NOTHING MATCHED, or NOTHING CLAIMED, read nothing and just
  relay the situation.
- If an image plainly has nothing to do with this project, say so before analysing it —
  it was probably meant for a different session.
`;

if (fs.existsSync(visFile) && fs.readFileSync(visFile, 'utf8') !== visBody) {
  fs.copyFileSync(visFile, visFile + '.bak');
  warn('existing vis.md backed up to vis.md.bak');
}
fs.writeFileSync(visFile, visBody);
ok(`/vis installed at ${visFile}`);
ok('user-level, so it works in every project on this machine');

// --- 4. directories --------------------------------------------------------
for (const d of ['inbox', 'archive']) fs.mkdirSync(path.join(ROOT, d), { recursive: true });
ok('inbox/ and archive/ ready');

// --- 5. optional autostart -------------------------------------------------

function autostartWindows() {
  const vbs = winPath(path.join(ROOT, 'start-hidden.vbs'));
  const ps = `
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'claude_visual.lnk'
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath = 'C:\\Windows\\System32\\wscript.exe'
$s.Arguments = '"${vbs}"'
$s.WorkingDirectory = '${winPath(ROOT)}'
$s.Description = 'claude_visual image receiver'
$s.Save()
Write-Output $lnk`.trim();
  const out = execFileSync(
    '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
  return 'Startup shortcut: ' + out;
}

function autostartMac() {
  const dir = path.join(HOME, 'Library', 'LaunchAgents');
  fs.mkdirSync(dir, { recursive: true });
  const plistPath = path.join(dir, 'com.claudevisual.receiver.plist');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.claudevisual.receiver</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${path.join(ROOT, 'server', 'server.js')}</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(ROOT, 'server', 'receiver.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(ROOT, 'server', 'receiver.log')}</string>
</dict>
</plist>
`;
  fs.writeFileSync(plistPath, plist);
  try {
    execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
  } catch { /* not loaded yet */ }
  execFileSync('launchctl', ['load', plistPath], { stdio: 'ignore' });
  return 'LaunchAgent loaded: ' + plistPath;
}

function autostartLinux() {
  const dir = path.join(HOME, '.config', 'systemd', 'user');
  fs.mkdirSync(dir, { recursive: true });
  const unitPath = path.join(dir, 'claude-visual.service');
  fs.writeFileSync(unitPath, `[Unit]
Description=claude_visual image receiver

[Service]
ExecStart=${process.execPath} ${path.join(ROOT, 'server', 'server.js')}
WorkingDirectory=${ROOT}
Restart=on-failure

[Install]
WantedBy=default.target
`);
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  execFileSync('systemctl', ['--user', 'enable', '--now', 'claude-visual.service'], { stdio: 'ignore' });
  return 'systemd user service enabled: ' + unitPath;
}

if (autostart) {
  try {
    if (P.isWSL) ok(autostartWindows());
    else if (P.isMac) ok(autostartMac());
    else if (P.isLinux) ok(autostartLinux());
    else warn('no autostart method known for ' + process.platform);
  } catch (e) {
    warn('could not configure autostart: ' + e.message);
    if (P.isLinux) warn('on a headless box you may need: loginctl enable-linger $USER');
    problems.push('autostart');
  }
} else {
  note('autostart not configured (re-run with --autostart to add it)');
}

// --- next steps ------------------------------------------------------------
console.log('\nNext:\n');
if (P.isWSL) {
  console.log(`  1. Start the receiver (on Windows):   ${starter}`);
} else {
  console.log(`  1. Start the receiver:   ${starter}`);
}
console.log('  2. Note the http://…/?k=… URL it prints (the top one).');
console.log('  3. Open that URL in Safari on the iPhone, Share \u2192 Add to Home Screen.');
console.log('  4. Send a photo, then type /vis in any Claude Code session.\n');

if (P.isMac) {
  note('macOS will ask to allow incoming connections the first time — say yes.');
  console.log('');
} else if (P.isLinux) {
  note(`if the phone cannot connect, open the port: sudo ufw allow ${cfg.port}/tcp`);
  console.log('');
}

if (problems.length) {
  console.log('Unresolved: ' + problems.join(', ') + '\n');
  process.exit(1);
}
