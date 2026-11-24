'use client';

import { api, ApiError, forgetSession, rememberSession, type SessionInfo } from '@mathpath/client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { Captcha } from '../../components/captcha';
import { QrCode } from '../../components/qr-code';
import { Button, ErrorText, Field } from '../../components/ui';
import { errorMessage } from '../../lib/editor';
import { t } from '../../lib/i18n';
import { otpauthSecret } from '../../lib/mfa';

const STAFF = ['author', 'reviewer', 'admin'];

type Stage =
  | { kind: 'password' }
  | { kind: 'code' }
  | { kind: 'enrol'; factorId: string; otpauthUri: string }
  | { kind: 'recovery-codes'; codes: string[] }
  | { kind: 'awaiting-role' };

/**
 * Staff sign-in (security plan C-08): phone and password, then TOTP. A staff
 * member without an authenticator yet is enrolled here, and sees their
 * recovery codes once.
 *
 * A staff role is only granted to an account that already has 2FA, so a
 * person who is about to become staff signs in here first: without a staff
 * role they are offered the same enrolment and then told to ask an admin.
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
  // Signed in without a staff role: enrolling 2FA so an admin can grant one.
  const [awaitingRole, setAwaitingRole] = useState(false);

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

  // The session has no staff role, so nothing in the studio is open to it.
  const signOut = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    forgetSession();
    setAwaitingRole(false);
    setPassword('');
    setCode('');
    setStage({ kind: 'password' });
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
      const staff = session.roles.some((r) => STAFF.includes(r));
      if (staff && !session.mfaRequired) return finish(session);
      // Has an authenticator already? Enrolment refuses with MFA_REQUIRED if so.
      try {
        const enrolment = await api<{ factorId: string; otpauthUri: string }>('/auth/mfa/totp', {
          method: 'POST',
        });
        setAwaitingRole(!staff);
        setStage({ kind: 'enrol', ...enrolment });
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'MFA_REQUIRED')) throw e;
        if (staff) setStage({ kind: 'code' });
        // 2FA is on but no role yet: nothing to do here until an admin grants one.
        else setStage({ kind: 'awaiting-role' });
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
      else if (awaitingRole) setStage({ kind: 'awaiting-role' });
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
          <Link className="link" href="/reset-password">
            {t('login.forgot')}
          </Link>
        </form>
      )}

      {stage.kind === 'enrol' && (
        <section className="stack">
          <h2>{t('mfa.enrolTitle')}</h2>
          <p>{t('mfa.enrolSteps')}</p>
          <QrCode value={stage.otpauthUri} label={t('mfa.qrAlt')} />
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
          <Button
            onClick={() =>
              awaitingRole ? setStage({ kind: 'awaiting-role' }) : router.replace('/')
            }
          >
            {t('mfa.recoverySaved')}
          </Button>
        </section>
      )}

      {stage.kind === 'awaiting-role' && (
        <section className="stack" role="status">
          <h2>{t('login.awaitingRoleTitle')}</h2>
          <p>{t('login.awaitingRoleText')}</p>
          <Button onClick={() => void signOut()}>{t('login.signOut')}</Button>
        </section>
      )}
    </main>
  );
}
