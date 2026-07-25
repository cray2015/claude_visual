// Runs the page's inline script against a stub DOM to check the token paths,
// since the real ones only happen on a phone.
const page = require('../server/page.js');
const cfg = require('../config.js');

const html = page(cfg);
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));

function makeEl(id) {
  return {
    id, hidden: false, value: '', textContent: '', innerHTML: '', className: '',
    disabled: false, checked: false, style: {}, dataset: {}, onclick: null, files: [],
    addEventListener() {}, prepend() {}, appendChild() {}, remove() {},
    querySelector: () => makeEl(id + ':child'),
  };
}

function run({ search, stored }) {
  const els = {};
  const store = { ...stored };
  const calls = { replaceState: [] };

  const doc = {
    getElementById: id => (els[id] ||= makeEl(id)),
    querySelector: sel => (els[sel] ||= makeEl(sel)),
    createElement: () => makeEl('created'),
    head: makeEl('head'),
  };
  const sandbox = {
    document: doc,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    location: { href: 'http://192.168.1.50:8765/' + search, search, pathname: '/' },
    history: { replaceState: (a, b, u) => calls.replaceState.push(String(u)) },
    navigator: {},
    URL, URLSearchParams, FormData: class {}, XMLHttpRequest: class {},
    console,
  };

  const vm = require('vm');
  vm.createContext(sandbox);
  try {
    vm.runInContext(script, sandbox);
  } catch (e) {
    return { error: e.message };
  }
  return {
    // `let token` is a lexical binding inside the vm, not a sandbox property,
    // so what got persisted is the observable proxy for it.
    token: store.cv_token || null,
    stored: store.cv_token || null,
    el: doc.getElementById,
    manifestHref: els['link[rel="manifest"]'] && els['link[rel="manifest"]'].href,
    appHidden: els.app.hidden,
    needHidden: els.need.hidden,
    urlRewrites: calls.replaceState,
    savetok: els.savetok.onclick,
    els,
  };
}

const TOK = 'example-token-not-a-real-one';
let fail = 0;
const check = (label, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (detail ? '   ' + detail : ''));
  if (!cond) fail++;
};

console.log('\nA. Browser, token in URL (?k=...)');
let r = run({ search: '?k=' + TOK, stored: {} });
check('token adopted', r.token === TOK, r.token);
check('cached to localStorage', r.stored === TOK);
check('upload UI visible', r.appHidden === false);
check('token prompt hidden', r.needHidden === true);
check('URL NOT stripped (the bug)', r.urlRewrites.length === 0, JSON.stringify(r.urlRewrites));
// Android installs from the manifest's start_url, so it needs the token too —
// otherwise the installed app repeats the iOS home-screen failure exactly.
check('manifest start_url carries the token',
  r.manifestHref === '/manifest.webmanifest?k=' + TOK, r.manifestHref);

console.log('\nB. Bare URL, token only in localStorage');
r = run({ search: '', stored: { cv_token: TOK } });
check('token recovered from storage', r.token === TOK, r.token);
check('upload UI visible', r.appHidden === false);
check('URL rewritten to carry ?k=', r.urlRewrites.length === 1 && r.urlRewrites[0].includes('k=' + TOK),
  JSON.stringify(r.urlRewrites));

console.log('\nC. Installed app saved without the token');
r = run({ search: '', stored: {} });
check('no token', !r.token);
check('upload UI hidden', r.appHidden === true);
check('paste box shown', r.needHidden === false);
check('hint explains where to find it', /token\.txt/.test(r.els.hint.textContent), r.els.hint.textContent);
check('save handler wired', typeof r.savetok === 'function');

console.log('\nD. ...then pasting the token into that box');
r.el('tokin').value = '  ' + TOK + '  ';   // with stray whitespace
r.savetok();
check('token accepted + trimmed', r.el('tokin').value.trim() === TOK);
check('upload UI now visible', r.els.app.hidden === false);
check('paste box now hidden', r.els.need.hidden === true);
check('URL now carries ?k=', r.urlRewrites.some(u => u.includes('k=' + TOK)), JSON.stringify(r.urlRewrites));

console.log(fail ? `\n${fail} FAILURE(S)\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
