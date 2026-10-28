# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Build Commands

There is no build. Node runs the source directly.

```bash
# Start the receiver (macOS / Linux / mirrored WSL)
./start-server.sh
# Expands to: node server/server.js, from the project root

# Start the receiver under NAT'd WSL — must be a *Windows* process
start-server.cmd            # run from Windows, not from the WSL shell

# One-time setup, idempotent; --autostart also installs the per-platform service
node bin/install.js [--autostart]

# Tests: plain Node, no runner, no browser, no second machine
node test/netrank.test.js && node test/page-token.test.js && node test/page-tray.test.js
```

`CLAUDE_VISUAL_PLATFORM=wsl|mac|linux|windows` forces platform detection, which
is how all three install paths get exercised from one machine.

## Key Constraints

- **Zero dependencies is a hard constraint.** No `npm install`, no build step,
  no lockfile. `server/multipart.js`, the PNG writer in `server/server.js` and
  the `.env` loader in `config.js` are hand-rolled *for this reason* — they are
  not there because a library was missed. If a change seems to need a package,
  it needs a different design. See `project_spec.md` §4.
- **Never strip `?k=` from the page URL, and never embed the token in the served
  HTML.** Both are load-bearing and pull in opposite directions: "Add to Home
  Screen" captures the URL as shown, and an iOS standalone app has its own
  localStorage partition, so a token cached before install is gone afterwards —
  while `GET /` is unauthenticated, so a token in the response body is public to
  anyone who can reach the port. The manifest `<link>` is injected client-side
  to satisfy both. Regression test: `test/page-token.test.js`. See §8.3.
- **`GET /` is unauthenticated on purpose** — only `POST /upload` checks the
  token. Do not "fix" this: requiring auth to see the page breaks the open-the-
  link-then-install flow the whole setup depends on. Note `README.md` currently
  claims every route but `/health` is authenticated; the code is right, the
  README is wrong. See §7.1.
- **The length check before `crypto.timingSafeEqual` is required, not an
  optimisation** — `timingSafeEqual` *throws* on a length mismatch instead of
  returning false, so removing the guard turns a bad token into a 500. See §7.2.
- **`platform.isSplit`, not `platform.isWSL`, is the predicate to branch on.**
  Mirrored-networking WSL behaves exactly like Linux; only NAT'd WSL needs the
  Windows-side receiver and the `/mnt/<drive>` path rule. Code that tests
  `isWSL` will do the wrong thing on a mirrored box. See §5.1.
- **Inbox/archive/manifest are configured as names relative to the root, never
  as absolute paths.** The same value must resolve for Windows node (`D:\…`) and
  WSL node (`/mnt/d/…`), and only a relative name does. See §11.
- **`bin/claim.js`'s stdout is prompt text, not logging.** `CLAIMED`,
  `INBOX EMPTY`, `NOTHING MATCHED` and `NOTHING CLAIMED` are a contract with the
  generated `~/.claude/commands/vis.md`, which instructs Claude to follow the
  block literally. Rewording a leading keyword, or adding a line that reads like
  an instruction, changes model behaviour. See §9.3.
- **Claiming is a `rename`, and that atomicity is the concurrency story.** Two
  sessions racing is handled by catching `ENOENT` and skipping. Do not replace
  it with copy-then-delete, and do not add a lock file. See §9.2.
- **Validate images by magic bytes only.** Never trust the declared
  content-type or the filename extension. `sniff()` is the single gate. See §7.3.
- **`server/page.js` has no browser to be tested in** — its logic is exercised
  against a stub DOM. Two real bugs have already shipped through that gap. Any
  change to `page.js` extends `test/page-tray.test.js` or
  `test/page-token.test.js`. See §4.
- **The default port 8765 collides with `url-opener` on this machine.** This
  checkout runs 8767 via `.env`; `.env.example`, the `config.js` default and the
  README's firewall snippet all still say 8765. Unresolved — see §15.
- **Do not reword a pending `- [ ]` line in `project_spec.md`.** A `SessionEnd`
  hook mirrors unchecked boxes to Trello and keys each card on a hash of the
  task text, so an edit strands the old card and silently creates a new one.
  Check the old line off and add a new one instead. Checked lines are free to
  reword. `project_spec.md` is the only file that should carry checkboxes.
