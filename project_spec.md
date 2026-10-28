# claude_visual — project spec

## 1. Overview

A LAN-local bridge that puts a phone photo in front of Claude Code in two
actions: tap Send on the phone, type `/vis` in the session. A zero-dependency
Node receiver accepts the upload onto the machine's real LAN address, drops it
in a shared `inbox/`, and a generated user-level slash command claims it into
`archive/` and hands Claude the absolute paths. Runs on macOS, Linux, and
Windows + WSL. Nothing leaves the local network.

## 2. Goals

- Getting a photo into a session costs one tap on the phone and one command in
  the session — no upload, no download, no path translation by hand.
- One global inbox serves every project, with no per-project configuration.
- Runs on macOS, Linux, and Windows + WSL from the same checkout.
- No `npm install`, no build step, no lockfile — `node server/server.js` is the
  whole runtime story.
- Photos stay on the local network for their entire life.

## 3. Non-Goals

<!-- Tag names when the item could come back, not what release excluded it:
     [never]       — permanently out of scope, architectural or by principle
     [v2] / [v3]   — deferred to that release
     [unplanned]   — not ruled out, not scheduled
     [superseded]  — reversed; annotate in place, never delete -->

- **[never]** Exposing anything to the public internet — no port forwarding, no
  tunnel to a public hostname, no inbound path that does not start on a network
  the user already trusts.
- **[never]** Cloud storage or a third-party relay. A Telegram-bot variant was
  considered and dropped: it works off-LAN, but routes every photo through
  someone else's servers, which defeats the point of building this at all.
- **[never]** Any build step, bundler, or dependency. The multipart parser, the
  PNG icon writer and the `.env` loader are all hand-rolled to hold this line —
  see §4.
- **[superseded → §10, and the Tailscale milestone in §13]** "Off the home
  Wi-Fi it does not work, by design." Still true of the LAN path, but no longer
  a position: `netrank.js` already ranks a Tailscale CGNAT address *above* the
  Wi-Fi one, so the same server and the same home-screen icon are meant to work
  from anywhere once Tailscale is signed in. That is a private mesh, not public
  exposure, so it does not touch the first entry above.
- **[unplanned]** Server-side image decoding or format conversion. The browser
  does the HEIC→JPEG work (§8.2); the server only sniffs and stores. Anything
  else would mean a native image library, which collides with the entry above.
- **[unplanned]** Multi-user or multi-machine inboxes. One machine, one inbox,
  one token.

## 4. Design rationale and constraints

- **The inbox is a queue, not a library** — `/vis` *claims* what it takes,
  renaming it out of `inbox/` into `archive/YYYY-MM/`. So `inbox/` only ever
  holds "sent but not yet used", which is almost always the photo taken twenty
  seconds ago. Time proximity does the routing between projects; there is
  nothing to configure. Every guard in §9.2 exists to make that safe.
- **Bind the machine's real LAN address, never a private one** — a receiver the
  phone cannot reach is worse than no receiver, and the failure shows up as a
  timeout on the phone rather than an error on the PC. This is the single
  constraint that shapes the deployment split in §5.1 and the ranking in §10.
- **Zero dependencies is a hard constraint, not a preference** — the value of
  this tool is that it still runs after a year of not being touched. A
  dependency tree is the thing most likely to break that. Where a library would
  normally be reached for, the hand-rolled version is deliberate: `multipart.js`
  (84 lines), the PNG writer in `server.js`, and the `.env` loader in
  `config.js`. If something appears to need a library, it probably needs a
  different design.
- **Re-encode in the browser, not on the server** — decode → fit `maxEdge` →
  JPEG, before the bytes ever leave the phone. This does three jobs at once: it
  converts iPhone HEIC into something the Read tool can actually decode, it
  drops a 4 MB original to a few hundred KB, and it keeps the server free of an
  image library. 1568px is the largest edge Claude uses, so nothing useful is
  lost.
- **Resize at stage time, not at send time** — see §8.1. Send is then pure I/O,
  and a full tray costs ~300 KB per photo instead of ~4 MB.
- **Tests run against a stub DOM, not a browser** — `server/page.js` is a string
  of JavaScript with no browser available in this environment, so its logic is
  exercised by evaluating it against a hand-built stub. Two real bugs have
  already shipped through that gap (§13), which is why the rule is: change
  `page.js`, extend the tests.
