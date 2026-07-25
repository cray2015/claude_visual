// SPDX-License-Identifier: Apache-2.0
'use strict';

// The mobile upload page, served as one self-contained string. No build step,
// no external requests (the phone may reach this before it has internet).
//
// Flow: photos are STAGED into a tray (shoot repeatedly, or multi-select from
// the library, remove any you don't want), then sent as one batch. Staging
// beats auto-send-on-select for the actual use case — photographing one subject
// from several angles — because you get review, removal, and a single upload
// whose files all share a timestamp and arrive as one coherent set for /vis.
//
// Photos are re-encoded to JPEG at STAGE time, not send time. That does four
// useful things:
//   1. HEIC (what an iPhone actually shoots) becomes JPEG, which Claude can read.
//   2. 12MP originals shrink to ~1568px, the largest edge Claude uses anyway.
//   3. A staged photo holds ~300 KB instead of ~4 MB, so a full tray is cheap.
//   4. Send is then just I/O — no decoding at the moment you're waiting on it.
// "Send original" turns the re-encode off for the cases that need full detail.

module.exports = function page(cfg) {
  const MAX_EDGE = cfg.maxEdge;
  const QUALITY = cfg.jpegQuality;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Claude">
<meta name="theme-color" content="#141413">
<title>Send to Claude</title>
<link rel="apple-touch-icon" href="/icon.png">
<style>
  :root { color-scheme: light dark; --bg:#faf9f7; --fg:#141413; --mut:#6b6862;
          --card:#fff; --line:#e6e3dd; --accent:#c96442; --ok:#3d8168; --err:#c0392b; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#141413; --fg:#f5f4ef; --mut:#94908a; --card:#1f1e1d;
            --line:#312f2c; --accent:#d97757; --ok:#4fa287; --err:#e06c5b; }
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  /* Any author display rule beats the UA stylesheet's [hidden]{display:none},
     so .hd{display:flex} silently defeated the attribute on the "Sent" header.
     Guard it once here rather than per-rule. */
  [hidden] { display: none !important; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
         padding: max(20px, env(safe-area-inset-top)) 20px 130px; }
  h1 { font-size:19px; margin:0 0 2px; letter-spacing:-.01em; }
  .sub { color:var(--mut); font-size:13px; margin:0 0 22px; }
  .btn { display:flex; align-items:center; justify-content:center; gap:10px;
         width:100%; padding:20px; margin-bottom:12px; border:none; border-radius:16px;
         font-size:17px; font-weight:600; color:#fff; background:var(--accent);
         cursor:pointer; user-select:none; font-family:inherit; }
  .btn.alt { background:var(--card); color:var(--fg); border:1px solid var(--line); }
  .btn:active { transform:scale(.985); }
  .btn:disabled { opacity:.4; }
  .btn svg { width:22px; height:22px; }
  .row { display:flex; align-items:center; gap:12px; margin-top:16px; font-size:14px; }
  .row label { color:var(--mut); }
  input[type=text] { flex:1; min-width:0; padding:11px 13px; border-radius:11px;
        border:1px solid var(--line); background:var(--card); color:var(--fg); font-size:16px;
        font-family:inherit; }
  .sw { display:flex; align-items:center; gap:8px; color:var(--mut); font-size:14px; }

  .hd { display:flex; align-items:baseline; justify-content:space-between;
        margin:26px 0 10px; font-size:13px; color:var(--mut); }
  .hd b { color:var(--fg); font-size:14px; }
  .clear { color:var(--mut); text-decoration:underline; cursor:pointer; }
  ul { list-style:none; padding:0; margin:0; }
  li { display:flex; align-items:center; gap:12px; padding:10px; margin-bottom:8px;
       background:var(--card); border:1px solid var(--line); border-radius:12px; }
  li img { width:52px; height:52px; object-fit:cover; border-radius:8px; flex:none; background:var(--line); }
  .meta { flex:1; min-width:0; }
  .nm { font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .st { font-size:12px; color:var(--mut); }
  .st.done { color:var(--ok); }
  .st.err  { color:var(--err); }
  .x { flex:none; width:34px; height:34px; border-radius:17px; border:1px solid var(--line);
       background:transparent; color:var(--mut); font-size:19px; line-height:1;
       cursor:pointer; font-family:inherit; }
  .empty { color:var(--mut); font-size:13.5px; padding:14px 2px; }

  /* Sticky, with a live count — the one thing standing between a staged photo
     and it never arriving is remembering to press this. */
  #sendbar { position:fixed; left:0; right:0; bottom:0; padding:12px 20px
             max(12px, env(safe-area-inset-bottom)); background:var(--bg);
             border-top:1px solid var(--line); }
  #send { margin:0; }
  #sendbar .bar { height:3px; background:var(--line); border-radius:2px; overflow:hidden; margin-top:8px; }
  #sendbar .bar i { display:block; height:100%; width:0; background:var(--accent); transition:width .18s; }
  .hint { margin:24px 0 0; color:var(--mut); font-size:12.5px; text-align:center; line-height:1.6; }
  input[type=file] { display:none; }
</style>
</head>
<body>

<h1>Send to Claude</h1>
<p class="sub">Stage as many as you like, then send. Type <code>/vis</code> in any session.</p>

<div id="need" hidden>
  <p style="margin:0 0 12px;font-size:14px">This app has no access token yet — paste it below, once.</p>
  <div class="row" style="margin-top:0">
    <input type="text" id="tokin" placeholder="access token"
           autocapitalize="off" autocorrect="off" spellcheck="false">
  </div>
  <button class="btn" id="savetok" style="margin-top:12px">Save token</button>
</div>

<div id="app">
<button class="btn" id="cam">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
  Take Photo
</button>
<button class="btn alt" id="lib">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
  Choose Photos
</button>

<input type="file" id="fcam" accept="image/*" capture="environment">
<input type="file" id="flib" accept="image/*" multiple>

<div class="row">
  <label for="tag">Tag</label>
  <input type="text" id="tag" placeholder="optional — e.g. arduino"
         autocapitalize="off" autocorrect="off" spellcheck="false">
</div>
<div class="row">
  <label class="sw"><input type="checkbox" id="orig"> Send original (no resize)</label>
</div>

<div class="hd"><b>Ready to send</b><span class="clear" id="clear" hidden>clear all</span></div>
<ul id="tray"></ul>
<p class="empty" id="empty">Nothing staged yet. Take a photo or choose some.</p>

<div class="hd" id="senthd" hidden><b>Sent</b></div>
<ul id="log"></ul>
</div>

<p class="hint" id="hint">Install to the home screen for one-tap access &mdash;
  <b>Share &rarr; Add to Home Screen</b> on iOS, <b>menu &rarr; Install app</b> on Android.</p>

<div id="sendbar">
  <button class="btn" id="send" disabled>Send</button>
  <div class="bar"><i></i></div>
</div>

<script>
const MAX_EDGE = ${MAX_EDGE};
const QUALITY  = ${QUALITY};

// The token has to STAY in the URL. "Add to Home Screen" captures whatever URL
// is showing at that moment, and an iOS standalone web app gets its own
// localStorage partition — separate from the browser's — so a token cached
// while browsing is invisible to the installed app later. An earlier version
// stripped ?k= for tidiness and produced an icon that could never
// authenticate.
const qs = new URLSearchParams(location.search);
let token = qs.get('k') || localStorage.getItem('cv_token') || '';

function useToken(t) {
  token = t;
  localStorage.setItem('cv_token', t);
  // Put it back in the address bar if it only came from storage, so that
  // adding to the home screen from here still captures a working URL.
  if (qs.get('k') !== t) {
    const u = new URL(location.href);
    u.searchParams.set('k', t);
    history.replaceState(null, '', u);
  }
  // The manifest is wired up client-side, not served into the HTML, because
  // GET / is unauthenticated — embedding the token in the page would hand it to
  // anyone who can reach the port. start_url must carry the token, or an
  // installed Android app launches at bare "/" and can never authenticate.
  let mf = document.querySelector('link[rel="manifest"]');
  if (!mf) {
    mf = document.createElement('link');
    mf.rel = 'manifest';
    document.head.appendChild(mf);
  }
  mf.href = '/manifest.webmanifest?k=' + encodeURIComponent(t);

  document.getElementById('app').hidden = false;
  document.getElementById('need').hidden = true;
  document.getElementById('sendbar').hidden = false;
}

if (token) {
  useToken(token);
} else {
  // Recovers a home-screen icon that was saved without the token, without
  // making the user delete and re-add it.
  document.getElementById('app').hidden = true;
  document.getElementById('need').hidden = false;
  document.getElementById('sendbar').hidden = true;
  document.getElementById('hint').textContent =
    'The token is printed by the server, and is in server/token.txt on the PC.';
}
document.getElementById('savetok').onclick = () => {
  const v = document.getElementById('tokin').value.trim();
  if (v) useToken(v);
};

const tagEl = document.getElementById('tag');
tagEl.value = localStorage.getItem('cv_tag') || '';
tagEl.addEventListener('change', () => localStorage.setItem('cv_tag', tagEl.value.trim()));

const origEl = document.getElementById('orig');
origEl.checked = localStorage.getItem('cv_orig') === '1';
origEl.addEventListener('change', () => localStorage.setItem('cv_orig', origEl.checked ? '1' : '0'));

document.getElementById('cam').onclick = () => document.getElementById('fcam').click();
document.getElementById('lib').onclick = () => document.getElementById('flib').click();
for (const id of ['fcam', 'flib']) {
  document.getElementById(id).addEventListener('change', e => {
    const files = [...e.target.files];
    e.target.value = '';           // so the same photo can be re-picked
    files.forEach(stage);
  });
}

// ---- staging tray ---------------------------------------------------------

const staged = [];
let seq = 0;

const fmt = b => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';

function refresh() {
  const n = staged.length;
  const btn = document.getElementById('send');
  const busy = btn.dataset.busy === '1';
  btn.disabled = n === 0 || busy;
  btn.textContent = busy ? 'Sending…'
                   : n === 0 ? 'Send'
                   : n === 1 ? 'Send 1 photo'
                   : 'Send ' + n + ' photos';
  document.getElementById('empty').hidden = n > 0;
  document.getElementById('clear').hidden = n === 0;
}

// Decode -> fit inside MAX_EDGE -> JPEG. Falls back to the untouched file if
// the browser cannot decode it, so a weird format still reaches the PC.
async function shrink(file) {
  if (origEl.checked) return file;
  try {
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      bmp = await createImageBitmap(file);   // older Safari: no options bag
    }
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    if (scale === 1 && /jpe?g$/i.test(file.type)) { bmp.close?.(); return file; }
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', QUALITY));
    if (!blob) return file;
    const base = (file.name || 'photo').replace(/\\.[^.]*$/, '');
    return new File([blob], base + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

async function stage(original) {
  const id = ++seq;
  const li = document.createElement('li');
  li.innerHTML = '<img><div class="meta"><div class="nm"></div><div class="st">preparing…</div></div>' +
                 '<button class="x" aria-label="Remove">&times;</button>';
  li.querySelector('.nm').textContent = original.name || 'photo';

  const url = URL.createObjectURL(original);
  const img = li.querySelector('img');
  img.src = url;

  const entry = { id, li, url, file: null };
  staged.push(entry);
  document.getElementById('tray').appendChild(li);
  refresh();

  li.querySelector('.x').onclick = () => remove(id);

  // Resize now, while staged, so the tray stays cheap and Send is pure I/O.
  entry.file = await shrink(original);
  li.querySelector('.st').textContent = fmt(entry.file.size);
  refresh();
}

function remove(id) {
  const i = staged.findIndex(e => e.id === id);
  if (i === -1) return;
  URL.revokeObjectURL(staged[i].url);
  staged[i].li.remove();
  staged.splice(i, 1);
  refresh();
}

document.getElementById('clear').onclick = () => {
  while (staged.length) remove(staged[0].id);
};

// ---- send -----------------------------------------------------------------

document.getElementById('send').onclick = () => {
  if (!staged.length) return;
  // A photo still being resized has no file yet; wait rather than skip it.
  if (staged.some(e => !e.file)) {
    setTimeout(() => document.getElementById('send').onclick(), 150);
    return;
  }

  const btn = document.getElementById('send');
  const bar = document.querySelector('#sendbar .bar i');
  btn.dataset.busy = '1';
  refresh();

  const batch = staged.slice();
  const fd = new FormData();
  fd.append('tag', tagEl.value.trim());
  // One request for the whole tray: every file then shares a timestamp and
  // arrives as a single coherent set for /vis.
  for (const e of batch) fd.append('file', e.file, e.file.name);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/upload');
  xhr.setRequestHeader('X-Token', token);
  xhr.upload.onprogress = ev => {
    if (ev.lengthComputable) bar.style.width = (ev.loaded / ev.total * 100) + '%';
  };
  xhr.onload = () => {
    btn.dataset.busy = '0';
    bar.style.width = '0';
    if (xhr.status === 200) {
      for (const e of batch) {
        e.li.querySelector('.x').remove();
        const st = e.li.querySelector('.st');
        st.className = 'st done';
        st.textContent = '\\u2713 sent \\u2014 ready for /vis';
        document.getElementById('log').prepend(e.li);
        URL.revokeObjectURL(e.url);
        const i = staged.indexOf(e);
        if (i > -1) staged.splice(i, 1);
      }
      document.getElementById('senthd').hidden = false;
      if (navigator.vibrate) navigator.vibrate(12);
    } else {
      // Keep the tray intact so the whole batch can just be re-sent.
      for (const e of batch) {
        const st = e.li.querySelector('.st');
        st.className = 'st err';
        st.textContent = 'failed: ' + (xhr.responseText || xhr.status);
      }
    }
    refresh();
  };
  xhr.onerror = () => {
    btn.dataset.busy = '0';
    bar.style.width = '0';
    for (const e of batch) {
      const st = e.li.querySelector('.st');
      st.className = 'st err';
      st.textContent = 'network error — tap Send to retry';
    }
    refresh();
  };
  xhr.send(fd);
};

refresh();
</script>
</body>
</html>`;
};
