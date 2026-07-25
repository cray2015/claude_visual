// Exercises the staging tray against a stub DOM: staging, the live count on the
// Send button, removing one, and clearing all. The tray is the difference
// between "one photo arrives instantly" and "a set of photos arrives together",
// so its counting and removal logic is worth pinning down.
const vm = require('vm');
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

class U extends URL {}
U.createObjectURL = () => 'blob:stub';
U.revokeObjectURL = () => {};

const els = {};
const store = { cv_token: 'TOK' };
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
  location: { href: 'http://x/?k=TOK', search: '?k=TOK', pathname: '/' },
  history: { replaceState() {} },
  navigator: {},
  setTimeout,
  URL: U, URLSearchParams, FormData: class {}, XMLHttpRequest: class {},
  // Absent on purpose: shrink() must fall back to the original file when the
  // browser cannot decode, which is exactly what happens here.
  console,
};
vm.createContext(sandbox);
vm.runInContext(script, sandbox);

let fail = 0;
const check = (label, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (detail ? '   ' + detail : ''));
  if (!cond) fail++;
};

const file = n => ({ name: n, size: 300 * 1024, type: 'image/jpeg' });
const sendBtn = () => els.send;

(async () => {
  console.log('\nEmpty tray');
  check('button disabled', sendBtn().disabled === true);
  check('label is bare "Send"', sendBtn().textContent === 'Send', sendBtn().textContent);
  check('placeholder shown', els.empty.hidden === false);
  check('"clear all" hidden', els.clear.hidden === true);

  console.log('\nStage three photos');
  await sandbox.stage(file('a.jpg'));
  await sandbox.stage(file('b.jpg'));
  await sandbox.stage(file('c.jpg'));
  check('count in label', sendBtn().textContent === 'Send 3 photos', sendBtn().textContent);
  check('button enabled', sendBtn().disabled === false);
  check('placeholder hidden', els.empty.hidden === true);
  check('"clear all" shown', els.clear.hidden === false);

  console.log('\nRemove one');
  sandbox.remove(2);
  check('count drops to 2', sendBtn().textContent === 'Send 2 photos', sendBtn().textContent);

  console.log('\nDown to a single photo (singular wording)');
  sandbox.remove(1);
  check('label singular', sendBtn().textContent === 'Send 1 photo', sendBtn().textContent);

  console.log('\nClear all');
  els.clear.onclick();
  check('label back to "Send"', sendBtn().textContent === 'Send', sendBtn().textContent);
  check('button disabled again', sendBtn().disabled === true);
  check('placeholder back', els.empty.hidden === false);

  console.log('\nSend with nothing staged is a no-op');
  let threw = null;
  try { sendBtn().onclick(); } catch (e) { threw = e.message; }
  check('does not throw', threw === null, threw || '');

  console.log(fail ? `\n${fail} FAILURE(S)\n` : '\nall passed\n');
  process.exit(fail ? 1 : 0);
})();