- **Apache-2.0 with a NOTICE file, over MIT** — §4(d) makes the NOTICE contents
  *required* to reproduce downstream, which is the strongest attribution
  available without leaving open source. Non-commercial licensing was
  considered and rejected: it would make the project not-open-source and block
  most employed developers from contributing, in exchange for insuring against
  a risk that barely exists for a LAN photo tool.

## 5. Architecture

Phone browser → `POST /upload` → magic-byte check → `inbox/` → `claim.js`
renames into `archive/YYYY-MM/` → absolute paths printed → Claude's Read tool.
Every upload and every claim is appended to `manifest.jsonl`.

Diagram source: `docs/architecture.d2`. Render on demand with
`d2 docs/architecture.d2 docs/architecture.svg` — the `.d2` is the source of
truth; the rendered SVG is not committed.

### 5.1 Deployment shapes

There are three, and `config.js` collapses them to one predicate,
`platform.isSplit` — "are the receiver and the claim script separated by an OS
boundary?". That, not `isWSL`, is what the rest of the code branches on.

| Shape | Receiver runs | Claim runs | Constraint |
|---|---|---|---|
| macOS / Linux | here | here | none |
| WSL, **mirrored** networking | inside WSL | inside WSL | none — WSL shares the host's interfaces, so it behaves like plain Linux |
| WSL, **NAT** networking (the default) | as a **Windows** process | in WSL | both halves must see one directory, so the checkout must live under `/mnt/<drive>` |

The NAT case is the awkward one: WSL2 sits on its own private subnet, so a
server started inside WSL needs a `netsh portproxy` that breaks whenever WSL's
IP changes. A Windows-side process binds the real LAN address and survives
reboots. The cost is that the two halves see different path forms
(`D:\code\claude_visual` ↔ `/mnt/d/code/claude_visual`).

`CLAUDE_VISUAL_WSL_NET` records the answer (`nat` | `mirrored`) so `config.js`
does not have to ask Windows on every `/vis` — see §12.

### 5.2 What happens to one photo

1. Staged in the tray: decoded, fitted to `maxEdge`, re-encoded JPEG (§8.1).
2. Sent with the rest of the tray as **one** `POST /upload`.
3. Sniffed by magic bytes (§7.3), written as
   `YYYYMMDD-HHMMSS[-tag].<ext>`, deduplicated with a `-N` suffix.
4. Logged to `manifest.jsonl` as `{event:"upload", …}`.
5. Selected by `/vis` (§9.1), renamed into `archive/YYYY-MM/`.
6. Logged again as `{event:"claim", project:<cwd>, …}`.
7. Its absolute path is printed for the Read tool.

## 6. Components

| Path | Role |
|---|---|
| `config.js` | every tunable, read from `.env`; real env vars win. Also platform and split detection |
| `server/server.js` | HTTP receiver — token auth, magic-byte validation, generated app icon, web manifest |
| `server/page.js` | the mobile upload page, emitted as one self-contained HTML string |
| `server/multipart.js` | zero-dep `multipart/form-data` parser |
| `server/netrank.js` | ranks the machine's addresses by "can the phone reach this?" |
| `bin/claim.js` | claims pending images and prints absolute paths for the Read tool |
| `bin/install.js` | one-time setup; generates `/vis` for this checkout's path, optional autostart |
| `test/netrank.test.js` | address ranking across Windows / macOS / Linux adapter naming |
| `test/page-token.test.js` | regression test for the home-screen token bug (§8.3) |
| `test/page-tray.test.js` | staging tray behaviour against a stub DOM |
| `start-server.sh` | launcher for macOS / Linux / mirrored WSL |
| `start-server.cmd` | launcher for the Windows-side receiver (visible console) |
| `start-hidden.vbs` | same, with no console window — used by the Startup shortcut |
| `~/.claude/commands/vis.md` | the generated `/vis` command — user-level, so every project gets it |

## 7. HTTP API

### 7.1 Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | liveness; `claim.js` probes this with a `healthTimeoutMs` budget |
| GET | `/` | **none** | the upload page |
| GET | `/icon.png?size=` | none | generated app icon; `size` is whitelisted to 180 / 192 / 512, anything else falls back to 180 |
| GET | `/manifest.webmanifest?k=` | none | web app manifest; `start_url` carries the token through (§8.3) |
| POST | `/upload` | **token** | multipart upload; the only authenticated route |
| — | anything else | none | 404 |

