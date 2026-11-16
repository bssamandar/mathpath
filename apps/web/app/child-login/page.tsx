'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { useI18n } from '../../components/i18n-provider';
import { TextInput } from '../../components/inputs';
import { Button, ErrorText, Screen } from '../../components/ui';
import { useRequest } from '../../components/use-request';
import { api, rememberSession, type SessionInfo } from '../../lib/api';

/**
 * F2 on another device: family code, nickname and PIN. The nickname is typed,
 * not picked from a list: a list would show any family's children to anyone
 * who guesses a code.
 */
export default function ChildLoginPage() {
  const { t } = useI18n();
  const router = useRouter();
  const { busy, error, run } = useRequest();
  const [familyCode, setFamilyCode] = useState('');
  const [nickname, setNickname] = useState('');
  const [pin, setPin] = useState('');

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const session = await api<SessionInfo>('/auth/child-login', {
        method: 'POST',
        noRefresh: true,
        body: { familyCode: familyCode.trim(), nickname: nickname.trim(), pin },
      });
      rememberSession(session);
      router.push('/student');
    });
  };

  return (
    <Screen title={t('child.title')}>
      <form onSubmit={onSubmit} className="stack child">
        <TextInput
          label={t('child.familyCode')}
          hint={t('child.familyCodeHint')}
          value={familyCode}
          onChange={(v) =>
            setFamilyCode(
              v
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, '')
                .slice(0, 8),
            )
          }
          autoComplete="off"
          maxLength={8}
        />
        <TextInput
          label={t('child.nickname')}
          value={nickname}
          onChange={setNickname}
          autoComplete="username"
          maxLength={24}
        />
        <TextInput
          label={t('child.pin')}
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={(v) => setPin(v.replace(/\D/g, '').slice(0, 6))}
          autoComplete="current-password"
          maxLength={6}
        />
        <ErrorText message={error} />
        <Button type="submit" busy={busy}>
          {t('child.submit')}
        </Button>
      </form>
    </Screen>
  );
}
