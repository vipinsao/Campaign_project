/**
 * The mailbox an address actually reaches, rather than the string somebody typed.
 *
 * This exists for one caller — the `/test-send` refusal — and the distinction it
 * draws is the whole reason that endpoint is trustworthy. The refusal was an exact
 * compare against `contacts.email`, which is a normalised-in-name-only column: it
 * catches `Customer@Example.com` and misses every other spelling of the same
 * inbox. An operator testing a draft could reach a real customer through any of:
 *
 *   customer+qa@example.com      RFC 5233 subaddressing; every major provider
 *                                delivers this to `customer@example.com`
 *   c.u.s.t.o.m.e.r@gmail.com    Gmail ignores dots in the local part entirely
 *   customer@exampl<CYRILLIC E>.com
 *                                a different byte string, an identical glyph in
 *                                the operator's font
 *   +1 (202) 555-0123            the same E.164 number, punctuated
 *
 * None of these is exotic. The first two are ordinary mail features and the third
 * is the standard phishing primitive. A guard whose failure mode is "an unfinished
 * draft reached a stranger, and there is no recall" has to compare identities, not
 * strings.
 *
 * The normalisation here is deliberately AGGRESSIVE, because it is used to decide
 * whether to REFUSE. Collapsing two distinct mailboxes into one identity costs an
 * operator one rejected test send and a clear error message. Failing to collapse
 * them costs a customer an email they should never have received.
 */

/**
 * Non-ASCII characters that render as an ASCII letter in a normal UI font.
 *
 * Drawn from the Latin/Cyrillic and Latin/Greek confusable sets in Unicode UTS #39.
 * This is not the complete table — the complete table is thousands of entries and
 * most of them will never appear in an email domain. These are the ones that do.
 */
const CONFUSABLES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    // Cyrillic
    а: 'a',
    в: 'b',
    с: 'c',
    ԁ: 'd',
    е: 'e',
    ѕ: 's',
    і: 'i',
    ј: 'j',
    к: 'k',
    ӏ: 'l',
    м: 'm',
    н: 'h',
    о: 'o',
    р: 'p',
    ԛ: 'q',
    г: 'r',
    т: 't',
    у: 'y',
    х: 'x',
    ѵ: 'v',
    ѡ: 'w',
    һ: 'h',
    ә: 'a',
    ғ: 'f',
    // Greek
    α: 'a',
    β: 'b',
    ε: 'e',
    ι: 'i',
    κ: 'k',
    ο: 'o',
    ρ: 'p',
    σ: 'o',
    τ: 't',
    υ: 'u',
    χ: 'x',
    ν: 'v',
    μ: 'u',
    η: 'n',
    γ: 'y',
    ω: 'w',
    // Fullwidth and other Latin lookalikes
    '．': '.',
    '＠': '@',
    '＋': '+',
    ᴀ: 'a',
    ᴄ: 'c',
    ᴅ: 'd',
    ᴇ: 'e',
  }),
);

/** Gmail is the one provider whose dot-insensitivity is both documented and ubiquitous. */
const DOT_INSENSITIVE_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * Fold a string to its ASCII skeleton.
 *
 * NFKC first, so composed and fullwidth forms collapse on their own, then the
 * confusable table for the characters NFKC deliberately keeps distinct — a
 * Cyrillic 'е' is a different letter, not a different encoding of 'e', so no
 * amount of Unicode normalisation will turn one into the other.
 */
function skeleton(value: string): string {
  let out = '';
  for (const char of value.normalize('NFKC').toLowerCase()) {
    out += CONFUSABLES.get(char) ?? char;
  }
  return out;
}

/**
 * The identity of an email address: the mailbox it lands in.
 *
 * Returns `null` for anything that is not shaped like an address, which the caller
 * treats as "no identity to compare" rather than as a match.
 */
export function emailIdentity(address: string): string | null {
  const folded = skeleton(address.trim()).replace(/\.$/, '');
  const at = folded.lastIndexOf('@');
  if (at <= 0 || at === folded.length - 1) return null;

  const domain = folded.slice(at + 1);
  let local = folded.slice(0, at);

  // Subaddressing: everything from the first '+' is a label for the recipient's
  // own filing, and is discarded before delivery.
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  if (DOT_INSENSITIVE_DOMAINS.has(domain)) local = local.replaceAll('.', '');

  return local === '' ? null : `${local}@${domain}`;
}

/**
 * The identity of a phone number: its digits.
 *
 * `contacts.phone` is E.164 and guarded by a CHECK constraint, but the address an
 * operator types into a test-send box is not — and a guard that only matches the
 * canonical spelling is a guard that a space defeats.
 */
export function phoneIdentity(address: string): string | null {
  const digits = address.replace(/\D/g, '').replace(/^0+/, '');
  return digits.length >= 7 ? digits : null;
}

/**
 * Do two phone identities reach the same handset?
 *
 * Not `===`. An operator typing `(202) 555-0123` has given a national number with
 * no country code, and `2025550123` is not equal to the stored `12025550123` —
 * but it is the same phone, and treating them as different is exactly the class of
 * miss this guard exists to close.
 *
 * So the comparison is a suffix match with a seven-digit floor. That is
 * deliberately loose: it will occasionally refuse a test send to a number that
 * merely shares a subscriber number with a contact in another country. The
 * operator reads an error naming the contact it matched and adds the country code.
 * The alternative failure mode is an unfinished draft delivered to a customer's
 * phone, and there is no recall on an SMS.
 */
export function phoneCollides(left: string, right: string): boolean {
  if (left.length < 7 || right.length < 7) return false;
  return left === right || left.endsWith(right) || right.endsWith(left);
}

/** The identity of an address on a channel, or `null` if it has none. */
export function deliveryIdentity(address: string, channel: 'email' | 'sms'): string | null {
  return channel === 'email' ? emailIdentity(address) : phoneIdentity(address);
}