`GET /` being unauthenticated is deliberate: the page is inert without a valid
token, and requiring auth to *see* it would break the "open the link, add to
home screen" flow that the whole setup depends on. The token is therefore never
embedded in the served HTML — the page wires up its own manifest link
client-side so the token stays out of the response body (§8.3).

### 7.2 Authentication

One shared token, presented as the `X-Token` header or a `?k=` query parameter.
It is read from `CLAUDE_VISUAL_TOKEN` if pinned, otherwise generated once
(`randomBytes(9).toString('base64url')`) into `server/token.txt`.

Comparison is `crypto.timingSafeEqual`, guarded by an explicit length check
first — `timingSafeEqual` throws on a length mismatch rather than returning
false, so the length compare is load-bearing, not an optimisation.

### 7.3 Image validation

The declared content-type and the filename extension are both ignored. `sniff()`
reads magic bytes and returns the extension to store under, or `null` to reject:

| Format | Detection |
|---|---|
| `jpg` | `FF D8 FF` |
| `png` | the 8-byte PNG signature |
| `webp` | `RIFF` at 0 and `WEBP` at 8 |
| `heic` | `ftyp` at 4, with a brand in `heic heix hevc hevx mif1 msf1 heim heis` |
| `gif` | `GIF87a` / `GIF89a` |

Buffers under 16 bytes are rejected outright. Per-file and per-body size caps
are separate (`maxFileBytes` 25 MB, `maxBodyBytes` 60 MB) because the tray sends
a whole batch in one request: an oversize *file* is skipped and the rest of the
batch still lands, whereas an oversize *body* fails the request with 413.

HEIC is accepted and stored even though Claude's Read tool cannot decode it —
see §9.3 for how that is surfaced rather than silently swallowed.

## 8. Upload page

### 8.1 Staging tray

Selecting a photo stages it into a tray; a separate Send button uploads the
whole tray as one request. This replaced auto-upload-on-select, which was
optimised for the single-photo demo. The real use is photographing one subject
from several angles, where you want review, removal, and one batch.

Resize happens at **stage** time, so the tray holds ~300 KB per photo instead of
~4 MB, and Send is pure I/O rather than decode-then-wait. Sending the batch as a
single request also means the files share a timestamp, so they sort together.

`Send original (no resize)` turns the re-encode off for cases that need full
detail — and is the one path that puts a raw HEIC on the wire (§9.3). On a
failed send the tray is left intact so the whole batch can simply be re-sent.

### 8.2 Image conversion

`createImageBitmap(file, { imageOrientation: 'from-image' })`, falling back to
the bare one-argument form for older Safari, then a canvas fitted to `maxEdge`
and `toBlob('image/jpeg', jpegQuality)`. This is where iPhone HEIC becomes JPEG.

### 8.3 Installability and the token

The token has to **stay in the URL**. "Add to Home Screen" captures whatever URL
is showing at that moment, and an iOS standalone web app gets its own
localStorage partition, separate from the browser's — so a token cached before
install is invisible afterwards. An earlier version stripped `?k=` for tidiness
and produced an icon that could never authenticate. A paste-in recovery box
handles an icon that was already saved without it.

Android/Chrome installs via `/manifest.webmanifest`, whose `start_url` carries
the token for exactly the same reason — without that, an installed Android app
would have reproduced the iOS failure precisely. The manifest `<link>` is
injected client-side rather than served in the HTML, because `GET /` is
unauthenticated and embedding the token would hand it to anyone who can reach
the port.

Icons are generated by the server at 180 (apple-touch-icon) and 192 / 512 (web
manifest), so the home-screen icon looks deliberate instead of letting iOS fall
back to a screenshot of the page.

Tag and `Send original` are both persisted in `localStorage` so the tray comes
back the way it was left.

## 9. Claiming

### 9.1 Selectors

| Invocation | Selects | Window applies |
|---|---|---|
| `/vis` | everything newer than `windowMin` | yes |
| `/vis N` | the newest N | no |
| `/vis all` | everything pending | no |
| `/vis <tag>` | everything pending with that tag | no |

Pending images are listed **oldest first**, so a multi-shot set is read in the
order it was taken. `/vis N` therefore takes from the *end* of that list.

Tags come from `manifest.jsonl`, not from the filename — the filename carries a
sanitised copy for legibility only. Tag sanitising is
`[^a-z0-9_-] → -`, trimmed, truncated to 24 characters.

