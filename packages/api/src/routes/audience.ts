import { Hono } from 'hono';
import { z } from 'zod';
import { AudienceCompileError, AudienceResolver } from '@campaign/core';
import { AudienceDefinition } from '@campaign/shared';
import type { ApiDeps } from '../deps.ts';
import type { AppEnv } from '../middleware/context.ts';
import { tenantOf } from '../middleware/context.ts';
import { unprocessable } from '../errors.ts';
import { loadCampaign } from '../services/campaigns.ts';

const EstimateBody = z.object({
  audience: AudienceDefinition.optional(),
  campaignId: z.uuid().optional(),
  sampleSize: z.number().int().min(0).max(100).optional(),
});

const MatchesBody = z.object({
  audience: AudienceDefinition.optional(),
  campaignId: z.uuid().optional(),
  contactId: z.uuid(),
});

/**
 * The audience endpoints.
 *
 * `estimate` and `matches` are two evaluations of the SAME compiled predicate —
 * `AudienceResolver` guarantees that, and this layer must not add a second path.
 * The failure mode the resolver's own comment describes is the one worth repeating
 * here, because it is an API-shaped failure: the operator reads "12,400 contacts"
 * on this endpoint's response, presses send, and 9,000 messages go out. A wrong
 * number that is trusted is worse than no number, because someone who sees no
 * estimate goes and checks.
 *
 * `compiledSql` and `params` come back to the client on purpose. The operator can
 * see exactly what will run against their data. That disclosure is only safe
 * because the compiler provably never interpolates an operator-supplied value into
 * SQL text — see the header of packages/core/src/audience/compiler.ts. If one
 * branch there ever spliced, this endpoint would become an oracle that echoes an
 * injected string back and confirms it landed.
 */
export function audienceRoutes(deps: ApiDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const resolver = new AudienceResolver(deps.clock);

  const definitionFor = async (
    tenantId: string,
    body: { audience?: AudienceDefinition | undefined; campaignId?: string | undefined },
  ): Promise<AudienceDefinition> => {
    if (body.audience !== undefined) return body.audience;
    if (body.campaignId === undefined) return {};
    const campaign = await loadCampaign(deps.db, tenantId, body.campaignId);
    const parsed = AudienceDefinition.safeParse(campaign.audience);
    if (!parsed.success) {
      throw unprocessable(
        'audience_invalid',
        'The stored audience for this campaign does not parse.',
        { campaignId: campaign.id, issues: parsed.error.issues },
      );
    }
    return parsed.data;
  };

  app.post('/audience/estimate', async (c) => {
    const tenantId = tenantOf(c);
    const body = EstimateBody.parse(await c.req.json<unknown>());
    const audience = await definitionFor(tenantId, body);

    try {
      const estimate = await resolver.estimate(deps.db, tenantId, audience, body.sampleSize ?? 25);
      return c.json({
        count: estimate.count,
        sample: estimate.sample,
        compiledSql: estimate.compiledSql,
        params: estimate.params,
      });
    } catch (error) {
      throw asAudienceError(error);
    }
  });

  app.post('/audience/matches', async (c) => {
    const tenantId = tenantOf(c);
    const body = MatchesBody.parse(await c.req.json<unknown>());
    const audience = await definitionFor(tenantId, body);

    try {
      const result = await resolver.matches(deps.db, tenantId, body.contactId, audience);
      return c.json({
        contactId: body.contactId,
        matched: result.matched,
        // Present only on a non-match: which rule turned this contact away, in
        // prose. It is the difference between a support ticket and a self-service
        // answer, which is why the resolver pays extra round trips for it.
        failedRule: result.failedRule ?? null,
      });
    } catch (error) {
      throw asAudienceError(error);
    }
  });

  return app;
}

function asAudienceError(error: unknown): unknown {
  if (error instanceof AudienceCompileError) {
    // `path` names which rule of a forty-rule segment is wrong. Losing it in a
    // generic 422 is exactly the failure the error envelope's `details` exists to
    // prevent.
    return unprocessable('audience_uncompilable', error.message, {
      path: error.path,
    });
  }
  return error;
}
