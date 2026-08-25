/**
 * Provider adapters: the only package permitted to import a vendor SDK.
 *
 * Everything below the provider boundary talks to the network and holds
 * credentials; everything above it is testable offline. That single line is what
 * lets `npm test` run the whole domain with no accounts, and what lets the demo
 * show a bounce without anyone having to arrange a real one.
 */
export * from './backoff.ts';
export * from './deps.ts';
export * from './errors.ts';
export * from './http.ts';
export * from './mock/index.ts';
export * from './postmark.ts';
export * from './rate-limit.ts';
export * from './registry.ts';
export * from './smtp.ts';
export * from './twilio.ts';
