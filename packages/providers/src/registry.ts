import type { Channel, MessageProvider } from '@campaign/shared';
import type { Clock, Db, Rng } from './deps.ts';
import { MockEmailProvider, MockSmsProvider } from './mock/mock-provider.ts';
import type { MockProviderOptions } from './mock/mock-provider.ts';
import { PostmarkProvider, postmarkConfigFromEnv } from './postmark.ts';
import { SmtpProvider, smtpConfigFromEnv } from './smtp.ts';
import { TwilioProvider, twilioConfigFromEnv } from './twilio.ts';

/**
 * The one place a provider name becomes a provider.
 *
 * `provider_credentials.provider` is constrained to this exact set by a CHECK, so
 * the closed union below is the same closed set the database enforces, and adding
 * a provider requires touching both. That is deliberate friction: a provider the
 * schema does not know about would write rows nothing can classify.
 *
 * Configuration is read lazily, when a provider is actually resolved. That is what
 * keeps the demo credential-free -- resolving `mock` never touches SMTP_HOST, so a
 * clean clone runs the entire lifecycle with an empty environment.
 */

export const PROVIDER_NAMES = ['mock', 'smtp', 'postmark', 'twilio'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

export type ProviderDeps = {
  readonly db: Db;
  readonly clock: Clock;
  readonly rng?: Rng | undefined;
  /** Defaulted so tests can pass a stub environment instead of mutating process.env. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Simulation knobs for the mock providers; ignored by the real ones. */
  readonly mock?: Omit<MockProviderOptions, 'db' | 'clock' | 'rng'> | undefined;
  /** Injectable for tests that stand up a local HTTP server instead of a network. */
  readonly fetchImpl?: typeof fetch | undefined;
};

/**
 * Which providers can carry which channel.
 *
 * A mis-paired provider is a configuration mistake that would otherwise surface as
 * an unexplained delivery failure at an inconvenient hour: an SMS handed to an
 * SMTP transport does not fail loudly, it fails as a rejected envelope with a code
 * nobody connects to the real cause.
 */
const CHANNELS: Readonly<Record<ProviderName, readonly Channel[]>> = {
  mock: ['email', 'sms'],
  smtp: ['email'],
  postmark: ['email'],
  twilio: ['sms'],
};

export function resolveProvider(
  channel: Channel,
  providerName: string,
  deps: ProviderDeps,
): MessageProvider {
  if (!isProviderName(providerName)) {
    throw new Error(
      `Unknown provider '${providerName}'. Known providers: ${PROVIDER_NAMES.join(', ')}.`,
    );
  }
  if (!CHANNELS[providerName].includes(channel)) {
    throw new Error(
      `Provider '${providerName}' cannot carry the ${channel} channel ` +
        `(it supports: ${CHANNELS[providerName].join(', ')}).`,
    );
  }

  const env = deps.env ?? process.env;

  switch (providerName) {
    case 'mock': {
      const options: MockProviderOptions = {
        ...deps.mock,
        db: deps.db,
        clock: deps.clock,
        ...(deps.rng !== undefined ? { rng: deps.rng } : {}),
      };
      return channel === 'email' ? new MockEmailProvider(options) : new MockSmsProvider(options);
    }
    case 'smtp':
      return new SmtpProvider(smtpConfigFromEnv(env));
    case 'postmark':
      return new PostmarkProvider(
        postmarkConfigFromEnv(env),
        deps.clock,
        deps.fetchImpl ?? fetch,
      );
    case 'twilio':
      return new TwilioProvider(twilioConfigFromEnv(env), deps.clock, deps.fetchImpl ?? fetch);
  }
}
