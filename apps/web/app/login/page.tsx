'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { Captcha } from '../../components/captcha';
import { useI18n } from '../../components/i18n-provider';
import { PhoneInput, TextInput } from '../../components/inputs';
import { TelegramCard } from '../../components/telegram-card';
import { Button, ErrorText, Screen } from '../../components/ui';
import { useRequest } from '../../components/use-request';
import { api, homeFor, rememberSession, type SessionInfo } from '../../lib/api';
import { isCompletePhone, toE164 } from '../../lib/phone';

/** Parent sign-in with phone and password. */
export default function LoginPage() {
  const { t } = useI18n();
  const router = useRouter();
  const { busy, error, setError, run, captchaFor } = useRequest();
  const [digits, setDigits] = useState('');
  const [password, setPassword] = useState('');

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!isCompletePhone(digits)) return setError(t('phone.invalid'));
    void run(async (captchaToken) => {
      const session = await api<SessionInfo>('/auth/login', {
        method: 'POST',
        noRefresh: true,
        body: { phone: toE164(digits), password, captchaToken },
      });
      rememberSession(session);
      router.push(homeFor(session.roles));
    });
  };

  return (
    <Screen title={t('login.title')}>
      <form onSubmit={onSubmit} className="stack" noValidate>
        <PhoneInput label={t('phone.label')} digits={digits} onChange={setDigits} />
        <TextInput
          label={t('login.password')}
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          maxLength={128}
        />
        {captchaFor && <Captcha onToken={(token) => void captchaFor(token)} />}
        <ErrorText message={error} />
        <Button type="submit" busy={busy}>
          {t('login.submit')}
        </Button>
        <Link href="/reset-password" className="text-link">
          {t('login.forgot')}
        </Link>
        <Link href="/signup" className="text-link">
          {t('login.noAccount')}
        </Link>
        <TelegramCard purpose="login" />
      </form>
    </Screen>
  );
}
