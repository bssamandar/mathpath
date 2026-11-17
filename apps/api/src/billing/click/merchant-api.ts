/**
 * Click Merchant API client: only what refunds need (ADR-0008).
 *
 * Every request carries `Auth: merchant_user_id:digest:timestamp`, where the
 * digest is SHA-1 of the Unix timestamp (seconds) followed by the service's
 * secret key. A reversal (`DELETE payment/reversal/{service_id}/{payment_id}`)
 * returns the whole payment to the card. `payment_id` is Click's transaction
 * ID, the `click_trans_id` of the Shop API callbacks, which we keep as the
 * payment's `provider_txn_id`.
 *
 * Click's limits: only successful card payments, only in the month they were
 * made (previous-month payments only on the 1st), and UZCARD may refuse.
 * Click explains a refusal in `error_note`, which we show to the admin.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export interface ClickMerchantSettings {
  apiUrl: string;
  serviceId: string;
  merchantUserId: string;
  secretKey: string;
}

export type ReversalResult =
  | { ok: true; paymentId: string }
  | { ok: false; code: number | null; note: string };

const reply = z
  .object({
    error_code: z.coerce.number().int(),
    error_note: z.string().max(1000).optional(),
    payment_id: z.union([z.string(), z.number()]).optional(),
  })
  .loose();

/** The `Auth` header value for this moment. */
export function clickAuthHeader(
  settings: Pick<ClickMerchantSettings, 'merchantUserId' | 'secretKey'>,
  now: Date,
): string {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const digest = createHash('sha1')
    .update(timestamp + settings.secretKey)
    .digest('hex');
  return `${settings.merchantUserId}:${digest}:${timestamp}`;
}

export class ClickMerchantApi {
  constructor(
    private readonly settings: ClickMerchantSettings,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  /**
   * Reverses a whole payment. Never throws for Click's own refusals; a
   * network failure or an unreadable answer is reported as `code: null`,
   * because then we cannot know whether Click reversed it.
   */
  async reverse(clickTransId: string, now: Date): Promise<ReversalResult> {
    if (!/^\d{1,20}$/.test(clickTransId)) {
      return { ok: false, code: null, note: 'not a Click transaction ID' };
    }
    const base = this.settings.apiUrl.replace(/\/+$/, '');
    const url = `${base}/payment/reversal/${this.settings.serviceId}/${clickTransId}`;
    let body: unknown;
    try {
      const response = await this.fetchFn(url, {
        method: 'DELETE',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Auth: clickAuthHeader(this.settings, now),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      body = await response.json();
    } catch (error) {
      return {
        ok: false,
        code: null,
        note: `no answer from Click (${error instanceof Error ? error.name : 'error'})`,
      };
    }
    const parsed = reply.safeParse(body);
    if (!parsed.success) return { ok: false, code: null, note: 'unreadable answer from Click' };
    const { error_code: code, error_note: note } = parsed.data;
    if (code === 0) return { ok: true, paymentId: clickTransId };
    return { ok: false, code, note: note?.slice(0, 300) || `Click error ${code}` };
  }
}
