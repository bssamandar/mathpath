import { describe, expect, it } from 'vitest';
import { ipPrefix, userAgentSummary } from './client-info';
import { SystemClock } from './clock';

describe('ipPrefix', () => {
  it('keeps the /24 of an IPv4 address', () => {
    expect(ipPrefix('203.0.113.77')).toBe('203.0.113.0/24');
    expect(ipPrefix('::ffff:203.0.113.77')).toBe('203.0.113.0/24');
  });

  it('keeps the /48 of an IPv6 address', () => {
    expect(ipPrefix('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
    expect(ipPrefix('2001:0db8::1')).toBe('2001:db8:0::/48');
    expect(ipPrefix('::1')).toBe('0:0:0::/48');
  });

  it('returns null for missing or invalid input', () => {
    expect(ipPrefix(undefined)).toBeNull();
    expect(ipPrefix('not-an-ip')).toBeNull();
  });
});

describe('userAgentSummary', () => {
  it('names the browser and system without keeping the full string', () => {
    expect(
      userAgentSummary(
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
      ),
    ).toBe('Chrome on Android');
    expect(
      userAgentSummary(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari on iOS');
    expect(
      userAgentSummary('Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 YaBrowser/24.0 Safari/537.36'),
    ).toBe('Yandex Browser on Windows');
    expect(userAgentSummary('curl/8.0')).toBe('Unknown browser on unknown system');
    expect(userAgentSummary(undefined)).toBeNull();
  });
});

describe('SystemClock', () => {
  it('returns the current time', () => {
    const before = Date.now();
    expect(new SystemClock().now().getTime()).toBeGreaterThanOrEqual(before);
  });
});
