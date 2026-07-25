// SPDX-License-Identifier: Apache-2.0
'use strict';

// Picks which of the machine's addresses to hand the phone.
//
// Rank by "can the phone actually reach this?". The top entry is what the
// server prints first and what claim.js quotes back to the user, so the order
// matters: a VPN tunnel, a container bridge or the WSL vSwitch all carry
// perfectly valid private IPs that a phone can never reach.
//
// Covers adapter naming on all three platforms:
//   Windows  vEthernet (WSL…), CloudflareWARP, Bluetooth…, VPN - …
//   macOS    utunN (VPN/Tailscale), awdlN, llwN, bridgeN, vmnetN
//   Linux    dockerN, br-…, vethN, virbrN, tunN, tailscale0, wgN

const os = require('os');

const VIRTUAL = /warp|vethernet|hyper-v|virtual|vmnet|vboxnet|docker|virbr|zerotier|vpn|bluetooth|^lo$|^br-|^veth|^utun|^awdl|^llw|^bridge|^tun\d|^tap\d|^wg\d/i;

function rank(iface, ip) {
  // 100.64.0.0/10 is CGNAT space, which in practice means Tailscale — and that
  // address keeps working off-LAN. Checked by IP rather than adapter name
  // because Tailscale is "tailscale0" on Linux but "utunN" on macOS, and the
  // latter would otherwise be penalised as a tunnel.
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return 100;
  if (VIRTUAL.test(iface)) return -100;                          // unreachable from the phone
  if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return 50;
  return 0;
}

// `ifaces` defaults to the live machine; injectable so tests can present a
// macOS or Linux box without being on one.
function addresses(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const [iface, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;            // APIPA, unreachable
      out.push({ iface, ip: a.address, rank: rank(iface, a.address) });
    }
  }
  return out.sort((a, b) => b.rank - a.rank);
}

module.exports = { rank, addresses, VIRTUAL };
