'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { Captcha } from '../../components/captcha';
import { useI18n } from '../../components/i18n-provider';
import { CodeInput, PhoneInput, TextInput } from '../../components/inputs';
import { Button, ErrorText, Screen } from '../../components/ui';
import { useRequest } from '../../components/use-request';
import { api, homeFor, rememberSession, type SessionInfo } from '../../lib/api';
import { TERMS_VERSION } from '../../lib/legal';
import { formatPhone, isCompletePhone, toE164 } from '../../lib/phone';

type Step = 'phone' | 'code' | 'details';

interface Challenge {
  challengeId: string;
  resendAfterS: number;
}

/** F1, first part: phone → SMS code → name and password (UX S2). */
export default function SignupPage() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { busy, error, setError, run, captchaFor } = useRequest();
  const [step, setStep] = useState<Step>('phone');
  const [digits, setDigits] = useState('');
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [code, setCode] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [registrationToken, setRegistrationToken] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [password, setPassword] = useState('');
  const [terms, setTerms] = useState(false);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  const requestCode = () =>
    run(async (captchaToken) => {
      const result = await api<Challenge>('/auth/otp', {
        method: 'POST',
        body: { phone: toE164(digits), purpose: 'signup', captchaToken },
      });
      setChallenge(result);
      setSecondsLeft(result.resendAfterS);
      setCode('');
      setStep('code');
    });

  const verifyCode = (value: string) =>
    run(async () => {
      const result = await api<{ registrationToken: string }>('/auth/otp/verify', {
        method: 'POST',
        body: { challengeId: challenge!.challengeId, code: value },
      });
      setRegistrationToken(result.registrationToken);
      setStep('details');
    });

  const register = () =>
    run(async () => {
      const session = await api<SessionInfo>('/auth/register', {
        method: 'POST',
        noRefresh: true,
        body: {
          registrationToken,
          firstName: firstName.trim(),
          ...(lastName.trim() ? { lastName: lastName.trim() } : {}),
          password,
          role: 'parent',
          locale,
          acceptedTermsVersion: TERMS_VERSION,
        },
      });
      rememberSession(session);
      router.push(homeFor(session.roles));
    });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (step === 'phone') {
      if (!isCompletePhone(digits)) return setError(t('phone.invalid'));
      void requestCode();
    } else if (step === 'code') {
      void verifyCode(code);
    } else {
      void register();
    }
  };

  return (
    <Screen title={step === 'details' ? t('signup.detailsTitle') : t('signup.title')}>
      <form onSubmit={onSubmit} className="stack" noValidate={step === 'phone'}>
        {step === 'phone' && (
          <PhoneInput
            label={t('phone.label')}
            hint={t('phone.hint')}
            digits={digits}
            onChange={setDigits}
          />
        )}
        {step === 'code' && (
          <>
            <p>{t('otp.sentTo', { phone: `+998 ${formatPhone(digits)}` })}</p>
            <CodeInput
              label={t('otp.label')}
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
        {step === 'details' && (
          <>
            <TextInput
              label={t('signup.firstName')}
              value={firstName}
              onChange={setFirstName}
              autoComplete="given-name"
              maxLength={50}
            />
            <TextInput
              label={t('signup.lastName')}
              value={lastName}
              onChange={setLastName}
              autoComplete="family-name"
              maxLength={50}
              required={false}
            />
            <TextInput
              label={t('signup.password')}
              hint={t('signup.passwordHint')}
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              maxLength={128}
            />
            <label className="check">
              <input
                type="checkbox"
                checked={terms}
                onChange={(e) => setTerms(e.target.checked)}
                required
              />
              <span>{t('signup.terms')}</span>
            </label>
          </>
        )}
        {captchaFor && <Captcha onToken={(token) => void captchaFor(token)} />}
        <ErrorText message={error} />
        <Button type="submit" busy={busy} disabled={step === 'details' && !terms}>
          {step === 'details' ? t('signup.create') : t('signup.next')}
        </Button>
      </form>
    </Screen>
  );
}
