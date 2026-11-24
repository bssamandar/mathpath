'use client';

import { api, ApiError } from '@mathpath/client';
import Link from 'next/link';
import { type FormEvent, useEffect, useState } from 'react';
import { Captcha } from '../../components/captcha';
import { Button, ErrorText, Field } from '../../components/ui';
import { errorMessage } from '../../lib/editor';
import { t } from '../../lib/i18n';

/** Telegram bot that delivers the codes while SMS is off; inlined at build time. */
const BOT = process.env.NEXT_PUBLIC_TELEGRAM_BOT ?? '';

type Stage = 'phone' | 'code' | 'password' | 'done';

/**
 * Password reset: phone → code from the Telegram bot → new password. The API
 * signs the account out everywhere; staff then sign in with the new password
 * and still pass 2FA.
 */
export default function ResetPasswordPage() {
  const [stage, setStage] = useState<Stage>('phone');
  const [phone, setPhone] = useState('+998');
  const [challengeId, setChallengeId] = useState('');
  const [code, setCode] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [password, setPassword] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captcha, setCaptcha] = useState(false);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  const attempt = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      if (e instanceof ApiError && e.status === 428) setCaptcha(true);
      else setError(errorMessage(t, e));
    } finally {
      setBusy(false);
    }
  };

  const sendCode = (captchaToken?: string) =>
    attempt(async () => {
      const result = await api<{ challengeId: string; resendAfterS: number }>('/auth/otp', {
        method: 'POST',
        noRefresh: true,
        body: {
          phone: phone.replace(/\s/g, ''),
          purpose: 'reset_password',
          ...(captchaToken ? { captchaToken } : {}),
        },
      });
      setCaptcha(false);
      setChallengeId(result.challengeId);
      setSecondsLeft(result.resendAfterS);
      setCode('');
      setStage('code');
    });

  const verifyCode = () =>
    attempt(async () => {
      const result = await api<{ resetToken: string }>('/auth/otp/verify', {
        method: 'POST',
        noRefresh: true,
        body: { challengeId, code: code.replace(/\D/g, '') },
      });
      setResetToken(result.resetToken);
      setStage('password');
    });

  const savePassword = () =>
    attempt(async () => {
      await api('/auth/password/reset', {
        method: 'POST',
        noRefresh: true,
        body: { resetToken, newPassword: password },
      });
      setPassword('');
      setStage('done');
    });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (stage === 'phone') void sendCode();
    else if (stage === 'code') void verifyCode();
    else if (stage === 'password') void savePassword();
  };

  return (
    <main className="narrow">
      <h1>{t('reset.title')}</h1>

      {stage === 'done' ? (
        <section className="stack">
          <p>{t('reset.done')}</p>
          <Link className="button primary" href="/login">
            {t('reset.backToLogin')}
          </Link>
        </section>
      ) : (
        <form className="stack" noValidate onSubmit={onSubmit}>
          {stage === 'phone' && (
            <>
              <p>{t('reset.phoneStep')}</p>
              {BOT && (
                <p className="hint">
                  {t('reset.botHint', { bot: `@${BOT}` })}{' '}
                  <a
                    href={`https://t.me/${BOT}?start=studio`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('reset.openBot', { bot: `@${BOT}` })}
                  </a>
                </p>
              )}
              <Field
                label={t('login.phone')}
                hint={t('login.phoneHint')}
                type="tel"
                autoComplete="username"
                inputMode="tel"
                value={phone}
                onChange={setPhone}
              />
              {captcha && <Captcha onToken={(token) => void sendCode(token)} />}
            </>
          )}

          {stage === 'code' && (
            <>
              <p>{t('reset.codeSent')}</p>
              <Field
                label={t('reset.code')}
                autoComplete="one-time-code"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={setCode}
              />
              <button
                type="button"
                className="link"
                disabled={secondsLeft > 0 || busy}
                onClick={() => void sendCode()}
              >
                {secondsLeft > 0
                  ? t('reset.resendIn', { seconds: secondsLeft })
                  : t('reset.resend')}
              </button>
            </>
          )}

          {stage === 'password' && (
            <>
              {/* Lets password managers save the new password for this account. */}
              <input type="hidden" autoComplete="username" value={phone.replace(/\s/g, '')} />
              <Field
                label={t('reset.newPassword')}
                hint={t('reset.newPasswordHint')}
                type="password"
                autoComplete="new-password"
                minLength={10}
                maxLength={128}
                value={password}
                onChange={setPassword}
              />
            </>
          )}

          <ErrorText message={error} />
          <Button type="submit" busy={busy}>
            {stage === 'phone'
              ? t('reset.sendCode')
              : stage === 'code'
                ? t('reset.verify')
                : t('reset.save')}
          </Button>
          <Link className="link" href="/login">
            {t('reset.backToLogin')}
          </Link>
        </form>
      )}
    </main>
  );
}
