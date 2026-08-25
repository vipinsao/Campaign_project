// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';

/**
 * Two things in this file are load-bearing and are the reason it is worth reading:
 *
 *  1. The `boundaries` element types below make the dependency rules from
 *     docs/ARCHITECTURE.md executable. `core` is the domain; if it can reach for
 *     express, a provider SDK or the Anthropic client, then it is not a domain
 *     any more and it cannot be tested without a network.
 *
 *  2. `no-restricted-syntax` bans `new Date()` and `Date.now()` inside `core`.
 *     Every time-dependent decision in this system goes through an injected
 *     `Clock`. That is what makes "three days after the order is delivered"
 *     assertable in milliseconds instead of three days.
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**', 'packages/web/**'] },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { boundaries },
    settings: {
      'boundaries/include': ['packages/**/*.ts', 'scripts/**/*.ts', 'tests/**/*.ts'],
      'boundaries/elements': [
        { type: 'shared', pattern: 'packages/shared/src/**' },
        { type: 'core', pattern: 'packages/core/src/**' },
        { type: 'providers', pattern: 'packages/providers/src/**' },
        { type: 'triage', pattern: 'packages/triage/src/**' },
        { type: 'api', pattern: 'packages/api/src/**' },
        { type: 'worker', pattern: 'packages/worker/src/**' },
        { type: 'scripts', pattern: 'scripts/**' },
        { type: 'tests', pattern: 'tests/**' },
      ],
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            // The domain depends on nothing but shared types. This is the whole point.
            { from: 'shared', allow: ['shared'] },
            { from: 'core', allow: ['shared', 'core'] },
            { from: 'providers', allow: ['shared', 'providers'] },
            { from: 'triage', allow: ['shared', 'triage', 'core'] },
            // Edges compose the domain with the outside world.
            { from: 'api', allow: ['shared', 'core', 'providers', 'triage', 'api'] },
            { from: 'worker', allow: ['shared', 'core', 'providers', 'triage', 'worker'] },
            { from: 'scripts', allow: ['shared', 'core', 'providers', 'triage', 'api', 'worker'] },
            { from: 'tests', allow: ['shared', 'core', 'providers', 'triage', 'api', 'worker'] },
          ],
        },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // ── The injectable-clock rule (I5, and the reason the demo can fast-forward) ──
  {
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'core must not read the wall clock. Take a Clock and call clock.now(). ' +
            'See docs/ADR-004-injectable-clock.md.',
        },
        {
          selector: "MemberExpression[object.name='Date'][property.name='now']",
          message:
            'core must not read the wall clock. Take a Clock and call clock.now(). ' +
            'See docs/ADR-004-injectable-clock.md.',
        },
      ],
      // A provider SDK inside the domain would make the domain untestable offline.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'nodemailer', message: 'Vendor SDKs live in packages/providers only.' },
            { name: 'postmark', message: 'Vendor SDKs live in packages/providers only.' },
            { name: 'twilio', message: 'Vendor SDKs live in packages/providers only.' },
            { name: 'express', message: 'core is transport-agnostic.' },
            { name: '@anthropic-ai/sdk', message: 'The model client lives in packages/triage only.' },
          ],
        },
      ],
    },
  },

  // The API process is structurally forbidden from scheduling. See docs/ARCHITECTURE.md.
  {
    files: ['packages/api/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node-cron',
              message:
                'Schedulers belong to the worker process. Three API replicas means every ' +
                'job fires three times. See packages/worker/src/index.ts.',
            },
          ],
        },
      ],
    },
  },

  { files: ['tests/**/*.ts', 'scripts/**/*.ts'], rules: { 'no-console': 'off' } },
);
