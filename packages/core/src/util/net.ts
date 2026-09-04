// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * "Is this address on a private network?" — used for two different jobs, which is why it
 * lives here rather than in either caller.
 *
 *   1. **SSRF defence** (`store/casaos.ts`): a community app-store URL must not be allowed
 *      to point at 127.0.0.1, the Docker bridge, or a cloud metadata endpoint. Here a
 *      *false negative* (calling a private address public) is the dangerous direction.
 *   2. **The LAN-only guard** (`system/via-tunnel.ts`): a request from a public address must
 *      not reach the Fabric routes. Here a *false positive* (calling a public address
 *      private) is the dangerous direction.
 *
 * Because the two jobs fail in opposite directions, this has to be right rather than
 * roughly right, and it must be conservative about anything it cannot parse: an address we
 * do not understand is treated as PUBLIC, which is the safe answer for both callers (job 1
 * refuses to fetch it; job 2 refuses to trust it).
 *
 * The version this replaces got IPv4-mapped IPv6 wrong in a way worth remembering: it
 * matched only the dotted spelling `::ffff:127.0.0.1`, so the equivalent hex form
 * `::ffff:7f00:1` — and the fully-expanded `0:0:0:0:0:ffff:127.0.0.1` — fell through and
 * were classified as public. Same class of bug as the raw-vs-decoded URL comparisons: one
 * value, several spellings, and a check that only knew one of them.
 */

/** Decimal-dotted IPv4, with each octet range-checked. */
const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function v4Octets(ip: string): number[] | null {
  const m = V4.exec(ip);
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

/**
 * Reduce any spelling of an address to a canonical one we can test.
 *
 * Strips a zone id (`%eth0`), brackets (`[::1]`), and collapses every IPv4-mapped form to
 * plain dotted IPv4 so a single set of range checks covers them all.
 */
export function normaliseIp(raw: string): string {
  let ip = String(raw ?? '').trim().toLowerCase();
  if (ip.startsWith('[')) ip = ip.slice(1, ip.indexOf(']') === -1 ? undefined : ip.indexOf(']'));
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);

  // IPv4-mapped / IPv4-compatible, dotted tail: ::ffff:127.0.0.1, 0:0:0:0:0:ffff:10.1.2.3
  const dotted = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(ip);
  if (dotted && ip.includes(':')) {
    const head = ip.slice(0, ip.length - dotted[1]!.length).replace(/:+$/, '');
    // Only treat it as mapped when the head is all zeros and (optionally) ffff — otherwise
    // it is some other embedded form we should not silently flatten.
    const groups = head.split(':').filter((g) => g !== '');
    if (groups.every((g) => g === '0' || g === '0000' || g === 'ffff')) return dotted[1]!;
  }

  // IPv4-mapped, hex tail: ::ffff:7f00:1 (and the expanded 0:0:0:0:0:ffff:7f00:1)
  const hex = /^(.*:)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hex) {
    const head = hex[1]!.split(':').filter((g) => g !== '');
    if (head.every((g) => g === '0' || g === '0000')) {
      const hi = Number.parseInt(hex[2]!, 16);
      const lo = Number.parseInt(hex[3]!, 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      }
    }
  }
  return ip;
}

/**
 * True for loopback, private, link-local, CGNAT and other non-globally-routable addresses.
 *
 * Anything unparseable returns FALSE (treated as public) — see the module note on why that
 * is the safe direction for both callers.
 */
export function ipIsPrivate(raw: string): boolean {
  const ip = normaliseIp(raw);

  const v4 = v4Octets(ip);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    if (a === 0) return true; // 0.0.0.0/8 "this network"
    if (a === 10) return true; // RFC1918
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 protocol assignments (+ 192.0.2.0/24 docs)
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
    if (a === 198 && b === 51) return true; // documentation 198.51.100.0/24
    if (a === 203 && b === 0) return true; // documentation 203.0.113.0/24
    if (a >= 224) return true; // multicast + reserved + broadcast
    return false;
  }

  if (!ip.includes(':')) return false; // not an address we recognise at all
  if (ip === '::1' || ip === '::') return true; // loopback / unspecified
  // Expand only as far as the first group, which is all the checks below need.
  const first = ip.split(':')[0] ?? '';
  if (first.startsWith('fe8') || first.startsWith('fe9') || first.startsWith('fea') || first.startsWith('feb')) {
    return true; // fe80::/10 link-local
  }
  if (first.startsWith('fc') || first.startsWith('fd')) return true; // fc00::/7 unique-local
  if (first.startsWith('ff')) return true; // ff00::/8 multicast
  return false;
}

/**
 * THERE IS DELIBERATELY NO `peerIsPrivate()` HERE, AND ADDING ONE WOULD BE A REGRESSION.
 *
 * The obvious hardening for the "LAN-only" Fabric routes is to require the request's socket
 * peer to be a private address, on the reasoning that a peer address — unlike any header —
 * cannot be chosen by the client. That reasoning is correct in general and WRONG HERE, and
 * the difference is Docker's port publishing.
 *
 * With `userland-proxy=true` (the daemon default, and unset on our installs) `docker-proxy`
 * accepts the connection on the host and opens a SEPARATE connection to the container. The
 * container therefore sees the bridge gateway as the peer for everything. Measured on a real
 * daemon, all three of these arrive identically:
 *
 *     an app container calling the platform      -> 172.17.0.1
 *     cloudflared (network_mode: host)           -> 172.17.0.1
 *     a client from OUTSIDE the host entirely    -> 172.17.0.1
 *
 * So a peer check would answer "private" for an internet client: a guard that reads like an
 * allow-list while admitting everyone, which is worse than no guard because it invites
 * exactly the false confidence it appears to remove. `trpc/routers/auth.ts` already depends
 * on this same SNAT fact — it is why the login lockout cannot be per-IP.
 *
 * The real mitigations for a directly-reachable host are a bind address and a firewall in
 * front of it, plus documentation that does not overclaim. See docs/SECURITY.md.
 *
 * `ipIsPrivate` above remains correct and useful for its OTHER job — vetting an OUTBOUND
 * target for SSRF, where no NAT sits between us and the address we are about to connect to.
 */
