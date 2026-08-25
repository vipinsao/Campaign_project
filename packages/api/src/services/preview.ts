import type { PoolClient } from 'pg';
import { MERGE_FIELDS, queryOne, render, validateTemplate } from '@campaign/core';
import type { MergeContext, ValidationResult } from '@campaign/core';
import type { ApiDeps } from '../deps.ts';
import { notFound } from '../errors.ts';
import type { CampaignMessageRow, CampaignRow } from './campaigns.ts';
import { mintUnsubscribeToken, unsubscribeUrl } from './unsubscribe.ts';

/**
 * Rendering a campaign message for preview and for test sends.
 *
 * Preview goes through `validateTemplate` and `render` from packages/core — the
 * same two functions the send path uses. There is deliberately no rendering code
 * in this package. A preview with its own renderer agrees with the sent message
 * right up until the day it does not, and the day it does not is the day somebody
 * approved copy that said something else.
 */

export type PreviewResult = {
  readonly subject: string | null;
  readonly body: string;
  readonly html: string | null;
  readonly unsubscribeUrl: string;
  readonly context: MergeContext;
  readonly validation: ValidationResult;
  /** The contact the preview resolved against, or null when sample data was used. */
  readonly contactId: string | null;
};

type ContactRow = {
  readonly id: string;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly locale: string;
};

type OrderRow = {
  readonly order_number: string;
  readonly total: string;
  readonly currency: string;
  readonly status: string;
  readonly carrier: string | null;
  readonly tracking_number: string | null;
  readonly placed_at: Date;
  readonly delivered_at: Date | null;
};

/**
 * Stand-in values for a preview with no contact bound.
 *
 * Deliberately long and deliberately awkward: a name with an accent, a
 * thirteen-character order number. Previewing with `Bob` and `1` produces a layout
 * that looks fine and an SMS that bills as one segment, and the real send does
 * neither.
 */
const SAMPLE: MergeContext = {
  contact: {
    first_name: 'Konstantinos',
    last_name: 'Papadopoulos',
    email: 'sample@example.test',
    phone: '+15550100',
    locale: 'en',
  },
  order: {
    number: 'ORD-000000000',
    total: '128.50',
    currency: 'USD',
    carrier: 'DHL',
    tracking_number: 'JD0002',
    tracking_url: 'https://example.test/track/JD0002',
    placed_at: '2026-05-01',
    delivered_at: '2026-05-04',
  },
};

export async function renderCampaignMessage(
  deps: ApiDeps,
  db: PoolClient | ApiDeps['db'],
  input: {
    readonly tenantId: string;
    readonly campaign: CampaignRow;
    readonly message: CampaignMessageRow;
    readonly contactId?: string | null;
    readonly orderId?: string | null;
    readonly messageQueueId?: string | null;
  },
): Promise<PreviewResult> {
  let contact: ContactRow | undefined;
  if (input.contactId !== undefined && input.contactId !== null) {
    contact = await queryOne<ContactRow>(
      db,
      `SELECT id, first_name, last_name, email::text AS email, phone, locale
         FROM contacts WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.contactId],
    );
    if (contact === undefined) throw notFound('Contact', input.contactId);
  }

  let order: OrderRow | undefined;
  if (input.orderId !== undefined && input.orderId !== null) {
    order = await queryOne<OrderRow>(
      db,
      `SELECT order_number, total::text AS total, currency, status, carrier,
              tracking_number, placed_at, delivered_at
         FROM orders WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.orderId],
    );
    if (order === undefined) throw notFound('Order', input.orderId);
  }

  /**
   * A preview against a real contact mints a REAL unsubscribe token.
   *
   * The alternative — a placeholder like `.../u/PREVIEW` — makes the one link in
   * the message that must work the one link nobody ever exercises. An operator
   * checking their copy clicks it, gets a 404, and has no way to tell whether the
   * campaign is broken or the preview is. When there is no contact to bind, the
   * sample context is used and the response says so via `contactId: null`.
   */
  const url =
    contact === undefined
      ? unsubscribeUrl(deps.publicBaseUrl, 'SAMPLE-TOKEN')
      : unsubscribeUrl(
          deps.publicBaseUrl,
          await mintUnsubscribeToken(db, {
            tenantId: input.tenantId,
            contactId: contact.id,
            messageQueueId: input.messageQueueId ?? null,
          }),
        );

  const context: MergeContext = {
    contact:
      contact === undefined
        ? SAMPLE.contact
        : {
            first_name: contact.first_name,
            last_name: contact.last_name,
            email: contact.email,
            phone: contact.phone,
            locale: contact.locale,
          },
    order:
      order === undefined
        ? contact === undefined
          ? SAMPLE.order
          : undefined
        : {
            number: order.order_number,
            total: order.total,
            currency: order.currency,
            carrier: order.carrier,
            tracking_number: order.tracking_number,
            tracking_url: null,
            placed_at: order.placed_at.toISOString(),
            delivered_at: order.delivered_at?.toISOString() ?? null,
          },
    unsubscribe_url: url,
    preferences_url: url,
  };

  const validation = validateTemplate(
    {
      channel: input.message.channel,
      subject: input.message.subject_template,
      body: input.message.body_template,
      html: input.message.html_template,
    },
    input.campaign.category,
  );

  return {
    // Subject and plain-text body render UNESCAPED; only the HTML part is escaped.
    // An `&amp;` in a subject line is visible to the recipient as `&amp;`, and an
    // escaped plain-text body is worse — every apostrophe becomes `&#39;`.
    subject:
      input.message.subject_template === null
        ? null
        : render(input.message.subject_template, context, { escape: false }),
    body: render(input.message.body_template, context, { escape: false }),
    html:
      input.message.html_template === null
        ? null
        : render(input.message.html_template, context, { escape: true }),
    unsubscribeUrl: url,
    context,
    validation,
    contactId: contact?.id ?? null,
  };
}

/**
 * Human-readable metadata for the merge-field picker.
 *
 * The LIST comes from `MERGE_FIELDS` in packages/core, not from a copy kept here.
 * A field added to the renderer but missing from this map is reported with a null
 * description rather than being omitted — an omitted field is one the operator
 * cannot discover, which is how a template ends up hand-written from a stale wiki
 * page.
 */
const DESCRIPTIONS: Readonly<Record<string, string>> = {
  'contact.first_name': "The contact's given name.",
  'contact.last_name': "The contact's family name.",
  'contact.email': 'The email address on file.',
  'contact.phone': 'The E.164 phone number on file.',
  'contact.locale': "The contact's locale, e.g. 'en'.",
  'order.number': 'The order number, as the store shows it.',
  'order.total': 'Order total, unformatted.',
  'order.currency': 'ISO currency code for the order total.',
  'order.carrier': 'Shipping carrier.',
  'order.tracking_number': 'Carrier tracking number.',
  'order.tracking_url': "Carrier's own tracking page for this shipment.",
  'order.placed_at': 'When the order was placed.',
  'order.delivered_at': 'When the order was delivered.',
  unsubscribe_url: 'One-click link to the preference centre. Required in marketing mail (I7).',
  preferences_url: 'The preference centre; same destination as unsubscribe_url.',
};

export function mergeFieldCatalogue(): readonly {
  readonly name: string;
  readonly description: string | null;
  readonly requiresOrder: boolean;
}[] {
  return MERGE_FIELDS.map((name) => ({
    name,
    description: DESCRIPTIONS[name] ?? null,
    // An `order.*` field on a campaign with no order anchor renders empty, so the
    // picker has to be able to grey them out rather than offer them everywhere.
    requiresOrder: name.startsWith('order.'),
  }));
}
