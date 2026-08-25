import { describe, it, expect } from 'vitest';
import {
  CONFIG_MAX_ATTEMPTS,
  ERROR_TABLE,
  TERMINAL_MAX_ATTEMPTS,
  TRANSIENT_MAX_ATTEMPTS,
  UNMAPPED_MAX_ATTEMPTS,
  classify,
  maxAttemptsFor,
  shouldRetry,
} from '@campaign/providers';

/**
 * The test is table-driven because the subject is a table (I8).
 *
 * Every rule is asserted, so adding an entry to ERROR_TABLE automatically extends
 * the coverage rather than requiring somebody to remember to. A hand-picked set of
 * cases here would test the codes the author already had in mind, which are
 * precisely the codes least likely to be wrong.
 */
describe('the error classification table', () => {
  it('holds one rule per provider and code', () => {
    // A duplicate is silently shadowed by the lookup index, so the second entry's
    // classification never applies and nothing anywhere says so.
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const rule of ERROR_TABLE) {
      const key = `${rule.provider}:${rule.code.toLowerCase()}`;
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
    expect(duplicates).toEqual([]);
  });

  it('covers every provider the schema permits', () => {
    // provider_credentials.provider is CHECK-constrained to exactly these four.
    const providers = new Set(ERROR_TABLE.map((rule) => rule.provider));
    expect([...providers].sort()).toEqual(['mock', 'postmark', 'smtp', 'twilio']);
  });

  it.each(ERROR_TABLE.map((rule) => [rule.provider, rule.code, rule] as const))(
    'classifies %s/%s exactly as the table declares',
    (provider, code, rule) => {
      const classification = classify(provider, code);
      expect(classification.class).toBe(rule.class);
      expect(classification.meaning).toBe(rule.meaning);
      expect(classification.maxAttempts).toBe(maxAttemptsFor(rule));
      expect(classification.unmapped).toBe(false);
    },
  );

  it.each(ERROR_TABLE.filter((rule) => rule.class === 'terminal').map((rule) => [rule.provider, rule.code] as const))(
    'never retries the terminal code %s/%s',
    (provider, code) => {
      const classification = classify(provider, code);
      expect(classification.maxAttempts).toBe(TERMINAL_MAX_ATTEMPTS);
      // One attempt has already happened by the time anything is classified, so a
      // terminal code must refuse a retry from the very first attempt onwards.
      expect(shouldRetry(provider, code, 1)).toBe(false);
      expect(shouldRetry(provider, code, 0)).toBe(false);
    },
  );

  it.each(ERROR_TABLE.filter((rule) => rule.class === 'transient').map((rule) => [rule.provider, rule.code, rule] as const))(
    'gives the transient code %s/%s a finite retry budget',
    (provider, code, rule) => {
      const classification = classify(provider, code);
      expect(classification.maxAttempts).toBeGreaterThanOrEqual(1);
      expect(classification.maxAttempts).toBeLessThanOrEqual(TRANSIENT_MAX_ATTEMPTS);
      expect(classification.maxAttempts).toBe(rule.maxAttempts ?? TRANSIENT_MAX_ATTEMPTS);
      expect(shouldRetry(provider, code, classification.maxAttempts - 1)).toBe(true);
      expect(shouldRetry(provider, code, classification.maxAttempts)).toBe(false);
    },
  );

  it('caps credential and account failures below the transient default', () => {
    // These are operator problems, and the cap is what stops a wrong password
    // consuming a message's whole retry budget before anyone can fix it.
    expect(classify('twilio', '20003').maxAttempts).toBe(CONFIG_MAX_ATTEMPTS);
    expect(classify('smtp', 'EAUTH').maxAttempts).toBe(CONFIG_MAX_ATTEMPTS);
    expect(classify('postmark', '400').maxAttempts).toBe(CONFIG_MAX_ATTEMPTS);
  });

  it('matches codes regardless of case', () => {
    expect(classify('postmark', 'inactiverecipient').unmapped).toBe(false);
    expect(classify('POSTMARK', 'InactiveRecipient').class).toBe('terminal');
    expect(classify('smtp', ' 550 ').class).toBe('terminal');
  });

  describe('a code that is not in the table', () => {
    it('is transient, capped at two attempts, and flagged unmapped', () => {
      const classification = classify('twilio', '99999');
      expect(classification.class).toBe('transient');
      expect(classification.maxAttempts).toBe(UNMAPPED_MAX_ATTEMPTS);
      expect(classification.unmapped).toBe(true);
      // The meaning names the code so the operator's warning log is actionable
      // enough to extend the table from.
      expect(classification.meaning).toContain('99999');
      expect(classification.meaning).toContain('twilio');
    });

    it('retries once and then gives up', () => {
      expect(shouldRetry('twilio', '99999', 1)).toBe(true);
      expect(shouldRetry('twilio', '99999', 2)).toBe(false);
    });

    it('applies to an unknown provider as well as an unknown code', () => {
      const classification = classify('sendgrid', '550');
      expect(classification.unmapped).toBe(true);
      expect(classification.maxAttempts).toBe(UNMAPPED_MAX_ATTEMPTS);
    });

    it('never throws, whatever it is handed', () => {
      expect(() => classify('', '')).not.toThrow();
      expect(classify('', '').unmapped).toBe(true);
    });
  });

  it('reads terminal and transient codes for the same provider differently', () => {
    // The pairing that matters most in practice: a STOP reply must never be
    // retried, and a rate limit always must be.
    expect(classify('twilio', '21610').class).toBe('terminal');
    expect(classify('twilio', '20429').class).toBe('transient');
    expect(classify('smtp', '550').class).toBe('terminal');
    expect(classify('smtp', '450').class).toBe('transient');
    expect(classify('postmark', '406').class).toBe('terminal');
    expect(classify('postmark', '429').class).toBe('transient');
  });
});
