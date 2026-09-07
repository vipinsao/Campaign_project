/**
 * Fail loudly at boot, never mysteriously at 3am on the first send.
 *
 * A missing PUBLIC_BASE_URL does not break anything until the first unsubscribe
 * link is generated, at which point it has been baked into every message already
 * delivered. Config problems should surface at startup, where somebody is watching.
 */
const REQUIRED = ['DATABASE_URL'] as const;

const CONDITIONAL: { key: string; when: () => boolean; why: string }[] = [
  {
    key: 'JWT_SECRET',
    when: () => process.env['NODE_ENV'] === 'production',
    why: 'the API signs session tokens with it',
  },
  {
    key: 'PUBLIC_BASE_URL',
    when: () => process.env['SEND_MODE'] !== 'off',
    why: 'unsubscribe and tracking URLs are built from it, and a wrong value ships broken links',
  },
  {
    key: 'ANTHROPIC_API_KEY',
    when: () => process.env['FEATURE_AI'] === 'true',
    why: 'the AI layer is enabled',
  },
];

const missing: string[] = [];
for (const key of REQUIRED) {
  if (!process.env[key]) missing.push(`${key} is required`);
}
for (const { key, when, why } of CONDITIONAL) {
  if (when() && !process.env[key]) missing.push(`${key} is required because ${why}`);
}

/**
 * Advisory, not fatal — and the distinction is the point.
 *
 * A live deployment with no sender in the environment is *probably* broken, but it
 * is not certainly broken: `provider_credentials` is the real source of a sending
 * identity, it is per tenant, and this script has no database connection with
 * which to check it. Refusing to boot on a guess would break the correct
 * configuration to catch the common one.
 *
 * So it warns, and it names the variables. The silent version of this failure is
 * every message cancelled with `no_recipient_address` — a reason code that is true
 * and completely useless when the operator believes they configured a sender.
 */
const advice: string[] = [];
if (process.env['SEND_MODE'] === 'live') {
  const set = (name: string): boolean => (process.env[name] ?? '').trim() !== '';
  const email =
    (set('SMTP_HOST') && set('SMTP_FROM')) ||
    (set('POSTMARK_SERVER_TOKEN') && set('POSTMARK_FROM'));
  const sms = set('TWILIO_ACCOUNT_SID') && set('TWILIO_AUTH_TOKEN') && set('TWILIO_FROM');

  if (!email) {
    advice.push(
      'SEND_MODE=live but no email sender in the environment. Set SMTP_HOST + SMTP_FROM ' +
        '(plus SMTP_USER/SMTP_PASS), or POSTMARK_SERVER_TOKEN + POSTMARK_FROM — unless every ' +
        'tenant has an active provider_credentials row. See docs/LIVE-SENDING.md.',
    );
  }
  if (!sms) {
    advice.push(
      'SEND_MODE=live but no SMS sender in the environment. Set TWILIO_ACCOUNT_SID, ' +
        'TWILIO_AUTH_TOKEN and TWILIO_FROM. SMS is optional: without it, SMS messages are ' +
        'cancelled with no_recipient_address and the reason is recorded.',
    );
  }
  if (
    (process.env['TWILIO_FROM'] ?? '').startsWith('whatsapp:') &&
    !set('TWILIO_WHATSAPP_JOIN_CODE')
  ) {
    advice.push(
      'TWILIO_FROM is a WhatsApp sandbox number but TWILIO_WHATSAPP_JOIN_CODE is unset, so ' +
        'the storefront cannot tell a visitor how to opt in. Every send to a number that has ' +
        'not joined will be rejected with 63016.',
    );
  }
}

if (missing.length > 0) {
  console.error('Refusing to start:\n' + missing.map((m) => `  - ${m}`).join('\n'));
  console.error('\nSee .env.example; every variable there is documented.');
  process.exit(1);
}
for (const line of advice) console.warn(`  ! ${line}`);
console.log('Environment looks complete.');
