'use client';

import Link from 'next/link';
import { type FormEvent, useEffect, useState } from 'react';
import { Captcha } from '../../components/captcha';
import { useI18n } from '../../components/i18n-provider';
import { CodeInput, PhoneInput, TextInput } from '../../components/inputs';
import { TelegramCard } from '../../components/telegram-card';
import { Button, ErrorText, LinkButton, Screen } from '../../components/ui';
import { useRequest } from '../../components/use-request';
import { api } from '../../lib/api';
import { formatPhone, isCompletePhone, toE164 } from '../../lib/phone';

type Step = 'phone' | 'code' | 'password' | 'done';

/**
 * Password reset: phone → code from the Telegram bot → new password. The API
 * signs the account out on every device; the user then signs in again.
 */
export default function ResetPasswordPage() {
  const { t } = useI18n();
  const { busy, error, setError, run, captchaFor } = useRequest();
  const [step, setStep] = useState<Step>('phone');
  const [digits, setDigits] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [code, setCode] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [resetToken, setResetToken] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  const requestCode = () =>
    run(async (captchaToken) => {
      const result = await api<{ challengeId: string; resendAfterS: number }>('/auth/otp', {
        method: 'POST',
        noRefresh: true,
        body: { phone: toE164(digits), purpose: 'reset_password', captchaToken },
      });
      setChallengeId(result.challengeId);
      setSecondsLeft(result.resendAfterS);
      setCode('');
      setStep('code');
    });

  const verifyCode = (value: string) =>
    run(async () => {
      const result = await api<{ resetToken: string }>('/auth/otp/verify', {
        method: 'POST',
        noRefresh: true,
        body: { challengeId, code: value },
      });
      setResetToken(result.resetToken);
      setStep('password');
    });

  const savePassword = () =>
    run(async () => {
      await api('/auth/password/reset', {
        method: 'POST',
        noRefresh: true,
        body: { resetToken, newPassword: password },
      });
      setPassword('');
      setStep('done');
    });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (step === 'phone') {
      if (!isCompletePhone(digits)) return setError(t('phone.invalid'));
      void requestCode();
    } else if (step === 'code') {
      void verifyCode(code);
    } else if (step === 'password') {
      void savePassword();
    }
  };

  if (step === 'done') {
    return (
      <Screen title={t('reset.title')}>
        <div className="stack">
          <p>{t('reset.done')}</p>
          <LinkButton href="/login">{t('reset.backToLogin')}</LinkButton>
        </div>
      </Screen>
    );
  }

  return (
    <Screen title={t('reset.title')}>
      <form onSubmit={onSubmit} className="stack" noValidate={step === 'phone'}>
        {step === 'phone' && (
          <>
            <TelegramCard purpose="signup" />
            <PhoneInput
              label={t('phone.label')}
              hint={t('reset.phoneHint')}
              digits={digits}
              onChange={setDigits}
            />
          </>
        )}
        {step === 'code' && (
          <>
            <p>{t('reset.codeSent', { phone: `+998 ${formatPhone(digits)}` })}</p>
            <CodeInput
              label={t('otp.labelTelegram')}
              value={code}
              onChange={setCode}
              onComplete={(value) => void verifyCode(value)}
            />
            <div className="row">
              <button
                type="button"
                className="text-link"
                disabled={secondsLeft > 0 || busy}
                onClick={() => void requestCode()}
              >
                {secondsLeft > 0 ? t('otp.resendIn', { seconds: secondsLeft }) : t('otp.resend')}
              </button>
              <button type="button" className="text-link" onClick={() => setStep('phone')}>
                {t('otp.wrongNumber')}
              </button>
            </div>
          </>
        )}
        {step === 'password' && (
          <>
            {/* Lets password managers save the new password for this account. */}
            <input type="hidden" autoComplete="username" value={toE164(digits)} />
            <TextInput
              label={t('reset.newPassword')}
              hint={t('signup.passwordHint')}
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              maxLength={128}
            />
          </>
        )}
        {captchaFor && <Captcha onToken={(token) => void captchaFor(token)} />}
        <ErrorText message={error} />
        <Button type="submit" busy={busy}>
          {step === 'phone'
            ? t('reset.sendCode')
            : step === 'code'
              ? t('signup.next')
              : t('reset.save')}
        </Button>
        <Link href="/login" className="text-link">
          {t('reset.backToLogin')}
        </Link>
      </form>
    </Screen>
  );
}
