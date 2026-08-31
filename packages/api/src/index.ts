/**
 * The API process.
 *
 * The FIRST import is the scheduler guard, and its position is load-bearing rather
 * than stylistic. ES modules evaluate their dependencies in source order, fully,
 * before the importing module's own body runs — so the trap has to be armed by the
 * act of importing it, and that import has to come first. A call to
 * `armSchedulerTrap()` written as the first STATEMENT of this file would run after
 * every other module in the graph had already been evaluated, which is after a
 * module-scope `cron.schedule(...)` would have fired. See no-scheduler.ts for what
 * the trap is and why a comment saying "do not add a scheduler here" is not a
 * control.
 */
import { assertNoSchedulerRegistered } from './no-scheduler.ts';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { createServerApp, defaultWebRoot } from './server.ts';
import { buildDeps } from './deps.ts';
import { buildRegistry } from './observability/metrics.ts';
import { migrate } from '@campaign/core';

/**
 * The boot-time refusal to schedule.
 *
 * Evaluated at module scope, so it runs whether the process was started as a
 * server or the package was imported by a test. Three API replicas means every
 * scheduled job fires three times: the queue drain claims three batches, the
 * suppression-expiry sweep runs three times a night, and the duplicate work is
 * invisible because nothing errors. Schedulers live in packages/worker, which runs
 * as a single instance for exactly this reason.
 */
assertNoSchedulerRegistered();

export { createApp, type App, type CreateAppOptions } from './app.ts';
export { createServerApp, defaultWebRoot, type ServerAppOptions } from './server.ts';
export {
  buildDeps,
  decodeEncryptionKey,
  DEFAULT_RATE_LIMIT,
  type ApiDeps,
  type DepsOverrides,
  type RateLimitConfig,
} from './deps.ts';
export { ApiError, renderError, type ErrorEnvelope, type ErrorStatus } from './errors.ts';
export {
  hashPassword,
  verifyPassword,
  signOperatorToken,
  verifyOperatorToken,
  issueApiKey,
  verifyApiKey,
  type OperatorClaims,
} from './auth/tokens.ts';
export { sealSecret, openSecret, type SealedSecret } from './auth/secrets.ts';
export {
  renderCampaignMessage,
  mergeFieldCatalogue,
  type PreviewResult,
} from './services/preview.ts';
export {
  mintUnsubscribeToken,
  unsubscribeUrl,
  resolveUnsubscribeToken,
} from './services/unsubscribe.ts';
export { validateForActivation, snapshotCampaign } from './services/campaigns.ts';
export { ingestWebhook, type WebhookOutcome } from './routes/webhooks.ts';
export { openIdempotencyKey } from './routes/public.ts';
export {
  armSchedulerTrap,
  disarmSchedulerTrap,
  assertNoSchedulerRegistered,
  schedulerCensus,
} from './no-scheduler.ts';

export function startServer(): { close: () => void } {
  const deps = buildDeps({ metrics: buildRegistry({ defaultMetrics: true }) });
  const app = createApp(deps);

  // Asserted again after the whole route graph has been constructed. A route
  // module that registers a timer when it is wired, rather than when it is
  // imported, would slip past the module-scope check above.
  assertNoSchedulerRegistered();

  const webRoot = defaultWebRoot();
  const root = createServerApp(app, { webRoot });

  const port = Number(process.env['PORT'] ?? 3001);
  const server = serve({ fetch: root.fetch, port });
  deps.logger.info({ port, webRoot: webRoot ?? '(api only)' }, 'campaign-engine api listening');
  return {
    close: () => {
      server.close();
    },
  };
}

/**
 * Boot: migrate, then serve.
 *
 * Nothing ran the migrations on a deploy. `render.yaml` had no migrate step and
 * this file only ever started a server, so a fresh database came up with no tables
 * and every request 500'd. Running them here makes the schema a precondition of
 * the process rather than a step somebody remembers.
 *
 * `migrate()` takes a Postgres advisory lock, so the API and the worker booting
 * together serialise instead of racing. Set MIGRATE_ON_BOOT=false where a
 * deployment applies migrations out of band.
 */
async function boot(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (process.env['MIGRATE_ON_BOOT'] !== 'false' && url !== undefined && url !== '') {
    await migrate(url, { silent: true });
  }
  startServer();
}

// Only when run directly. Importing this module — which the test suite does, to
// get `createApp` — must never bind a port.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await boot();
}
