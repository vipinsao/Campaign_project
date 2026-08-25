/**
 * I12 — Every rate has an explicit, documented denominator, defined once.
 *
 * Failure it prevents: rates computed over `sent`, or over a population that
 * includes messages containing no clickable link, producing numbers that grade
 * campaigns wrongly. And the related one that is harder to see — a rate of `0%`
 * rendered where the honest answer is "we cannot know this yet".
 *
 * The values below are computed by hand in the comments so the test is checking
 * arithmetic against intent, not against the implementation.
 */
import { describe, it, expect } from 'vitest';
import {
  METRICS,
  rate,
  formatRate,
  metricsForChannel,
  isMetricValidForChannel,
  type MetricInputs,
} from '@campaign/core';

// A deliberately awkward fixture: more sent than delivered, some bounces, and
// fewer clickable messages than delivered ones.
const FIXTURE: MetricInputs = {
  queued: 1000,
  sent: 1000,
  delivered: 900, // 100 did not arrive
  failed: 20,
  bounced: 80,
  complained: 9,
  uniqueOpens: 450,
  uniqueClicks: 90,
  unsubscribes: 18,
  clickableDelivered: 600, // 300 delivered messages contained no link
  attributedOrders: 45,
};

describe('I12 — denominators are correct and documented', () => {
  it('computes open rate over DELIVERED, not sent', () => {
    // 450 / 900 = 0.50. Over `sent` it would read 45%, and the difference is
    // entirely list hygiene rather than anything about the campaign.
    expect(rate('open_rate', FIXTURE)).toBeCloseTo(0.5, 10);
    expect(rate('open_rate', FIXTURE)).not.toBeCloseTo(450 / 1000, 10);
    expect(METRICS.open_rate.denominatorLabel).toBe('unique opens ÷ delivered');
  });

  it('computes click rate over delivered messages that CONTAINED A LINK', () => {
    // 90 / 600 = 0.15. Over all delivered it would read 10%, penalising the
    // campaign for the 300 messages that had nothing to click.
    expect(rate('click_rate', FIXTURE)).toBeCloseTo(0.15, 10);
    expect(rate('click_rate', FIXTURE)).not.toBeCloseTo(90 / 900, 10);
  });

  it('computes click-to-open over unique opens', () => {
    // 90 / 450 = 0.20
    expect(rate('click_to_open_rate', FIXTURE)).toBeCloseTo(0.2, 10);
  });

  it('computes delivery, bounce, complaint, unsubscribe and conversion by hand', () => {
    expect(rate('delivery_rate', FIXTURE)).toBeCloseTo(900 / 1000, 10);
    expect(rate('bounce_rate', FIXTURE)).toBeCloseTo(80 / 1000, 10);
    expect(rate('complaint_rate', FIXTURE)).toBeCloseTo(9 / 900, 10);
    expect(rate('unsubscribe_rate', FIXTURE)).toBeCloseTo(18 / 900, 10);
    expect(rate('conversion_rate', FIXTURE)).toBeCloseTo(45 / 900, 10);
  });

  it('returns null, not zero, when a rate is not computable', () => {
    // "We cannot know this yet" and "this is zero" are different answers, and
    // almost every 0% open-rate panic in a messaging product is this bug.
    const nothingSent: MetricInputs = { ...FIXTURE, delivered: 0, sent: 0, clickableDelivered: 0 };
    expect(rate('open_rate', nothingSent)).toBeNull();
    expect(rate('click_rate', nothingSent)).toBeNull();
    expect(rate('delivery_rate', nothingSent)).toBeNull();

    expect(formatRate(null)).toBe('—');
    expect(formatRate(0)).toBe('0.0%');
    expect(formatRate(null)).not.toBe('0.0%');
  });

  it('exposes NO open rate on SMS', () => {
    // There is no such thing as an SMS open. Rendering one would be inventing a
    // number, and the UI must not be able to ask for it.
    const sms = metricsForChannel('sms').map((m) => m.key);
    expect(sms).not.toContain('open_rate');
    expect(sms).not.toContain('click_to_open_rate');
    expect(sms).not.toContain('complaint_rate');

    expect(isMetricValidForChannel('open_rate', 'sms')).toBe(false);
    expect(isMetricValidForChannel('open_rate', 'email')).toBe(true);
    expect(isMetricValidForChannel('click_rate', 'sms')).toBe(true);
  });

  it('gives every metric a denominator label the UI can render', () => {
    for (const metric of Object.values(METRICS)) {
      expect(metric.denominatorLabel, `${metric.key} has no denominator label`).toMatch(/÷/);
      expect(metric.label.length).toBeGreaterThan(0);
      expect(metric.channels.length).toBeGreaterThan(0);
    }
  });

  it('attaches the tracking caveat to the metrics that need it', () => {
    // Being the engineer who labels a number untrustworthy rather than quietly
    // shipping it is the point of this one.
    expect(METRICS.open_rate.caveat).toMatch(/Privacy Protection/i);
    expect(METRICS.click_rate.caveat).toMatch(/no clickable link/i);
    expect(METRICS.conversion_rate.caveat).toMatch(/do not double count/i);
  });

  it('defines each rate exactly once', () => {
    // Two definitions of "open rate" in two files is how the dashboard and the
    // export disagree, and nobody can say which is right.
    const keys = Object.keys(METRICS);
    expect(new Set(keys).size).toBe(keys.length);
    for (const [key, metric] of Object.entries(METRICS)) {
      expect(metric.key, 'the record key and the metric key must agree').toBe(key);
    }
  });
});
