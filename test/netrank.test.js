// Which address do we hand the phone? Every machine has several, and most of
// them carry a perfectly valid private IP the phone can never reach. Interface
// naming differs per OS, so this presents realistic Windows / macOS / Linux
// machines and checks the top-ranked address is the one that actually works.
const { rank, addresses } = require('../server/netrank');

let fail = 0;
const check = (label, cond, detail) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (detail ? '   ' + detail : ''));
  if (!cond) fail++;
};

const v4 = (address, internal = false) => ({ address, family: 'IPv4', internal });
const top = m => addresses(m)[0];

console.log('\nWindows + WSL, on Wi-Fi behind CloudflareWARP');
let m = {
  'vEthernet (WSL (Hyper-V firewall))': [v4('192.168.112.1')],
  'CloudflareWARP': [v4('172.16.0.2')],
  'Wi-Fi': [v4('192.168.1.50')],
  'Ethernet 3': [v4('169.254.59.183')],
  'Loopback Pseudo-Interface 1': [v4('127.0.0.1', true)],
};
check('picks Wi-Fi', top(m).ip === '192.168.1.50', top(m).iface + ' ' + top(m).ip);
check('WARP ranked unreachable', rank('CloudflareWARP', '172.16.0.2') < 0);
check('WSL vSwitch ranked unreachable', rank('vEthernet (WSL (Hyper-V firewall))', '192.168.112.1') < 0);
check('APIPA dropped entirely', !addresses(m).some(a => a.ip.startsWith('169.254.')));
check('loopback dropped', !addresses(m).some(a => a.ip === '127.0.0.1'));

console.log('\nmacOS laptop, Wi-Fi + a VPN + AirDrop');
m = {
  lo0: [v4('127.0.0.1', true)],
  en0: [v4('192.168.1.42')],
  awdl0: [v4('169.254.12.9')],
  llw0: [v4('169.254.88.3')],
  utun4: [v4('10.8.0.6')],          // corporate VPN — routable-looking, unreachable
  bridge0: [v4('192.168.64.1')],    // Internet Sharing / VM bridge
};
check('picks en0', top(m).ip === '192.168.1.42', top(m).iface + ' ' + top(m).ip);
check('VPN utun ranked unreachable', rank('utun4', '10.8.0.6') < 0);
check('bridge0 ranked unreachable', rank('bridge0', '192.168.64.1') < 0);

console.log('\nLinux desktop with Docker and libvirt');
m = {
  lo: [v4('127.0.0.1', true)],
  wlp2s0: [v4('192.168.1.55')],
  docker0: [v4('172.17.0.1')],
  'br-3f1a2b': [v4('172.18.0.1')],
  virbr0: [v4('192.168.122.1')],
  veth9a1: [v4('10.0.3.2')],
};
check('picks the wireless NIC', top(m).ip === '192.168.1.55', top(m).iface + ' ' + top(m).ip);
check('docker0 ranked unreachable', rank('docker0', '172.17.0.1') < 0);
check('compose bridge ranked unreachable', rank('br-3f1a2b', '172.18.0.1') < 0);
check('libvirt bridge ranked unreachable', rank('virbr0', '192.168.122.1') < 0);
check('veth ranked unreachable', rank('veth9a1', '10.0.3.2') < 0);

console.log('\nTailscale outranks the LAN (it keeps working off-LAN)');
check('linux tailscale0', rank('tailscale0', '100.101.102.103') > rank('wlp2s0', '192.168.1.55'));
// The subtle one: on macOS Tailscale is a utunN, which the name rule would
// otherwise bury. Ranking by CGNAT address is what saves it.
check('macOS Tailscale on utun still wins', rank('utun3', '100.83.14.2') > rank('en0', '192.168.1.42'),
  'utun3=' + rank('utun3', '100.83.14.2'));
m = { en0: [v4('192.168.1.42')], utun3: [v4('100.83.14.2')] };
check('and sorts to the top', top(m).ip === '100.83.14.2', top(m).iface + ' ' + top(m).ip);

console.log('\nCGNAT range boundaries');
check('100.63.x is NOT tailscale', rank('x', '100.63.0.1') !== 100);
check('100.64.x is', rank('x', '100.64.0.1') === 100);
check('100.127.x is', rank('x', '100.127.255.1') === 100);
check('100.128.x is NOT', rank('x', '100.128.0.1') !== 100);

console.log('\nNo usable address at all');
check('empty list, no crash', addresses({ lo: [v4('127.0.0.1', true)] }).length === 0);

console.log(fail ? `\n${fail} FAILURE(S)\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
