import type { MiddlewareHandler } from 'hono';

/**
 * The public demo: an operator console anybody can open, without a login.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY
 *
 * The deployment linked from a CV is judged by people who will not ask for a
 * password. A login screen in front of the console means the console is never
 * seen. So a deployment with `PUBLIC_DEMO=true` hands out an operator session for
 * the seeded demo tenant to whoever asks (`POST /auth/demo`), and the SPA asks on
 * its own.
 *
 * WHAT THAT WOULD OTHERWISE EXPOSE, AND WHAT THIS FILE DOES ABOUT IT
 *
 * The seeded data is fictional — `@example.com` addresses, `+1500555` numbers —
 * but the public storefront writes real people into the same tenant: the visitor
 * who placed an order five minutes ago left their real email, perhaps their real
 * phone number, and the consent ledger recorded their IP address and browser as
 * evidence. Handing that to the next anonymous visitor would be a data leak with
 * a UI on it.
 *
 * So every operator response on a public-demo deployment passes through
 * `redactForPublicDemo` on the way out:
 *
 *   - email addresses are masked to their first character and domain, unless the
 *     domain is reserved for documentation (example.com and friends, RFC 2606);
 *   - E.164 phone numbers keep their first and last three digits, unless they are
 *     in the reserved `+1500555` test range the seed uses;
 *   - IP addresses and user agents in consent evidence are masked outright.
 *
 * It runs on the RESPONSE, after the handler, rather than in each route. A
 * redaction applied per route is the one the forty-first route forgets; this one
 * covers routes that do not exist yet. The trade is that it pattern-matches
 * strings, so it masks an address wherever it appears — including inside a
 * rendered message body — which is the direction a mistake should run in.
 *
 * Writes are deliberately NOT restricted: the person running this demo chose a
 * console where visitors can create and change campaigns. The two writes that
 * would turn that into a spam relay are closed elsewhere — the storefront only
 * sends its own locked campaign (migrations/0012, `assertNotStorefront`) — and the
 * nightly reset puts everything else back.
 */

export function publicDemoEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = (env['PUBLIC_DEMO'] ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

// RFC 2606 / RFC 6761 names: nobody receives mail there, so nothing to protect.
const RESERVED_EMAIL_DOMAIN = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/i;

// The seed's numbers live in the +1 500 555 xxxx range Twilio reserves for tests.
const RESERVED_PHONE = /^\+1500555\d{4}$/;

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const PHONE = /\+[1-9]\d{6,14}\b/g;

/** Keys whose values identify a person's network or device, wherever they occur. */
const DEVICE_KEYS = new Set(['ip', 'ipaddress', 'ip_address', 'useragent', 'user_agent']);

function maskEmail(address: string, domain: string): string {
  if (RESERVED_EMAIL_DOMAIN.test(domain)) return address;
  const local = address.slice(0, address.length - domain.length - 1);
  return `${local.slice(0, 1)}•••@${domain}`;
}

function maskPhone(phone: string): string {
  if (RESERVED_PHONE.test(phone)) return phone;
  return `${phone.slice(0, 3)}${'•'.repeat(Math.max(1, phone.length - 6))}${phone.slice(-3)}`;
}

export function redactString(value: string): string {
  return value
    .replace(EMAIL, (match: string, domain: string) => maskEmail(match, domain))
    .replace(PHONE, (match: string) => maskPhone(match));
}

export function redactForPublicDemo(value: unknown, key?: string): unknown {
  if (key !== undefined && DEVICE_KEYS.has(key.toLowerCase())) {
    return value === null || value === undefined ? value : 'hidden in the public demo';
  }
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactForPublicDemo(item));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactForPublicDemo(v, k);
    }
    return out;
  }
  return value;
}

/**
 * Applied after the operator guard on every operator route prefix. A no-op unless
 * the deployment is a public demo, so tests and real deployments see raw data.
 */
export function redactPublicDemoResponses(env: NodeJS.ProcessEnv): MiddlewareHandler {
  const enabled = publicDemoEnabled(env);
  return async (c, next) => {
    await next();
    if (!enabled) return;
    const type = c.res.headers.get('content-type') ?? '';
    if (!type.includes('application/json')) return;

    const body: unknown = await c.res.clone().json();
    const headers = new Headers(c.res.headers);
    headers.delete('content-length');
    c.res = new Response(JSON.stringify(redactForPublicDemo(body)), {
      status: c.res.status,
      headers,
    });
  };
}