### 9.2 Guards

One global inbox serves every project, so four things stop a stale photo
leaking into an unrelated session:

1. **Recency window** — `CLAUDE_VISUAL_WINDOW_MIN`, default 30. A bare `/vis`
   will not touch anything older. Stale images are *listed*, not read.
2. **Manifest first** — filenames, ages and tags are printed before anything is
   read.
3. **Claude looks at the image** and says so if it plainly belongs to another
   project.
4. **Optional tag** — a sticky text box on the upload page; `/vis <tag>` filters
   to it.

Claiming is a `rename`, which is atomic: if two sessions race, the loser gets
`ENOENT` and skips that file rather than double-claiming it.

### 9.3 Output contract

`claim.js` output is **prompt text, not logging**. The generated `vis.md` tells
Claude to follow it literally, so the leading keyword of each branch is a
contract:

| Keyword | Means |
|---|---|
| `CLAIMED n image(s)` | read every listed path |
| `INBOX EMPTY` | read nothing; relay the situation |
| `NOTHING MATCHED` | read nothing; ask whether to run `/vis all` |
| `NOTHING CLAIMED` | another session won the race; read nothing |

`INBOX EMPTY` additionally probes `/health` and, if the receiver is down, prints
the platform-correct starter path — the Windows `.cmd` under NAT'd WSL, the
shell script everywhere else.

A claimed HEIC triggers an explicit warning telling the user to re-send with
`Send original` unchecked, because the file is now in `archive/` and unreadable.

## 10. Address ranking

`netrank.js` sorts the machine's IPv4 addresses so the URL printed first is one
the phone can actually reach. A VPN tunnel, a container bridge and the WSL
vSwitch all carry perfectly valid private IPs that a phone can never reach.

| Rank | Match |
|---|---|
| 100 | `100.64.0.0/10` — CGNAT, in practice Tailscale, and works off-LAN |
| 50 | RFC1918 (`192.168.`, `10.`, `172.16–31.`) |
| 0 | anything else routable |
| −100 | interface name matches the virtual-adapter pattern |

Tailscale is ranked by **address**, not adapter name, because it is
`tailscale0` on Linux but `utunN` on macOS — and the name rule would otherwise
bury it as a tunnel. Loopback, non-IPv4 and `169.254.` (APIPA) addresses are
dropped before ranking. Negative-rank entries are still *printed*, annotated
`(virtual — phone cannot reach this)`, since seeing them is how you diagnose a
wrong pick.

## 11. Configuration

Everything is read from `.env` by `config.js`, and a real environment variable
always beats the file, so one run can be overridden inline.

| Key | Default | Meaning |
|---|---|---|
| `CLAUDE_VISUAL_PORT` | `8765` | listen port — see the collision note below |
| `CLAUDE_VISUAL_HOST` | `0.0.0.0` | bind address |
| `CLAUDE_VISUAL_TOKEN` | generated | pin the token instead of using `server/token.txt` |
| `CLAUDE_VISUAL_WINDOW_MIN` | `30` | how far back a bare `/vis` reaches |
| `CLAUDE_VISUAL_MAX_EDGE` | `1568` | browser-side downscale target |
| `CLAUDE_VISUAL_JPEG_QUALITY` | `0.85` | browser-side JPEG quality |
| `CLAUDE_VISUAL_MAX_FILE_MB` | `25` | per-file cap |
| `CLAUDE_VISUAL_MAX_BODY_MB` | `60` | per-request cap |
| `CLAUDE_VISUAL_INBOX_DIR` | `inbox` | **relative** name, never an absolute path |
| `CLAUDE_VISUAL_ARCHIVE_DIR` | `archive` | as above |
| `CLAUDE_VISUAL_MANIFEST` | `manifest.jsonl` | as above |
| `CLAUDE_VISUAL_HEALTH_TIMEOUT_MS` | `600` | `claim.js` liveness probe budget |
| `CLAUDE_VISUAL_PLATFORM` | detected | force `wsl` \| `mac` \| `linux` \| `windows` |
| `CLAUDE_VISUAL_WSL_NET` | `nat` | `nat` \| `mirrored`; written by `bin/install.js` |

Directory keys are relative names on purpose: the same value has to resolve for
Windows node (`D:\…`) and WSL node (`/mnt/d/…`), and only a relative name does.

