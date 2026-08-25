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

if (missing.length > 0) {
  console.error('Refusing to start:\n' + missing.map((m) => `  - ${m}`).join('\n'));
  console.error('\nSee .env.example; every variable there is documented.');
  process.exit(1);
}
console.log('Environment looks complete.');
