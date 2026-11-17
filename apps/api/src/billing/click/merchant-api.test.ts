import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ClickMerchantApi, clickAuthHeader } from './merchant-api';

const settings = {
  apiUrl: 'https://api.click.example/v2/merchant/',
  serviceId: '321',
  merchantUserId: '77',
  secretKey: ['test', 'secret', 'key'].join('-'),
};
const NOW = new Date('2026-12-01T10:00:00Z');

function reply(body: unknown) {
  return vi.fn().mockResolvedValue({ json: () => Promise.resolve(body) });
}

describe('clickAuthHeader', () => {
  it('is user ID, SHA-1 of timestamp + secret, and the timestamp in seconds', () => {
    const ts = String(NOW.getTime() / 1000);
    const digest = createHash('sha1')
      .update(ts + settings.secretKey)
      .digest('hex');
    expect(clickAuthHeader(settings, NOW)).toBe(`77:${digest}:${ts}`);
  });
});

describe('ClickMerchantApi.reverse', () => {
  it('sends DELETE to the reversal URL with the Auth header', async () => {
    const fetchFn = reply({ error_code: 0, error_note: 'Success', payment_id: 555 });
    const api = new ClickMerchantApi(settings, fetchFn);
    await expect(api.reverse('555', NOW)).resolves.toEqual({ ok: true, paymentId: '555' });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://api.click.example/v2/merchant/payment/reversal/321/555');
    expect(init.method).toBe('DELETE');
    expect(init.headers.Auth).toBe(clickAuthHeader(settings, NOW));
  });

  it('passes on Click refusals with their note', async () => {
    const api = new ClickMerchantApi(
      settings,
      reply({ error_code: -5017, error_note: 'Payment not found' }),
    );
    await expect(api.reverse('555', NOW)).resolves.toEqual({
      ok: false,
      code: -5017,
      note: 'Payment not found',
    });
  });

  it('reports an unknown outcome on network errors and unreadable answers', async () => {
    const failing = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('x'), { name: 'TimeoutError' }));
    await expect(new ClickMerchantApi(settings, failing).reverse('1', NOW)).resolves.toEqual({
      ok: false,
      code: null,
      note: 'no answer from Click (TimeoutError)',
    });
    await expect(
      new ClickMerchantApi(settings, reply({ nothing: true })).reverse('1', NOW),
    ).resolves.toMatchObject({ ok: false, code: null });
  });

  it('refuses an ID that is not Click’s without calling Click', async () => {
    const fetchFn = reply({ error_code: 0 });
    await expect(
      new ClickMerchantApi(settings, fetchFn).reverse('../evil', NOW),
    ).resolves.toMatchObject({ ok: false, code: null });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
