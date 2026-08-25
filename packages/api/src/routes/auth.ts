import { Hono } from 'hono';
import { z } from 'zod';
import { query } from '@campaign/core';
import type { ApiDeps } from '../deps.ts';
import type { AppEnv } from '../middleware/context.ts';
import { operatorOf } from '../middleware/context.ts';
import { conflict, unauthorized } from '../errors.ts';
import { hashPassword, signOperatorToken, verifyPassword } from '../auth/tokens.ts';

const LoginBody = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
  /**
   * Optional, and only a disambiguator.
   *
   * One person can hold operator accounts in several tenants under the same
   * address — an agency managing three brands is the ordinary case. The pair
   * (tenant, email) is what `users` is unique on, so email alone can match more
   * than one row, and picking the first would silently sign somebody into the
   * wrong brand's campaigns.
   */
  tenantId: z.uuid().optional(),
});

/**
 * A single, deliberately vague rejection.
 *
 * "No such account" and "wrong password" are different sentences that tell an
 * attacker which addresses are worth attacking. They are also, in a multi-tenant
 * product, a way to enumerate which brands a given person works for.
 */
const REJECTION = 'Those credentials are not valid.';

type UserRow = {
  readonly id: string;
  readonly tenant_id: string;
  readonly email: string;
  readonly password_hash: string;
  readonly role: 'owner' | 'operator' | 'viewer';
};

/**
 * A hash to verify against when no user matched.
 *
 * Without it, a request for an address that does not exist returns in a
 * microsecond and a request for one that does takes the ~50ms argon2id costs. That
 * difference is trivially measurable over the network and turns the deliberately
 * vague rejection above back into an account-enumeration oracle. Verifying against
 * a real hash spends the same time on both paths.
 */
let decoyHash: Promise<string> | undefined;
function decoy(): Promise<string> {
  decoyHash ??= hashPassword('argon2-timing-decoy-not-a-credential');
  return decoyHash;
}

export function authRoutes(deps: ApiDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/auth/login', async (c) => {
    const body = LoginBody.parse(await c.req.json<unknown>());

    const candidates = await query<UserRow>(
      deps.db,
      `SELECT id, tenant_id, email::text AS email, password_hash, role
         FROM users
        WHERE email = $1::citext AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
        ORDER BY created_at`,
      [body.email, body.tenantId ?? null],
    );

    if (candidates.length === 0) {
      await verifyPassword(await decoy(), body.password);
      throw unauthorized(REJECTION);
    }

    const matched: UserRow[] = [];
    for (const candidate of candidates) {
      if (await verifyPassword(candidate.password_hash, body.password)) matched.push(candidate);
    }

    if (matched.length === 0) throw unauthorized(REJECTION);

    // Same address, same password, two tenants — an agency's operator with
    // accounts on two brands. Signing them into whichever row sorted first is the
    // I13 mistake in a different costume: an ambiguous identifier resolved
    // silently. The candidate tenants are safe to name here because the password
    // has already been verified against every one of them.
    if (matched.length > 1) {
      throw conflict(
        'ambiguous_account',
        'That address and password match an account in more than one tenant. ' +
          'Repeat the request with `tenantId` to say which one.',
        {
          candidates: matched.map((u) => ({ tenantId: u.tenant_id, userId: u.id, role: u.role })),
        },
      );
    }

    const user = matched[0];
    if (user === undefined) throw unauthorized(REJECTION);

    const token = await signOperatorToken(
      { userId: user.id, tenantId: user.tenant_id, email: user.email, role: user.role },
      deps.jwtSecret,
      deps.clock,
      deps.tokenTtlSeconds,
    );

    return c.json({
      token,
      expiresIn: deps.tokenTtlSeconds,
      user: { id: user.id, email: user.email, role: user.role, tenantId: user.tenant_id },
    });
  });

  return app;
}

/** Whoami, mounted behind the operator guard. Cheap, and the first thing a client
 *  integrating against this API reaches for to check its token wiring. */
export function sessionRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/auth/me', (c) => {
    const claims = operatorOf(c);
    return c.json({
      user: {
        id: claims.userId,
        email: claims.email,
        role: claims.role,
        tenantId: claims.tenantId,
      },
    });
  });
  return app;
}
