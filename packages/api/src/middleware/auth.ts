import type { MiddlewareHandler } from 'hono';
import { queryOne } from '@campaign/core';
import type { ApiDeps } from '../deps.ts';
import { unauthorized } from '../errors.ts';
import { verifyApiKey, verifyOperatorToken } from '../auth/tokens.ts';
import type { AppEnv } from './context.ts';

function bearer(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return undefined;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : undefined;
}

/**
 * Operator authentication.
 *
 * The tenant is read from the verified token and then CHECKED AGAINST THE
 * DATABASE. Verifying the signature proves the token was minted here; it does not
 * prove the user still exists, still belongs to that tenant, or was not moved
 * between tenants after the token was issued. A token outlives the fact it
 * asserts, and a twelve-hour window in which a removed operator can still read a
 * tenant's campaigns is a window that will eventually be used.
 */
export function requireOperator(deps: ApiDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = bearer(c.req.header('authorization'));
    if (token === undefined) {
      throw unauthorized('Send an operator session token as `Authorization: Bearer <token>`.');
    }

    const claims = await verifyOperatorToken(token, deps.jwtSecret, deps.clock);

    const user = await queryOne<{ id: string; tenant_id: string; role: string }>(
      deps.db,
      `SELECT id, tenant_id, role FROM users WHERE id = $1 AND tenant_id = $2`,
      [claims.userId, claims.tenantId],
    );
    if (user === undefined) {
      throw unauthorized('The account on this token no longer exists in that tenant.', {
        userId: claims.userId,
      });
    }

    c.set('principal', { kind: 'operator', tenantId: user.tenant_id, claims });
    await next();
  };
}

/**
 * API-key authentication, for `POST /events` only.
 *
 * Event ingest is machine-to-machine: a storefront posts an order event from a
 * server-side hook and has no session to renew. Giving it a JWT would mean either
 * a very long-lived JWT — which is an API key wearing a costume, without the
 * revocation story — or a refresh flow that every integrator implements slightly
 * wrong.
 *
 * The key names its tenant and is verified, never trusted; see issueApiKey.
 */
export function requireApiKey(deps: ApiDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const presented = c.req.header('x-api-key') ?? bearer(c.req.header('authorization'));
    if (presented === undefined) {
      throw unauthorized('Send an ingest key as the `x-api-key` header.');
    }

    const tenantId = verifyApiKey(presented, deps.jwtSecret);
    if (tenantId === undefined) {
      throw unauthorized('That ingest key is not valid.');
    }

    // The key is self-describing, so a tenant deleted since the key was minted
    // would otherwise pass authentication and then fail on a foreign key three
    // statements into the handler, as a 500.
    const tenant = await queryOne<{ id: string }>(deps.db, `SELECT id FROM tenants WHERE id = $1`, [
      tenantId,
    ]);
    if (tenant === undefined) {
      throw unauthorized('That ingest key names a tenant that no longer exists.');
    }

    c.set('principal', { kind: 'api_key', tenantId: tenant.id });
    await next();
  };
}