`CLAUDE_VISUAL_PLATFORM` exists so all three platforms' install paths can be
exercised from one machine, and as an escape hatch when detection guesses wrong.

`CLAUDE_VISUAL_WSL_NET` defaults to `nat` when unset, deliberately: the
Windows-side receiver works under **both** modes, so guessing `nat` wrongly
costs a little ceremony, whereas wrongly assuming `mirrored` produces a server
the phone cannot reach.

**Port collision.** The default `8765` is the port `url-opener` uses on this
machine. This checkout runs on `8767` via `.env`; `.env.example` and the
`config.js` default still say `8765`, and the README's firewall rule quotes
`8765` too. See §15.

## 12. Install and autostart

`node bin/install.js [--autostart]`, idempotent, safe to re-run after moving the
project. It:

1. Detects the WSL networking mode by asking Windows for its IP list via
   PowerShell and testing whether the two sides' addresses **overlap** — that
   is the property that actually matters, and it is true however the mode was
   configured, unlike reading `networkingMode` out of `.wslconfig` (which misses
   the case where it was set through the WSL Settings GUI). A written-down value
   that disagrees with the probe is treated as a deliberate override: it is kept,
   with a warning.
2. Checks the checkout is visible to both halves under NAT'd WSL, and that a
   Windows `node.exe` exists.
3. Creates `.env` from `.env.example` if absent, and rewrites only the
   `CLAUDE_VISUAL_WSL_NET` line — everything else in `.env` belongs to the user.
4. Generates `~/.claude/commands/vis.md` with this checkout's absolute path
   baked in. The command embeds an absolute path, so it must be *generated* per
   machine rather than copied. An existing different `vis.md` is backed up first.
5. Repairs a dangling `~/.claude/commands` symlink. That directory is often a
   link into a dotfiles repo, and a dangling link silently stops **every**
   custom slash command from loading — a failure with no error message anywhere.
6. Optionally installs autostart: a `shell:startup` shortcut → `start-hidden.vbs`
   on Windows, a LaunchAgent on macOS, a systemd user unit on Linux and on
   mirrored WSL. Mirrored WSL uses systemd rather than a Windows shortcut, and
   WSL does not enable systemd by default — the installer says so when it fails.

Exit status is 1 if anything was left unresolved.

## 13. Milestones

