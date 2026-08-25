/**
 * The audience compiler and its two evaluators.
 *
 * The DSL types themselves live in @campaign/shared, because the segment builder in
 * the web package has to speak them too and must not depend on the domain.
 */
export { compileAudience, describeRule, AudienceCompileError } from './compiler.ts';
export { AudienceResolver } from './resolver.ts';
export type { AudienceDb, AudienceEstimate, AudienceMatch, ContactSample } from './resolver.ts';
