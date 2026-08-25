import type { Context } from 'hono';
import type { ApiDeps } from '../deps.ts';
import type { OperatorClaims } from '../auth/tokens.ts';
import { unauthorized } from '../errors.ts';

/**
 * The request-scoped variables, and — more importantly — the shape of the tenant.
 *
 * There is deliberately no `currentTenant()` helper that falls back to a default,
 * no `DEFAULT_TENANT_ID`, and no way to read a tenant from a query parameter. A
 * handler either has an authenticated principal carrying a tenant or it has
 * nothing, and every repository call in this package takes the tenant id as an
 * explicit argument. An ambient tenant is a variable a handler can forget to use,
 * and forgetting it does not fail — it returns somebody else's rows.
 */
export type AuthPrincipal =
  | { readonly kind: 'operator'; readonly tenantId: string; readonly claims: OperatorClaims }
  | { readonly kind: 'api_key'; readonly tenantId: string };

export type AppVariables = {
  requestId: string;
  principal: AuthPrincipal;
};

export type AppEnv = { Variables: AppVariables };

export type AppContext = Context<AppEnv>;

/**
 * The tenant for this request, or a 401.
 *
 * Handlers call this and pass the result down; nothing further in reaches for the
 * context again. That keeps the tenant a parameter of every query rather than a
 * property of the environment the query happens to run in.
 */
export function tenantOf(c: AppContext): string {
  const principal = c.get('principal') as AuthPrincipal | undefined;
  if (principal === undefined) {
    throw unauthorized('This route requires an authenticated principal.');
  }
  return principal.tenantId;
}

export function operatorOf(c: AppContext): OperatorClaims {
  const principal = c.get('principal') as AuthPrincipal | undefined;
  if (principal === undefined || principal.kind !== 'operator') {
    throw unauthorized('This route requires an operator session token.');
  }
  return principal.claims;
}

/** Deps are closed over by the route factories; this is only for middleware that
 *  is registered before the factories run. */
export type WithDeps = { readonly deps: ApiDeps };
