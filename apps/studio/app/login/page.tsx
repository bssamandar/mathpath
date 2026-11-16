'use client';

import { api, ApiError, rememberSession, type SessionInfo } from '@mathpath/client';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { Captcha } from '../../components/captcha';
import { Button, ErrorText, Field } from '../../components/ui';
import { errorMessage } from '../../lib/editor';
import { t } from '../../lib/i18n';
import { otpauthSecret } from '../../lib/mfa';

const STAFF = ['author', 'reviewer', 'admin'];

type Stage =
  | { kind: 'password' }
  | { kind: 'code' }
  | { kind: 'enrol'; factorId: string; otpauthUri: string }
  | { kind: 'recovery-codes'; codes: string[] };

/**
 * Staff sign-in (security plan C-08): phone and password, then TOTP. A staff
 * member without an authenticator yet is enrolled here, and sees their
 * recovery codes once.
 */
export default function LoginPage() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ kind: 'password' });
  const [phone, setPhone] = useState('+998');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captcha, setCaptcha] = useState(false);

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

  const finish = (session: SessionInfo) => {
    rememberSession(session);
    router.replace('/');
  };

  const signIn = (captchaToken?: string) =>
    attempt(async () => {
      const session = await api<SessionInfo>('/auth/login', {
        method: 'POST',
        noRefresh: true,
        body: {
          phone: phone.replace(/\s/g, ''),
          password,
          ...(captchaToken ? { captchaToken } : {}),
        },
      });
      setCaptcha(false);
      rememberSession(session);
      if (!session.roles.some((r) => STAFF.includes(r))) {
        setError(t('login.notStaff'));
        return;
      }
      if (!session.mfaRequired) return finish(session);
      // Has an authenticator already? Enrolment refuses with MFA_REQUIRED if so.
      try {
        const enrolment = await api<{ factorId: string; otpauthUri: string }>('/auth/mfa/totp', {
          method: 'POST',
        });
        setStage({ kind: 'enrol', ...enrolment });
      } catch (e) {
        if (e instanceof ApiError && e.code === 'MFA_REQUIRED') setStage({ kind: 'code' });
        else throw e;
      }
    });

  const verify = (event: FormEvent) => {
    event.preventDefault();
    void attempt(async () => {
      const body =
        useRecovery && stage.kind === 'code'
          ? { recoveryCode: code.trim() }
          : {
              code: code.replace(/\D/g, ''),
              ...(stage.kind === 'enrol' ? { factorId: stage.factorId } : {}),
            };
      const result = await api<{ session: SessionInfo; recoveryCodes?: string[] }>(
        '/auth/mfa/verify',
        { method: 'POST', body },
      );
      rememberSession(result.session);
      if (result.recoveryCodes) setStage({ kind: 'recovery-codes', codes: result.recoveryCodes });
      else finish(result.session);
    });
  };

  return (
    <main className="narrow">
      <h1>{stage.kind === 'password' ? t('login.title') : t('mfa.title')}</h1>

      {stage.kind === 'password' && (
        <form
          className="stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void signIn();
          }}
        >
          <Field
            label={t('login.phone')}
            hint={t('login.phoneHint')}
            type="tel"
            autoComplete="username"
            inputMode="tel"
            value={phone}
            onChange={setPhone}
          />
          <Field
            label={t('login.password')}
            type="password"
            autoComplete="current-password"
            maxLength={128}
            value={password}
            onChange={setPassword}
          />
          {captcha && <Captcha onToken={(token) => void signIn(token)} />}
          <ErrorText message={error} />
          <Button type="submit" busy={busy}>
            {t('login.submit')}
          </Button>
        </form>
      )}

      {stage.kind === 'enrol' && (
        <section className="stack">
          <h2>{t('mfa.enrolTitle')}</h2>
          <p>{t('mfa.enrolSteps')}</p>
          <p>
            <a className="button secondary" href={stage.otpauthUri}>
              {t('mfa.openApp')}
            </a>
          </p>
          <p>
            {t('mfa.secret')}: <code className="secret">{otpauthSecret(stage.otpauthUri)}</code>
          </p>
        </section>
      )}

      {(stage.kind === 'code' || stage.kind === 'enrol') && (
        <form className="stack" onSubmit={verify} noValidate>
          <Field
            label={useRecovery ? t('mfa.recoveryCode') : t('mfa.enterCode')}
            autoComplete="one-time-code"
            inputMode={useRecovery ? 'text' : 'numeric'}
            maxLength={useRecovery ? 32 : 6}
            value={code}
            onChange={setCode}
          />
          <ErrorText message={error} />
          <Button type="submit" busy={busy}>
            {t('mfa.verify')}
          </Button>
          {stage.kind === 'code' && !useRecovery && (
            <button type="button" className="link" onClick={() => setUseRecovery(true)}>
              {t('mfa.useRecovery')}
            </button>
          )}
        </form>
      )}

      {stage.kind === 'recovery-codes' && (
        <section className="stack">
          <h2>{t('mfa.recoveryTitle')}</h2>
          <p>{t('mfa.recoveryText')}</p>
          <ul className="codes">
            {stage.codes.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
          <Button onClick={() => router.replace('/')}>{t('mfa.recoverySaved')}</Button>
        </section>
      )}
    </main>
  );
}
