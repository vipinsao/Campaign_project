import { Hono } from 'hono';
import { z } from 'zod';
import { hasClickableLink, validateTemplate } from '@campaign/core';
import { CampaignCategory, Channel } from '@campaign/shared';
import type { AppEnv } from '../middleware/context.ts';
import { tenantOf } from '../middleware/context.ts';
import { mergeFieldCatalogue } from '../services/preview.ts';

const ValidateBody = z.object({
  channel: Channel,
  category: CampaignCategory,
  subjectTemplate: z.string().max(500).nullish(),
  bodyTemplate: z.string().max(500_000),
  htmlTemplate: z.string().max(500_000).nullish(),
  /**
   * The longest realistic values for this tenant's data, so SMS segment counting
   * reflects what will actually be billed. Optional; core falls back to a
   * deliberately long default set.
   */
  longestMergeValues: z.record(z.string(), z.string()).optional(),
});

/**
 * Template validation as a first-class endpoint, callable before anything is
 * saved.
 *
 * The editor calls this on blur, and it returns exactly what `/activate` will
 * decide later — because it calls the same `validateTemplate` from packages/core.
 * Two validators, one for the editor and one for activation, is how a campaign
 * passes every check the operator can see and then refuses to activate for a
 * reason the UI has no words for.
 */
export function templateRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/templates/validate', async (c) => {
    // Called for its 401: validation touches no rows, but an unauthenticated
    // endpoint that enumerates merge fields is a free map of the schema.
    tenantOf(c);
    const body = ValidateBody.parse(await c.req.json<unknown>());

    const result = validateTemplate(
      {
        channel: body.channel,
        // `?? null`, not passthrough: `exactOptionalPropertyTypes` distinguishes an
        // absent key from a key holding undefined, and core's signature means the
        // former.
        subject: body.subjectTemplate ?? null,
        body: body.bodyTemplate,
        html: body.htmlTemplate ?? null,
      },
      body.category,
      body.longestMergeValues === undefined
        ? {}
        : { longestMergeValues: body.longestMergeValues },
    );

    return c.json({
      ok: result.errors.length === 0,
      errors: result.errors,
      warnings: result.warnings,
      mergeFields: result.mergeFields,
      links: result.links,
      // I12: a message with nothing to click must never land in the denominator of
      // a click rate. Surfacing it here lets the editor say so while the operator
      // is still deciding whether to add a link, rather than leaving them to
      // wonder later why the campaign has no click rate at all.
      hasClickableLink: hasClickableLink(body.bodyTemplate, body.htmlTemplate),
      ...(result.smsSegments === undefined
        ? {}
        : { smsSegments: result.smsSegments, renderedLength: result.renderedLength }),
    });
  });

  app.get('/merge-fields', (c) => {
    tenantOf(c);
    return c.json({ fields: mergeFieldCatalogue() });
  });

  return app;
}
