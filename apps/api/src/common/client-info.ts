/**
 * Coarse facts about the client, for rate limits, risk and the session list.
 *
 * Data minimisation: we keep the network prefix (/24 for IPv4, /48 for IPv6)
 * rather than the full IP address, and a short "Chrome on Android" summary
 * rather than the full user-agent string. Both are enough to spot abuse and to
 * let users recognise their sessions, and neither identifies a household.
 */
import { isIPv4, isIPv6 } from 'node:net';

/**
 * Reduces an IP address to its network prefix.
 *
 * @param ip - An IPv4, IPv6 or IPv4-mapped IPv6 address, as Express reports it.
 * @returns `a.b.c.0/24`, `xxxx:xxxx:xxxx::/48`, or null if the input is not an IP.
 */
export function ipPrefix(ip: string | undefined): string | null {
  if (!ip) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const address = mapped ? mapped[1]! : ip;
  if (isIPv4(address)) {
    const [a, b, c] = address.split('.');
    return `${a}.${b}.${c}.0/24`;
  }
  if (isIPv6(address)) {
    const groups = expandIPv6(address);
    return `${groups.slice(0, 3).join(':')}::/48`;
  }
  return null;
}

/** Expands `2001:db8::1` into its 8 groups, without leading zeros. */
function expandIPv6(address: string): string[] {
  const [head, tail] = address.split('::') as [string, string | undefined];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(missing).fill('0'), ...right].map((g) =>
    (parseInt(g, 16) || 0).toString(16),
  );
}

const browsers: [RegExp, string][] = [
  [/YaBrowser\//, 'Yandex Browser'],
  [/Edg\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];
const systems: [RegExp, string][] = [
  [/Android/, 'Android'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

/**
 * Summarises a user-agent string for the "your sessions" list.
 *
 * @param userAgent - The raw User-Agent header.
 * @returns For example "Chrome on Android", or null when the header is missing.
 */
export function userAgentSummary(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  const browser = browsers.find(([re]) => re.test(userAgent))?.[1] ?? 'Unknown browser';
  const system = systems.find(([re]) => re.test(userAgent))?.[1] ?? 'unknown system';
  return `${browser} on ${system}`;
}

/**
 * Spots user agents of scripts and headless browsers. Easy to fake, so it is
 * only one risk signal among several, never a reason to block on its own.
 */
export function looksAutomated(userAgent: string | undefined): boolean {
  if (!userAgent) return true;
  return /HeadlessChrome|PhantomJS|Puppeteer|Playwright|Selenium|curl\/|Wget|python-requests|python-httpx|Go-http-client|axios\//i.test(
    userAgent,
  );
}
