/**
 * Types and zod schemas shared by api, worker, triage and web.
 *
 * This package deliberately contains no behaviour. It is the vocabulary the rest
 * of the system agrees on, and nothing else.
 */
export * from './domain.ts';
export * from './reason-codes.ts';
export * from './audience.ts';
export * from './provider.ts';
