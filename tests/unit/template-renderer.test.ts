/**
 * Template rendering and save-time validation.
 *
 * The rules under test are the ones that turn a rendering bug into an incident:
 * an unknown merge field that renders empty, an unescaped contact name, an SMS
 * that bills as three segments because the count was taken on the template rather
 * than the output, and a marketing message with no working opt-out.
 */
import { describe, it, expect } from 'vitest';
import {
  validateTemplate,
  render,
  escapeHtml,
  smsSegments,
  extractMergeFields,
  extractLinks,
  rewriteLinks,
  shouldRewrite,
  hasClickableLink,
} from '@campaign/core';

const CONTEXT = {
  contact: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' },
  order: { number: 'ORD-1001', total: 42.5, tracking_url: 'https://example.com/track/1' },
  unsubscribe_url: 'https://example.com/u/tok123',
  preferences_url: 'https://example.com/u/tok123',
};

describe('merge rendering', () => {
  it('substitutes known fields', () => {
    expect(render('Hi {{contact.first_name}}!', CONTEXT, { escape: true })).toBe('Hi Ada!');
  });

  it('renders a missing value as empty rather than as the token', () => {
    // The template still renders; validateTemplate is what refuses to SAVE a
    // template referencing a field that does not exist.
    expect(render('Hi {{contact.middle_name}}.', CONTEXT, { escape: true })).toBe('Hi .');
  });

  it('escapes contact-supplied values by default', () => {
    const hostile = {
      ...CONTEXT,
      contact: { first_name: '<script>alert(1)</script>' },
    };
    const out = render('Hello {{contact.first_name}}', hostile, { escape: true });
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('allows an explicit raw block for operator-authored markup', () => {
    const ctx = { ...CONTEXT, contact: { first_name: '<b>Ada</b>' } };
    expect(render('{{{contact.first_name}}}', ctx, { escape: true })).toBe('<b>Ada</b>');
    expect(render('{{contact.first_name}}', ctx, { escape: true })).toContain('&lt;b&gt;');
  });

  it('escapes every dangerous character', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('finds the merge fields a template references', () => {
    const fields = extractMergeFields('{{contact.first_name}} {{order.number}} {{unsubscribe_url}}');
    expect(fields.sort()).toEqual(['contact.first_name', 'order.number', 'unsubscribe_url']);
  });
});

describe('save-time validation', () => {
  it('rejects an unknown merge field, naming it', () => {
    const result = validateTemplate(
      {
        channel: 'email',
        subject: 'Hello',
        body: 'Hi {{contact.frist_name}}. {{unsubscribe_url}}',
      },
      'promotional',
    );
    expect(result.errors.some((e) => e.field === 'contact.frist_name')).toBe(true);
    expect(result.errors[0]?.message).toContain('frist_name');
  });

  it('REFUSES a marketing template with no opt-out (I7)', () => {
    const result = validateTemplate(
      { channel: 'email', subject: 'Sale', body: 'Everything half price.' },
      'promotional',
    );
    expect(result.errors.some((e) => /opt-out/i.test(e.message))).toBe(true);
  });

  it('accepts a marketing template carrying a preference-centre link', () => {
    const result = validateTemplate(
      { channel: 'email', subject: 'Sale', body: 'Half price. {{preferences_url}}' },
      'promotional',
    );
    expect(result.errors).toEqual([]);
  });

  it('does NOT require an opt-out on a transactional message', () => {
    // A shipping notification is not marketing, and demanding an unsubscribe link
    // on it would be wrong in both directions.
    const result = validateTemplate(
      { channel: 'sms', body: 'Your order {{order.number}} is out for delivery.' },
      'transactional',
    );
    expect(result.errors).toEqual([]);
  });

  it('requires a subject on email and not on SMS', () => {
    expect(
      validateTemplate({ channel: 'email', subject: '', body: 'x {{unsubscribe_url}}' }, 'lifecycle')
        .errors.some((e) => e.field === 'subject'),
    ).toBe(true);
    expect(
      validateTemplate({ channel: 'sms', body: 'x {{unsubscribe_url}}' }, 'lifecycle').errors,
    ).toEqual([]);
  });
});

describe('SMS segment counting', () => {
  it('counts a plain GSM-7 message as one segment up to 160', () => {
    expect(smsSegments('a'.repeat(160))).toMatchObject({ segments: 1, encoding: 'GSM-7' });
    expect(smsSegments('a'.repeat(161))).toMatchObject({ segments: 2, encoding: 'GSM-7' });
  });

  it('drops to 70 characters per segment when any character forces UCS-2', () => {
    // A single curly apostrophe pasted from a word processor does this, and it is
    // the most common way an SMS silently triples in cost.
    const straight = "Your order's on its way";
    const curly = 'Your order’s on its way';
    expect(smsSegments(straight).encoding).toBe('GSM-7');
    expect(smsSegments(curly).encoding).toBe('UCS-2');
    expect(smsSegments('’'.repeat(71)).segments).toBe(2);
  });

  it('charges two septets for GSM-7 extended characters', () => {
    expect(smsSegments('€').units).toBe(2);
    expect(smsSegments('{').units).toBe(2);
  });

  it('counts an astral emoji as two UTF-16 units, like the carrier does', () => {
    expect(smsSegments('\u{1F600}').units).toBe(2);
  });

  it('bills correctly where template-based counting would under-count', () => {
    // The precise shape of the bug. A merge token is 19 characters of template
    // and 34 characters of output, so a template that measures as one segment can
    // render as two. Counting the template says this message costs one; the
    // carrier charges for two, on every recipient, forever.
    const body = `${'A'.repeat(130)} {{unsubscribe_url}}`;

    // 130 + 1 space + 19 token characters = 150, plus 4 more because the token's
    // own braces are GSM-7 EXTENDED characters costing two septets each. That
    // detail is itself a reason not to measure templates.
    const asTemplate = smsSegments(body);
    expect(asTemplate.units).toBe(154);
    expect(asTemplate.segments, 'the raw template measures as a single segment').toBe(1);

    const result = validateTemplate({ channel: 'sms', body }, 'transactional');
    expect(result.renderedLength, 'the opt-out URL is longer than its token').toBe(165);
    expect(
      result.smsSegments,
      'counting the template rather than the output under-counts the bill',
    ).toBe(2);
  });

  it('warns once realistic merge values push it past one segment', () => {
    const body =
      'Hi {{contact.first_name}}, your order {{order.number}} has shipped and is on ' +
      'its way to you. You can track it any time using the link below, and if you ' +
      'would rather not hear from us again just reply STOP: {{unsubscribe_url}}';

    const result = validateTemplate({ channel: 'sms', body }, 'transactional');
    expect(result.smsSegments!).toBeGreaterThan(1);
    expect(result.warnings.some((w) => w.message.includes('segments'))).toBe(true);
  });
});

describe('click-tracking link rewriting', () => {
  it('rewrites ordinary links', () => {
    const { html, rewritten } = rewriteLinks(
      '<a href="https://example.com/product/1">Buy</a>',
      (u) => `https://track.example.com/c/${encodeURIComponent(u)}`,
    );
    expect(rewritten).toEqual(['https://example.com/product/1']);
    expect(html).toContain('track.example.com');
  });

  it('never rewrites mailto, tel, anchors, or the unsubscribe link', () => {
    // Routing a legally required opt-out through a tracking redirect breaks
    // one-click List-Unsubscribe and reads as a dark pattern to mailbox providers.
    expect(shouldRewrite('mailto:help@example.com')).toBe(false);
    expect(shouldRewrite('tel:+15005550006')).toBe(false);
    expect(shouldRewrite('#section')).toBe(false);
    expect(shouldRewrite('https://example.com/u/abc123XYZ')).toBe(false);
    expect(shouldRewrite('{{unsubscribe_url}}')).toBe(false);
    expect(shouldRewrite('https://example.com/product/1')).toBe(true);
  });

  it('leaves an excluded link untouched in the output', () => {
    const source =
      '<a href="https://example.com/p/1">Buy</a> <a href="https://example.com/u/tok">Unsubscribe</a>';
    const { html, rewritten } = rewriteLinks(source, () => 'https://track.example.com/c/x');
    expect(rewritten).toHaveLength(1);
    expect(html).toContain('https://example.com/u/tok');
  });

  it('knows whether a message contains anything clickable (I12)', () => {
    // Feeds clickable_delivered, so a message with no link never lands in the
    // denominator of a click rate.
    expect(hasClickableLink('Just text, nothing to click.')).toBe(false);
    expect(hasClickableLink('Reply to this email or call tel:+15005550006')).toBe(false);
    expect(hasClickableLink('Shop now: https://example.com/sale')).toBe(true);
  });

  it('extracts links from both markup and bare text', () => {
    expect(extractLinks('<a href="https://a.example.com">x</a> and https://b.example.com')).toEqual(
      expect.arrayContaining(['https://a.example.com', 'https://b.example.com']),
    );
  });
});
