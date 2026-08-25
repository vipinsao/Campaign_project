import { createHmac, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import * as argon2 from 'argon2';
import type { Clock } from '@campaign/core';
import { ApiError, unauthorized } from '../errors.ts';

/**
 * Operator credentials and session tokens.
 *
 * Passwords are argon2id — memory-hard, so an attacker with the `users` table and
 * a rack of GPUs is bounded by RAM bandwidth rather than by clock speed. The
 * parameters are named here rather than left to the library default so that
 * raising them later is a visible, reviewable change with a migration story,
 * instead of an invisible one that silently invalidates nothing and protects
 * nobody.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB — the OWASP floor for argon2id at t=2, p=1.
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verify a password without letting a malformed hash become an authentication
 * bypass or a 500.
 *
 * argon2.verify throws on a hash it cannot parse — a truncated column, a row
 * imported from a different scheme. Both of those must read as "wrong password",
 * because the alternative is a stack trace on the login endpoint that tells an
 * attacker which accounts have unusual hashes.
 */
export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    return false;
  }
}

export type OperatorClaims = {
  readonly userId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly role: 'owner' | 'operator' | 'viewer';
};

const ISSUER = 'campaign-engine';
const AUDIENCE = 'campaign-engine/api';

/**
 * Mint an operator session token.
 *
 * The tenant is IN the token, and it is the only place a request's tenant comes
 * from. There is no `?tenantId=` override and no "current tenant" held in a
 * session store: an ambient tenant that a handler can forget to apply is the
 * mechanism by which one customer's campaign list appears in another customer's
 * browser.
 */
export async function signOperatorToken(
  claims: OperatorClaims,
  secret: Uint8Array,
  clock: Clock,
  ttlSeconds: number,
): Promise<string> {
  const issuedAt = Math.floor(clock.now().getTime() / 1000);
  return new SignJWT({ tenantId: claims.tenantId, email: claims.email, role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttlSeconds)
    .sign(secret);
}

export async function verifyOperatorToken(
  token: string,
  secret: Uint8Array,
  clock: Clock,
): Promise<OperatorClaims> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
      // Expiry is judged against the injected clock, so a test can mint a token,
      // advance the clock past its lifetime, and assert the rejection — without
      // the suite sleeping for the token lifetime.
      currentDate: clock.now(),
    });

    const tenantId = payload['tenantId'];
    const email = payload['email'];
    const role = payload['role'];
    if (
      typeof payload.sub !== 'string' ||
      typeof tenantId !== 'string' ||
      typeof email !== 'string' ||
      (role !== 'owner' && role !== 'operator' && role !== 'viewer')
    ) {
      throw unauthorized('The session token is missing required claims.');
    }
    return { userId: payload.sub, tenantId, email, role };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw unauthorized('The session token is not valid.', {
      reason: error instanceof Error ? error.name : 'unknown',
    });
  }
}

/**
 * Ingest API keys for `POST /events`.
 *
 * AMBIGUITY DECISION (docs/DECISIONS.md): the schema has no `api_keys` table, and
 * adding one is a migration this package is not allowed to write. So a key is a
 * self-describing HMAC of the tenant id under the server secret:
 *
 *     ce_<tenantId>_<hmac-sha256(tenantId)>
 *
 * That gives verification with no lookup and no ambient tenant — the tenant is
 * carried by the key and checked, not inferred. What it does NOT give is
 * revocation or rotation per key, since every key for a tenant is derived from one
 * server secret. A production deployment needs a real `api_keys` table holding an
 * argon2 hash per key with `revoked_at`; that is a migration, and it is recorded
 * as owed rather than faked here.
 */
const API_KEY_PREFIX = 'ce_';

export function issueApiKey(tenantId: string, secret: Uint8Array): string {
  return `${API_KEY_PREFIX}${tenantId}_${apiKeyMac(tenantId, secret)}`;
}

export function verifyApiKey(key: string, secret: Uint8Array): string | undefined {
  if (!key.startsWith(API_KEY_PREFIX)) return undefined;
  const body = key.slice(API_KEY_PREFIX.length);
  const split = body.lastIndexOf('_');
  if (split <= 0) return undefined;

  const tenantId = body.slice(0, split);
  const provided = Buffer.from(body.slice(split + 1), 'utf8');
  const expected = Buffer.from(apiKeyMac(tenantId, secret), 'utf8');
  // Length has to be equalised before timingSafeEqual, which throws rather than
  // returning false on a mismatch — and a length mismatch is itself a rejection.
  if (provided.length !== expected.length) return undefined;
  return timingSafeEqual(provided, expected) ? tenantId : undefined;
}

function apiKeyMac(tenantId: string, secret: Uint8Array): string {
  return createHmac('sha256', secret).update(`api-key:${tenantId}`).digest('base64url');
}
