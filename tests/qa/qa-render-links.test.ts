/**
 * QA — adversarial review of `extractLinks` / `shouldRewrite` / `rewriteLinks`
 * (hypothesis 13).
 *
 * The load-bearing question: can a crafted URL slip past the opt-out exclusion so
 * that a legally required unsubscribe gets routed through a click-tracking
 * redirect?
 *
 * Short answer: not for a URL this system actually mints, in either direction.
 *
 * The original exclusion was `/\/u\/[a-z0-9_-]+/` over the lowercased URL — a bare
 * substring match. It held the legally load-bearing direction (a minted token is
 * 32 random bytes as base64url, an alphabet of exactly [A-Za-z0-9_-], every
 * character of which survives `.toLowerCase()` inside that class) and leaked the
 * other one silently, in both directions at once:
 *
 *   - it OVER-fired, so `/u/2` or `/u/dashboard` — ordinary pages — escaped click
 *     tracking, and through `hasClickableLink` fell out of the click-rate
 *     denominator entirely, quietly inflating the rate (I12);
 *   - it UNDER-fired, so an opt-out route spelled any other way (`/unsubscribe/`,
 *     `/api/optout/`) was routed straight through the tracking redirect.
 *
 * `shouldRewrite` now parses the URL and matches on the ROUTE: unambiguous opt-out
 * segments anywhere in the path, plus `/u/<token>` only where the token looks
 * minted rather than like a word. A URL nested in a query string or fragment is
 * judged by the looser rule, because that direction is fail-safe.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { shouldRewrite, rewriteLinks, hasClickableLink, extractLinks } from '@campaign/core';

const track = (u: string) => `https://track.example.com/c/${encodeURIComponent(u)}`;

describe('QA/links — the unsubscribe exclusion holds (SAFE)', () => {
  it('excludes 2000 real minted tokens, in every case variation', () => {
    const leaked: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const token = randomBytes(32).toString('base64url');
      for (const url of [
        `https://example.com/u/${token}`,
        `HTTPS://EXAMPLE.COM/U/${token.toUpperCase()}`,
        `  https://example.com/u/${token}  `,
        `https://example.com/u/${token}?utm_source=email`,
        `https://example.com/u/${token}#footer`,
      ]) {
        if (shouldRewrite(url)) leaked.push(url);
      }
    }
    expect(
      leaked,
      `unsubscribe URLs routed through click tracking:\n${leaked.slice(0, 5).join('\n')}`,
    ).toEqual([]);
  });

  it('rewriteLinks leaves the opt-out anchor untouched in a realistic marketing email', () => {
    const html =
      '<p>Shop <a href="https://shop.example.com/sale">now</a></p>' +
      '<a href="mailto:hi@example.com">Reply</a>' +
      '<a href="tel:+15551234567">Call</a>' +
      '<a href="#top">Top</a>' +
      '<a href="https://example.com/u/AbC-_dEf123">Unsubscribe</a>';
    const { html: out, rewritten } = rewriteLinks(html, track);
    expect(rewritten).toEqual(['https://shop.example.com/sale']);
    expect(out).toContain('href="https://example.com/u/AbC-_dEf123"');
  });

  it('an unsubscribe URL smuggled into a tracking query string is still excluded', () => {
    expect(shouldRewrite('https://evil.example.com/go?to=https://example.com/u/tok')).toBe(false);
  });
});

describe('QA/links — the exclusion matches the route, not a substring (FIXED)', () => {
  it('an ordinary URL containing "/u/<word>" keeps its click tracking', () => {
    // Nothing about these is an opt-out. They are ordinary marketing destinations.
    const ordinary = [
      'https://shop.example.com/u/2',
      'https://blog.example.com/2026/u/x',
      'https://example.com/products?ref=/u/a',
      'https://example.com/#/u/dashboard',
    ];
    const excluded = ordinary.filter((u) => !shouldRewrite(u));
    expect(
      excluded,
      `these are not opt-out links, but the /u/ substring rule excluded them from tracking`,
    ).toEqual([]);
  });

  it('and stays in the click-rate denominator (I12)', () => {
    // `hasClickableLink` feeds `clickable_delivered`. A message whose only link
    // happens to contain "/u/<word>" is reported as having nothing clickable, so
    // it never lands in the denominator and the click rate is quietly inflated.
    const body = 'Your new dashboard: https://app.example.com/u/dashboard';
    expect(extractLinks(body)).toEqual(['https://app.example.com/u/dashboard']);
    expect(
      hasClickableLink(body, null),
      'a real, clickable marketing link was classified as unclickable',
    ).toBe(true);
  });

  it('an opt-out route not spelled /u/ is excluded too', () => {
    // The exclusion is no longer hardcoded to this deployment's route shape.
    // Point PUBLIC_BASE_URL at a path prefix, or rename the route to something
    // conventional, and the guarantee travels with it.
    expect(
      shouldRewrite('https://example.com/unsubscribe/AbC-_dEf123'),
      'an /unsubscribe/ route would be routed through click tracking',
    ).toBe(false);
    expect(
      shouldRewrite('https://example.com/api/optout/AbC-_dEf123'),
      'an /optout/ route would be routed through click tracking',
    ).toBe(false);
  });
});

describe('QA/links — rewriteLinks parsing gaps', () => {
  it('CHARACTERISATION: an unquoted href is never rewritten at all', () => {
    const { rewritten } = rewriteLinks('<a href=https://shop.example.com/sale>now</a>', track);
    expect(rewritten).toEqual([]);
  });

  it('CHARACTERISATION: an href inside a comment or a plain attribute value is rewritten', () => {
    const { rewritten } = rewriteLinks(
      '<!-- href="https://example.com/draft" --><img data-x=\'\' alt="href=&quot;x&quot;">',
      track,
    );
    expect(rewritten).toEqual(['https://example.com/draft']);
  });
});
