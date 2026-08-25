import type { Channel } from '@campaign/shared';

/**
 * Every rate in this system is defined exactly once, here  (I12).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The failure this prevents is not a crash. It is a number that is wrong, looks
 * plausible, has a chart next to it, and is used to decide things.
 *
 * Three specific ways it happens, all of which this file exists to make impossible:
 *
 *  1. THE DENOMINATOR IS `sent` RATHER THAN `delivered`. Every bounced message then
 *     counts as someone who could have opened and didn't, so a campaign to a stale
 *     list is graded on list hygiene rather than on its content.
 *
 *  2. THE DENOMINATOR INCLUDES MESSAGES WITH NO LINK. A click rate whose population
 *     contains messages that contained nothing to click grades campaigns on whether
 *     they happened to have a link at all. Hence `clickableDelivered`, counted only
 *     where the rendered body actually had a clickable link.
 *
 *  3. THE NUMERATOR AND DENOMINATOR COUNT DIFFERENT THINGS. A set of recipients
 *     divided by a count of messages is not a rate. It is a number, and it will be
 *     wrong by whatever the average messages-per-recipient happens to be — which
 *     is stable enough that nobody notices it is wrong, only that it seems low.
 *
 * Each definition below carries the sentence the UI renders in its tooltip. The
 * caveat travels with the number rather than living in a document nobody opens.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type MetricInputs = {
  readonly queued: number;
  readonly sent: number;
  readonly delivered: number;
  readonly failed: number;
  readonly bounced: number;
  readonly complained: number;
  readonly uniqueOpens: number;
  readonly uniqueClicks: number;
  readonly unsubscribes: number;
  /** Delivered messages whose rendered body actually contained a clickable link. */
  readonly clickableDelivered: number;
  readonly attributedOrders: number;
};

export type MetricKey =
  | 'delivery_rate'
  | 'bounce_rate'
  | 'open_rate'
  | 'click_rate'
  | 'click_to_open_rate'
  | 'complaint_rate'
  | 'unsubscribe_rate'
  | 'conversion_rate';

export type MetricDefinition = {
  readonly key: MetricKey;
  readonly label: string;
  /** Rendered verbatim in the UI tooltip. */
  readonly denominatorLabel: string;
  readonly numerator: (m: MetricInputs) => number;
  readonly denominator: (m: MetricInputs) => number;
  /** Channels this metric is meaningful on. SMS has no opens. */
  readonly channels: readonly Channel[];
  /** Shown beneath the number when the metric is known to be unreliable. */
  readonly caveat?: string;
};

export const METRICS: Readonly<Record<MetricKey, MetricDefinition>> = {
  delivery_rate: {
    key: 'delivery_rate',
    label: 'Delivery rate',
    denominatorLabel: 'delivered ÷ sent',
    numerator: (m) => m.delivered,
    denominator: (m) => m.sent,
    channels: ['email', 'sms'],
    caveat:
      'Counts only messages for which a provider receipt has arrived. Messages ' +
      'still awaiting a receipt are excluded from the numerator, so this can read ' +
      'low shortly after a send rather than indicating a problem.',
  },

  bounce_rate: {
    key: 'bounce_rate',
    label: 'Bounce rate',
    denominatorLabel: 'bounced ÷ sent',
    numerator: (m) => m.bounced,
    denominator: (m) => m.sent,
    channels: ['email', 'sms'],
  },

  open_rate: {
    key: 'open_rate',
    label: 'Open rate',
    // Delivered, NOT sent. A bounced message is not a person who chose not to open.
    denominatorLabel: 'unique opens ÷ delivered',
    numerator: (m) => m.uniqueOpens,
    denominator: (m) => m.delivered,
    channels: ['email'],
    caveat:
      'Open tracking relies on a tracking pixel. Apple Mail Privacy Protection ' +
      'and similar features prefetch images regardless of whether the recipient ' +
      'read anything, which inflates this number by an amount that cannot be ' +
      'measured from here. Treat it as directional, and prefer click rate when ' +
      'comparing campaigns.',
  },

  click_rate: {
    key: 'click_rate',
    label: 'Click rate',
    // Note the denominator: delivered messages THAT CONTAINED A LINK.
    denominatorLabel: 'unique clicks ÷ delivered messages containing a link',
    numerator: (m) => m.uniqueClicks,
    denominator: (m) => m.clickableDelivered,
    channels: ['email', 'sms'],
    caveat:
      'The denominator excludes delivered messages whose rendered body contained ' +
      'no clickable link, because including them grades a campaign on whether it ' +
      'had a link rather than on whether the link worked.',
  },

  click_to_open_rate: {
    key: 'click_to_open_rate',
    label: 'Click-to-open rate',
    denominatorLabel: 'unique clicks ÷ unique opens',
    numerator: (m) => m.uniqueClicks,
    denominator: (m) => m.uniqueOpens,
    channels: ['email'],
    caveat:
      'Inherits the open-rate caveat in its denominator: prefetched opens inflate ' +
      'the denominator and therefore deflate this rate.',
  },

  complaint_rate: {
    key: 'complaint_rate',
    label: 'Complaint rate',
    denominatorLabel: 'complaints ÷ delivered',
    numerator: (m) => m.complained,
    denominator: (m) => m.delivered,
    channels: ['email'],
  },

  unsubscribe_rate: {
    key: 'unsubscribe_rate',
    label: 'Unsubscribe rate',
    denominatorLabel: 'unsubscribes ÷ delivered',
    numerator: (m) => m.unsubscribes,
    denominator: (m) => m.delivered,
    channels: ['email', 'sms'],
  },

  conversion_rate: {
    key: 'conversion_rate',
    label: 'Conversion rate',
    denominatorLabel: 'attributed orders ÷ delivered',
    numerator: (m) => m.attributedOrders,
    denominator: (m) => m.delivered,
    channels: ['email', 'sms'],
    caveat:
      'An order is attributed when it is placed within the attribution window ' +
      'after a click on this campaign. An order is attributed to at most one ' +
      'campaign, so these do not double count — and they also do not sum to total ' +
      'revenue.',
  },
};

/**
 * Compute a rate, or return `null` when it is not computable.
 *
 * `null` and `0` are different answers and the UI renders them differently. A zero
 * denominator means "we cannot know this yet"; returning 0 would assert that the
 * rate is zero, which is a claim the data does not support. Almost every
 * "0% open rate" panic in a messaging product is this bug.
 */
export function rate(key: MetricKey, inputs: MetricInputs): number | null {
  const metric = METRICS[key];
  const denominator = metric.denominator(inputs);
  if (denominator <= 0) return null;
  return metric.numerator(inputs) / denominator;
}

/** Which metrics may be rendered for a channel. SMS has no open rate at all. */
export function metricsForChannel(channel: Channel): MetricDefinition[] {
  return Object.values(METRICS).filter((m) => m.channels.includes(channel));
}

export function isMetricValidForChannel(key: MetricKey, channel: Channel): boolean {
  return METRICS[key].channels.includes(channel);
}

/**
 * Formats a rate for display. `null` becomes an em dash, never "0%".
 *
 * The UI must be able to show three distinct states — a value, "not computable
 * yet", and "not applicable to this channel" — because collapsing any two of them
 * is how an operator ends up making a decision about a number that was never there.
 */
export function formatRate(value: number | null): string {
  if (value === null) return '—';
  return `${(value * 100).toFixed(1)}%`;
}