- [x] Zero-dep multipart parser
- [x] Windows-side receiver with token auth and magic-byte validation
- [x] Mobile upload page: camera + library, instant upload, progress, sticky tag, home-screen icon
- [x] Staging tray + Send button, replacing auto-upload-on-select — rationale in §8.1. Tests: `test/page-tray.test.js`
- [x] Browser-side HEIC→JPEG conversion and downscale to 1568px
- [x] `claim.js` with all four selectors (`/vis`, `/vis N`, `/vis all`, `/vis <tag>`)
- [x] Recency window guard; verified a 2h-old image is listed but not claimed
- [x] Append-only `manifest.jsonl` recording every upload and which project claimed it
- [x] Interface ranking so the recommended URL is never a VPN, container bridge or WSL virtual address — §10. Tests: `test/netrank.test.js`
- [x] Cross-platform support: platform detection, `start-server.sh`, and autostart per platform — §12
- [x] `/vis` installed user-level (fixed the broken `~/.claude/commands` symlink)
- [x] Autostart via `shell:startup` shortcut → `start-hidden.vbs`
- [x] All configuration moved to `.env` / `.env.example`
- [x] `bin/install.js` + README install steps so this can be set up on another PC
- [x] End-to-end verified: upload → claim → archive → Read renders the image
- [x] Fixed the Add-to-Home-Screen token bug — §8.3. Regression test: `test/page-token.test.js`
- [x] Web app manifest so Android/Chrome installs standalone with the token in `start_url`, icons at 180/192/512
- [x] Licensed Apache-2.0 with a NOTICE file — rationale in §4
- [x] Support WSL mirrored networking instead of assuming NAT — §5.1, §12
- [x] Test the upload page on the actual iPhone (only curl-tested so far — camera capture,
      HEIC conversion and Add to Home Screen are unverified on real hardware)
      *(Verified 25 Jul 2026: a real photo arrived as a 376 KB JPEG at 1568px long edge,
      confirming Safari's HEIC→JPEG conversion and the downscale both work. Original
      wording kept — this line's card has already been archived under it.)*
- [ ] Add `/clip` to pull a `Win+Shift+S` screenshot straight off the Windows clipboard
- [ ] Sign into Tailscale on PC and iPhone so the same setup works off the home Wi-Fi
- [ ] Give the machine a DHCP reservation so the bookmarked LAN IP cannot drift
- [ ] Add a retention/prune policy for `archive/` — it grows forever right now
- [ ] Decide whether `/vis` should auto-run when a prompt mentions an image

## 14. Acceptance criteria

Run the three test files first — plain Node, no runner, no browser:
`node test/netrank.test.js && node test/page-token.test.js && node test/page-tray.test.js`.
The rest needs a real phone, which is what the checks below are for.

1. [ ] `node bin/install.js` on a fresh checkout reports the deployment shape from §5.1 that matches the machine.
2. [ ] The generated `~/.claude/commands/vis.md` contains this checkout's absolute path, and `/vis` resolves in an unrelated project directory.
3. [ ] The receiver prints at least one non-virtual URL, and lists virtual adapters annotated as unreachable rather than hiding them.
4. [ ] That URL opens on the phone over Wi-Fi and uploads a photo successfully from the browser.
5. [ ] Add to Home Screen, then fully restart the phone: the icon still uploads — this is the only way the cold-partition failure in §8.3 shows up.
6. [ ] Three photos staged and sent as one Send land as three files sharing a timestamp, each under 500 KB.
7. [ ] `/vis` in a fresh session claims all three, prints three paths, and the Read tool renders every one.
8. [ ] After that claim, `inbox/` is empty and `manifest.jsonl` holds three `upload` records and three `claim` records carrying the claiming project's path.
9. [ ] An image older than `CLAUDE_VISUAL_WINDOW_MIN` is listed by a bare `/vis` but not claimed, and is then claimed by `/vis all`.
10. [ ] `POST /upload` with a wrong token, and with no token at all, both return 401.
11. [ ] A non-image body sent with an image filename and an image content-type is rejected 415.
12. [ ] A photo sent with `Send original` checked arrives as HEIC and claims with the unreadable-file warning, rather than landing silently in `archive/`.
13. [ ] Two `/vis` runs racing on the same inbox claim disjoint sets — neither reports a file the other also reported.

<!-- Checkbox rules — this file is the ONLY source the Trello sync reads.
     `- [ ]` for unordered work, `N. [ ]` where order is the point. Both parse
     the same; the list marker is stripped before hashing, so renumbering or
     inserting a step never strands a card.
     One physical line per task — only the first line reaches the card.
     Never reword a pending task in place: card identity is a hash of the task
     text, so an edit strands the old card and creates a new one. To retire a
     task, check it off; to change its meaning, check the old one and add a
     new line. -->

## 15. Open questions

- **The default port collides with `url-opener`.** Both default to 8765; this
  checkout dodges it with `CLAUDE_VISUAL_PORT=8767` in `.env`. Unresolved
  whether the fix is to change the `config.js` default and `.env.example`
  (clean, but moves the port for anyone already running it), or to leave the
  default and document the clash. The README's firewall snippet quotes 8765
  either way and would need updating.
- **`archive/` and `manifest.jsonl` grow forever.** No prune, no rotation. The
  milestone in §13 covers the archive; the manifest is re-read in full by every
  `/vis`, so it is the one with a performance floor, not just a disk cost.
- **Should `/vis` auto-run when a prompt mentions an image?** Convenient, but it
  turns an explicit claim into an implicit one, and claiming is destructive to
  the queue. Tracked in §13.
- **HEIC is accepted server-side but unreadable downstream.** Currently surfaced
  as a warning after the file is already archived (§9.3). Rejecting it at upload
  would be a clearer contract, but would break `Send original` for the cases
  that legitimately want the untouched file.
- **`README.md` overstates the auth rule** — it says every request except
  `/health` needs the token, but `/`, `/icon.png` and `/manifest.webmanifest`
  are all unauthenticated by design (§7.1). Left as-is here rather than edited
  out of scope.

## 16. Files

- `project_spec.md` — this file
- `CLAUDE.md` — build/test commands and the invariants worth stating once
- `README.md` — per-platform install walkthroughs, usage, and configuration
- `docs/architecture.d2` — architecture diagram source
- `docs/upload-page.jpg` — screenshot used by the README
- `.env.example` — every tunable with its default, copied to `.env` by the installer
- `LICENSE` / `NOTICE` — Apache-2.0 and the required attribution notice
