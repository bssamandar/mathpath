/**
 * Signed tokens (ADR-0005, C-06).
 *
 * Access tokens, registration tickets and password-reset tickets are all
 * EdDSA JWTs, but with different audiences, so one can never be used in place of the other.
 */
import type { Role } from '@mathpath/db';
import { type JWTPayload, jwtVerify, SignJWT } from 'jose';
import type { Clock } from '../common/clock';
import type { AuthKeys } from './keys';

const ISSUER = 'mathpath-api';
const ACCESS_AUDIENCE = 'mathpath';
const REGISTRATION_AUDIENCE = 'mathpath-registration';
const PASSWORD_RESET_AUDIENCE = 'mathpath-password-reset';

/** Verified claims of an access token. */
export interface AccessClaims {
  userId: string;
  sessionId: string;
  roles: Role[];
  /** False for staff until they pass TOTP 2FA (C-08). */
  mfaVerified: boolean;
}

/** A signed token and when it stops being valid. */
export interface SignedToken {
  token: string;
  expiresAt: Date;
}

export class TokenService {
  constructor(
    private readonly keys: AuthKeys,
    private readonly clock: Clock,
    private readonly ttl: { accessTokenTtlMinutes: number; registrationTokenTtlMinutes: number },
  ) {}

  /** Signs a 15-minute access token for a session. */
  async signAccess(claims: AccessClaims): Promise<SignedToken> {
    return this.sign(
      { sid: claims.sessionId, roles: claims.roles, mfa: claims.mfaVerified },
      claims.userId,
      ACCESS_AUDIENCE,
      this.ttl.accessTokenTtlMinutes,
    );
  }

  /** @returns The claims, or null if the token is invalid, expired or not an access token. */
  async verifyAccess(token: string): Promise<AccessClaims | null> {
    const payload = await this.verify(token, ACCESS_AUDIENCE);
    if (!payload || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
    return {
      userId: payload.sub,
      sessionId: payload.sid,
      roles: Array.isArray(payload.roles) ? (payload.roles as Role[]) : [],
      mfaVerified: payload.mfa === true,
    };
  }

  /**
   * Signs the ticket that proves a phone was verified for sign-up. It carries
   * the phone number, so /auth/register cannot be called for a number the
   * caller did not verify.
   */
  async signRegistration(phone: string, challengeId: string): Promise<SignedToken> {
    return this.sign(
      { jti: challengeId },
      phone,
      REGISTRATION_AUDIENCE,
      this.ttl.registrationTokenTtlMinutes,
    );
  }

  /** @returns The verified phone number, or null. */
  async verifyRegistration(token: string): Promise<string | null> {
    const payload = await this.verify(token, REGISTRATION_AUDIENCE);
    return typeof payload?.sub === 'string' ? payload.sub : null;
  }

  /**
   * Signs the ticket that proves a phone was verified for a password reset.
   * `pwv` fingerprints the current password hash, so the ticket stops working
   * as soon as the password changes: it can be used once.
   */
  async signPasswordReset(
    userId: string,
    challengeId: string,
    passwordVersion: string,
  ): Promise<SignedToken> {
    return this.sign(
      { jti: challengeId, pwv: passwordVersion },
      userId,
      PASSWORD_RESET_AUDIENCE,
      this.ttl.registrationTokenTtlMinutes,
    );
  }

  /** @returns The user ID and password fingerprint the ticket was issued for, or null. */
  async verifyPasswordReset(
    token: string,
  ): Promise<{ userId: string; passwordVersion: string } | null> {
    const payload = await this.verify(token, PASSWORD_RESET_AUDIENCE);
    return typeof payload?.sub === 'string' && typeof payload.pwv === 'string'
      ? { userId: payload.sub, passwordVersion: payload.pwv }
      : null;
  }

  private async sign(
    claims: JWTPayload,
    subject: string,
    audience: string,
    ttlMinutes: number,
  ): Promise<SignedToken> {
    const now = Math.floor(this.clock.now().getTime() / 1000);
    const exp = now + ttlMinutes * 60;
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', kid: this.keys.keyId, typ: 'JWT' })
      .setIssuer(ISSUER)
      .setAudience(audience)
      .setSubject(subject)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .sign(this.keys.signingKey);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  private async verify(token: string, audience: string): Promise<JWTPayload | null> {
    try {
      const { payload } = await jwtVerify(
        token,
        (header) => {
          // `kid` is required and must be one of ours (C-06); the algorithm is
          // pinned below, so a token cannot choose a weaker one ("alg: none").
          const key = this.keys.verificationKey(header.kid);
          if (!key) throw new Error('unknown key');
          return key;
        },
        { algorithms: ['EdDSA'], issuer: ISSUER, audience, currentDate: this.clock.now() },
      );
      return payload;
    } catch {
      return null;
    }
  }
}
