'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { Captcha } from '../../../../components/captcha';
import { useI18n } from '../../../../components/i18n-provider';
import { CodeInput, TextInput } from '../../../../components/inputs';
import { SignedIn } from '../../../../components/signed-in';
import { Button, ErrorText } from '../../../../components/ui';
import { useRequest } from '../../../../components/use-request';
import { api } from '../../../../lib/api';
import { CONSENT_VERSION } from '../../../../lib/legal';
import { pinProblem } from '../../../../lib/report';

interface Challenge {
  challengeId: string;
  resendAfterS: number;
}

const GRADES = Array.from({ length: 11 }, (_, i) => i + 1);

/**
 * F1, second part: add a child and give consent (UX F1). The parent confirms
 * the consent with an SMS code sent to their own phone, so the consent can be
 * shown to come from the account holder (C-30).
 */
export default function AddChildPage() {
  const { t } = useI18n();
  const router = useRouter();
  const { busy, error, setError, run, captchaFor } = useRequest();
  const [step, setStep] = useState<'details' | 'code'>('details');
  const [firstName, setFirstName] = useState('');
  const [nickname, setNickname] = useState('');
  const [grade, setGrade] = useState(5);
  const [pin, setPin] = useState('');
  const [learning, setLearning] = useState(false);
  const [leaderboard, setLeaderboard] = useState(false);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [code, setCode] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  const requestCode = () =>
    run(async (captchaToken) => {
      const result = await api<Challenge>('/auth/otp', {
        method: 'POST',
        body: { purpose: 'confirm_action', ...(captchaToken ? { captchaToken } : {}) },
      });
      setChallenge(result);
      setSecondsLeft(result.resendAfterS);
      setCode('');
      setStep('code');
    });

  const addChild = (otpCode: string) =>
    run(async () => {
      await api('/children', {
        method: 'POST',
        body: {
          firstName: firstName.trim(),
          nickname: nickname.trim(),
          grade,
          pin,
          consent: {
            policyVersion: CONSENT_VERSION,
            scopes: leaderboard ? ['learning', 'leaderboard'] : ['learning'],
            otpChallengeId: challenge!.challengeId,
            otpCode,
          },
        },
      });
      router.push('/parent');
    });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (step === 'code') return void addChild(code);
    if (!firstName.trim() || nickname.trim().length < 2) return setError(t('child.namesRequired'));
    const problem = pinProblem(pin);
    if (problem) return setError(t(problem === 'format' ? 'child.pinFormat' : 'child.pinSimple'));
    if (!learning) return setError(t('child.consentRequired'));
    void requestCode();
  };

  return (
    <SignedIn title={t('child.addTitle')}>
      <form onSubmit={onSubmit} className="stack" noValidate>
        {step === 'details' && (
          <>
            <TextInput
              label={t('child.firstName')}
              value={firstName}
              onChange={setFirstName}
              autoComplete="off"
              maxLength={60}
            />
            <TextInput
              label={t('child.nicknameLabel')}
              hint={t('child.nicknameHint')}
              value={nickname}
              onChange={setNickname}
              autoComplete="off"
              maxLength={24}
            />
            <div className="field">
              <label htmlFor="grade">{t('child.grade')}</label>
              <select id="grade" value={grade} onChange={(e) => setGrade(Number(e.target.value))}>
                {GRADES.map((g) => (
                  <option key={g} value={g}>
                    {t('child.gradeN', { n: g })}
                  </option>
                ))}
              </select>
            </div>
            <TextInput
              label={t('child.pinLabel')}
              hint={t('child.pinHint')}
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(value) => setPin(value.replace(/\D/g, '').slice(0, 6))}
              autoComplete="new-password"
              maxLength={6}
            />
            <fieldset className="consents">
              <legend>{t('child.consentTitle')}</legend>
              <label className="check">
                <input
                  type="checkbox"
                  checked={learning}
                  onChange={(e) => setLearning(e.target.checked)}
                />
                <span>{t('child.consentLearning')}</span>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={leaderboard}
                  onChange={(e) => setLeaderboard(e.target.checked)}
                />
                <span>{t('child.consentLeaderboard')}</span>
              </label>
            </fieldset>
          </>
        )}
        {step === 'code' && (
          <>
            <p>{t('child.codeSent')}</p>
            <CodeInput
              label={t('otp.label')}
              value={code}
              onChange={setCode}
              onComplete={(value) => void addChild(value)}
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
              <button type="button" className="text-link" onClick={() => setStep('details')}>
                {t('child.back')}
              </button>
            </div>
          </>
        )}
        {captchaFor && <Captcha onToken={(token) => void captchaFor(token)} />}
        <ErrorText message={error} />
        <Button type="submit" busy={busy}>
          {step === 'details' ? t('child.confirm') : t('child.add')}
        </Button>
      </form>
    </SignedIn>
  );
}
