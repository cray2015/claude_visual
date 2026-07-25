# claude_visual — project spec

## Problem

Getting a photo from the iPhone into a Claude session cost six steps: shoot → upload to
Google Drive → open Drive on the PC → download → find the file → copy the path → paste it.
Claude Code runs in WSL, so paths needed translating on top of that. The friction meant
visuals mostly didn't get shared at all.

## Goal

Take the photo, tap once, type `/vis`. Nothing else.

## Constraints

- Runs on **macOS, Linux and Windows + WSL**. The phone is on the same Wi-Fi as the machine.
- On Windows the receiver must run as a **Windows** process, not inside WSL: WSL2 is NAT'd, so
  a server started in WSL needs a `netsh portproxy` that breaks whenever WSL's IP changes. A
  Windows-side process binds the real LAN address and survives reboots. The cost is that the
  two halves see different path forms (`D:\code\claude_visual` ↔ `/mnt/d/code/claude_visual`),
  so the project must live on a Windows drive. macOS and Linux have no such split.
- **Zero dependencies.** No `npm install`, nothing to break on any Node install.
- Nothing leaves the local network.

## Design

**The inbox is a queue, not a library.** `/vis` *claims* what it takes — moves it out of
`inbox/` into `archive/YYYY-MM/`. So `inbox/` only ever holds "sent but not yet used", which
is almost always the photo taken twenty seconds ago. Time proximity does the routing between
projects; there is nothing to configure.

Guards, because one global inbox serves every project:

1. **Recency window** (`CLAUDE_VISUAL_WINDOW_MIN`, default 30) — a bare `/vis` will not touch
   anything older. Stale images are listed, not read.
2. **Manifest first** — filenames, ages and tags are printed before anything is read.
3. **Claude looks at the image** and says so if it plainly belongs to another project.
4. **Optional tag** — a sticky text box on the upload page; `/vis <tag>` filters to it.

Photos are re-encoded in the browser before upload (decode → fit `CLAUDE_VISUAL_MAX_EDGE` →
JPEG). This converts iPhone HEIC into something Claude can actually read, and drops a 4 MB
original to a few hundred KB — 1568px is the largest edge Claude uses, so nothing useful is lost.

## Components

| Path | Role |
|---|---|
| `config.js` | every tunable, read from `.env`; real env vars win |
| `server/server.js` | HTTP receiver — token auth, magic-byte validation, generated app icon |
| `server/page.js` | mobile upload page, self-contained, no external requests |
| `server/multipart.js` | zero-dep `multipart/form-data` parser |
| `bin/claim.js` | claims pending images, prints WSL paths for the Read tool |
| `bin/install.js` | one-time setup; generates the `/vis` command for this checkout's path |
| `~/.claude/commands/vis.md` | the `/vis` command — user-level, so every project has it |

## Status

### Done

- [x] Zero-dep multipart parser
- [x] Windows-side receiver with token auth and magic-byte validation
- [x] Mobile upload page: camera + library, instant upload, progress, sticky tag, home-screen icon
- [x] Replaced auto-upload-on-select with a **staging tray** + Send button. Auto-send optimised
      for the single-photo demo; the real use is photographing one subject from several angles,
      where you want review, removal, and one batch. Resize happens at stage time so the tray
      stays cheap, and the batch goes up as one request so all files share a timestamp.
      Tests: `test/page-tray.test.js`
- [x] Browser-side HEIC→JPEG conversion and downscale to 1568px
- [x] `claim.js` with all four selectors (`/vis`, `/vis N`, `/vis all`, `/vis <tag>`)
- [x] Recency window guard; verified a 2h-old image is listed but not claimed
- [x] Append-only `manifest.jsonl` recording every upload and which project claimed it
- [x] Interface ranking so the recommended URL is never a VPN, container bridge or WSL
      virtual address — covers Windows, macOS and Linux adapter naming, and ranks Tailscale
      by CGNAT address rather than name (it's `tailscale0` on Linux but `utunN` on macOS,
      which the name rule would otherwise bury). Tests: `test/netrank.test.js`
- [x] Cross-platform support: platform detection in `config.js`, `start-server.sh` for
      macOS/Linux, and autostart per platform (Startup shortcut / LaunchAgent / systemd user
      unit). `CLAUDE_VISUAL_PLATFORM` forces detection, which is also how the install paths
      for all three platforms get exercised from one machine.
- [x] `/vis` installed user-level (fixed the broken `~/.claude/commands` symlink)
- [x] Autostart via `shell:startup` shortcut → `start-hidden.vbs`
- [x] All configuration moved to `.env` / `.env.example`
- [x] `bin/install.js` + README install steps so this can be set up on another PC. The `/vis`
      command embeds an absolute path, so it must be generated per machine rather than copied;
      the installer also repairs a dangling `~/.claude/commands` symlink, which otherwise
      silently stops every custom slash command from loading.
- [x] End-to-end verified: upload → claim → archive → Read renders the image
- [x] Fixed the Add-to-Home-Screen token bug: the page stripped `?k=` from the URL, and iOS
      installed standalone apps have a localStorage partition separate from the browser's, so
      the saved icon had no way to authenticate. Token now stays in the URL, with a paste-in
      recovery box. Regression test: `test/page-token.test.js`
- [x] Browser/platform agnostic front end: added a web app manifest so Android/Chrome can
      install it standalone the way iOS does, with the token carried in `start_url` — without
      that, an installed Android app would have repeated the iOS failure exactly. Icons
      generated at 180/192/512.

- [x] Licensed Apache-2.0 with a NOTICE file. Chosen over MIT because §4(d) makes the NOTICE
      contents *required* to reproduce downstream — the strongest attribution available
      without leaving open source. Non-commercial licensing was considered and rejected: it
      would make the project not-open-source and block most employed developers from
      contributing, at the cost of insuring against a risk that barely exists for a LAN tool.

### Pending

- [ ] Add `/clip` to pull a `Win+Shift+S` screenshot straight off the Windows clipboard
- [x] Test the upload page on the actual iPhone (only curl-tested so far — camera capture,
      HEIC conversion and Add to Home Screen are unverified on real hardware)
      *Verified 25 Jul 2026: a real photo arrived as a 376 KB JPEG at 1568px long edge,
      confirming Safari's HEIC→JPEG conversion and the downscale both work. Wording of this
      item is left as originally written on purpose — the Trello sync keys cards on a hash of
      the task text, so editing it would strand the card instead of archiving it.*
- [ ] Sign into Tailscale on PC and iPhone so the same setup works off the home Wi-Fi
- [ ] Give the machine a DHCP reservation so the bookmarked LAN IP cannot drift
- [ ] Add a retention/prune policy for `archive/` — it grows forever right now
- [ ] Decide whether `/vis` should auto-run when a prompt mentions an image

## Non-goals

- Exposing anything to the public internet.
- Cloud storage or a third-party relay (a Telegram-bot variant was considered and dropped —
  it works off-LAN but routes photos through someone else's servers).
- Any build step, bundler, or dependency.
