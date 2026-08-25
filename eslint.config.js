// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
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
export default defineConfig(
  { ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**'] },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // allowDefaultProject covers the build-config files, which deliberately
        // sit outside the application tsconfig: widening that tsconfig to reach
        // them would weaken the type-check gate this config exists to enforce.
        projectService: {
          allowDefaultProject: [
            'eslint.config.js',
            'vitest.config.ts',
            '*.config.ts',
            'scripts/dev.mjs',
            'scripts/smoke.mjs',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
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
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            // The domain depends on nothing but shared types. This is the whole point.
            {
              from: [{ element: { type: 'shared' } }],
              allow: [{ to: { element: { type: 'shared' } } }],
            },
            {
              from: [{ element: { type: 'core' } }],
              allow: [
                { to: { element: { type: 'shared' } } },
                { to: { element: { type: 'core' } } },
              ],
            },
            {
              from: [{ element: { type: 'providers' } }],
              allow: [
                { to: { element: { type: 'shared' } } },
                { to: { element: { type: 'providers' } } },
              ],
            },
            {
              from: [{ element: { type: 'triage' } }],
              allow: [
                { to: { element: { type: 'shared' } } },
                { to: { element: { type: 'triage' } } },
                { to: { element: { type: 'core' } } },
              ],
            },
            // Edges compose the domain with the outside world.
            {
              from: [{ element: { type: 'api' } }],
              allow: [
                { to: { element: { type: 'shared' } } },
                { to: { element: { type: 'core' } } },
                { to: { element: { type: 'providers' } } },
                { to: { element: { type: 'triage' } } },
                { to: { element: { type: 'api' } } },
              ],
            },
            {
              from: [{ element: { type: 'worker' } }],
              allow: [
                { to: { element: { type: 'shared' } } },
                { to: { element: { type: 'core' } } },
                { to: { element: { type: 'providers' } } },
                { to: { element: { type: 'triage' } } },
                { to: { element: { type: 'worker' } } },
              ],
            },
            {
              from: [{ element: { type: 'scripts' } }],
              allow: [
                { to: { element: { type: 'shared' } } },
                { to: { element: { type: 'core' } } },
                { to: { element: { type: 'providers' } } },
                { to: { element: { type: 'triage' } } },
                { to: { element: { type: 'api' } } },
                { to: { element: { type: 'worker' } } },
              ],
            },
            // The test harness deliberately runs the PRODUCT's migration runner
            // rather than a copy of it, so a migration that breaks in CI breaks
            // the same way it would break on deploy.
            {
              from: [{ element: { type: 'tests' } }],
              allow: [
                { to: { element: { type: 'shared' } } },
                { to: { element: { type: 'core' } } },
                { to: { element: { type: 'providers' } } },
                { to: { element: { type: 'triage' } } },
                { to: { element: { type: 'api' } } },
                { to: { element: { type: 'worker' } } },
                { to: { element: { type: 'scripts' } } },
              ],
            },
          ],
        },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      // `type` over `interface` throughout, deliberately: interfaces merge across
      // declarations, and a domain vocabulary that can be silently extended from
      // another file is harder to reason about than one that cannot.
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
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
            { name: 'hono', message: 'core is transport-agnostic.' },
            { name: 'express', message: 'core is transport-agnostic.' },
            {
              name: '@anthropic-ai/sdk',
              message: 'The model client lives in packages/triage only.',
            },
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

  // Plain-JS launcher scripts. Linted for real mistakes but not type-linted: they
  // sit outside the application tsconfig deliberately, and widening that tsconfig
  // to reach them would weaken the type-check gate everything else depends on.
  {
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
    rules: { ...tseslint.configs.disableTypeChecked.rules, 'no-console': 'off' },
  },

  // The operator UI. typescript-eslint's project service picks up
  // packages/web/tsconfig.json automatically, so this is genuinely type-aware
  // rather than a syntax-only pass. It was previously ignored entirely, which
  // meant the surface a reviewer actually clicks had no lint gate at all.
  {
    files: ['packages/web/**/*.{ts,tsx}'],
    rules: {
      'boundaries/dependencies': 'off',
      // Off HERE and nowhere else, and the reason matters.
      //
      // `no-unnecessary-condition` trusts the declared types. Inside packages/
      // that trust is earned, because those types describe values the process
      // constructed. In the web app the types describe JSON that arrived over a
      // network and are asserted rather than validated, so a defensive `?? ` on a
      // field the type calls non-nullable is CORRECT - the type is a hope.
      //
      // The right fix is to parse responses with zod at the client boundary, the
      // way the server parses requests, at which point the types become facts and
      // this rule can go back on. That is owed work, recorded in TRACKER.md rather
      // than papered over here.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // Allows the `const { [key]: _discard, ...rest }` idiom for removing a key
      // without a dynamic delete.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // A React event handler returning a promise is the normal shape, and the
      // rule's default flags every one of them.
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },

  {
    files: ['tests/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
      // In a test, `rows[0]!.id` is the correct assertion: if the row is missing,
      // the test SHOULD throw loudly at that line rather than be written to
      // tolerate it. In packages/ the rule stays on, and there are no violations
      // there - which is the part that matters.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
