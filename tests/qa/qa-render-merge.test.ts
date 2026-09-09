/**
 * QA — adversarial review of `render()` raw-token substitution  (hypothesis 12).
 *
 * The brief asked whether a merge VALUE containing the placeholder string, or
 * contact data containing `{{unsubscribe_url}}`, can hijack the substitution.
 *
 * Reading the source settles half of it immediately: the placeholder is NOT the
 * space-delimited ' RAW0 ' it looks like in an editor. It is `<NUL>RAW0<NUL>` —
 * NUL-delimited. PostgreSQL TEXT cannot store a NUL byte, so contact data loaded
 * from the database can never forge one. That is a genuinely good defence and the
 * first block below proves it.
 *
 * What is NOT defended is the substitution itself:
 *
 *     for (const [token, value] of raws) output = output.replace(token, value);
 *
 * `String.prototype.replace` interprets `$&`, `` $` ``, `$'`, `$$` and `$<n>` in the
 * REPLACEMENT string, and `value` here is contact-supplied merge data. A customer
 * whose name contains `$&` does not get their name rendered.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@campaign/core';

/** The real internal placeholder, reconstructed. */
const NUL_TOKEN = '\u0000RAW0\u0000';
/** What the placeholder looks like to a reader — and what an attacker would try. */
const LOOKALIKE = ' RAW0 ';

describe('QA/render — the raw-token placeholder is NUL-delimited (SAFE)', () => {
  it('is not collidable with the space-delimited lookalike " RAW0 "', () => {
    const out = render(
      'Hi {{contact.first_name}}! <a href="{{{unsubscribe_url}}}">Unsubscribe</a>',
      { contact: { first_name: LOOKALIKE }, unsubscribe_url: 'https://example.com/u/tok123' },
      { escape: true },
    );
    // The unsubscribe URL stays in the href; the hostile name stays in the greeting.
    expect(out).toBe('Hi  RAW0 ! <a href="https://example.com/u/tok123">Unsubscribe</a>');
  });

  it('does not re-expand a merge token that arrives inside contact data', () => {
    const out = render(
      'Hi {{contact.first_name}}',
      {
        contact: { first_name: '{{unsubscribe_url}}' },
        unsubscribe_url: 'https://example.com/u/x',
      },
      { escape: false },
    );
    expect(out, 'contact data must never be treated as template source').toBe(
      'Hi {{unsubscribe_url}}',
    );
  });

  it('does not re-expand a RAW token that arrives inside contact data', () => {
    const out = render(
      'Hi {{contact.first_name}}',
      {
        contact: { first_name: '{{{unsubscribe_url}}}' },
        unsubscribe_url: 'https://example.com/u/x',
      },
      { escape: false },
    );
    expect(out).toBe('Hi {{{unsubscribe_url}}}');
  });

  it('keeps two raw tokens in their own positions', () => {
    const out = render(
      '{{{order.tracking_url}}} | {{{unsubscribe_url}}}',
      { contact: {}, order: { tracking_url: 'TRACK' }, unsubscribe_url: 'UNSUB' },
      { escape: false },
    );
    expect(out).toBe('TRACK | UNSUB');
  });
});

describe('QA/render — `$` replacement patterns in raw merge values (FIXED)', () => {
  it('`$&` in a raw merge value survives as two literal characters', () => {
    const out = render(
      'Hello {{{contact.first_name}}}, welcome.',
      { contact: { first_name: 'A$&B' } },
      { escape: false },
    );
    expect(
      out,
      `raw substitution leaked the internal placeholder into the message: ${JSON.stringify(out)}`,
    ).toBe('Hello A$&B, welcome.');
    expect(out, 'a NUL byte must never reach a rendered message body').not.toContain(NUL_TOKEN);
  });

  it("`$'` in a raw merge value does not duplicate the rest of the body", () => {
    const out = render(
      'Hi {{{contact.first_name}}} — your code is 8891.',
      { contact: { first_name: "O$'Brien" } },
      { escape: false },
    );
    expect(out, `got: ${JSON.stringify(out)}`).toBe("Hi O$'Brien — your code is 8891.");
  });

  it('a backtick-dollar in a raw merge value does not duplicate the preceding text', () => {
    const out = render(
      'Dear {{{contact.last_name}}},',
      { contact: { last_name: 'X$`Y' } },
      { escape: false },
    );
    expect(out, `got: ${JSON.stringify(out)}`).toBe('Dear X$`Y,');
  });

  it('`$$` in a raw merge value stays two dollar signs', () => {
    const out = render(
      'Total {{{order.total}}}',
      { contact: {}, order: { total: '$$100' } },
      { escape: false },
    );
    expect(out, `got: ${JSON.stringify(out)}`).toBe('Total $$100');
  });

  it('the escaped (non-raw) path is immune — it uses a replacer FUNCTION, not a string', () => {
    const out = render(
      'Hello {{contact.first_name}}, welcome.',
      { contact: { first_name: "A$&B$'C$`D" } },
      { escape: false },
    );
    expect(out).toBe("Hello A$&B$'C$`D, welcome.");
  });
});

describe('QA/render — placeholder collision is closed at the value boundary', () => {
  it('a NUL-bearing merge value cannot hijack the raw slot', () => {
    // Unreachable from PostgreSQL TEXT, but `render` is exported from @campaign/core
    // and the API preview / test-send path builds a MergeContext from arbitrary
    // JS strings rather than exclusively from database columns.
    const out = render(
      'Hi {{contact.first_name}} <a href="{{{unsubscribe_url}}}">Unsubscribe</a>',
      { contact: { first_name: NUL_TOKEN }, unsubscribe_url: 'https://example.com/u/tok' },
      { escape: true },
    );
    expect(
      out,
      `the unsubscribe URL was relocated into the greeting; got ${JSON.stringify(out)}`,
    ).toContain('href="https://example.com/u/tok"');
  });
});
