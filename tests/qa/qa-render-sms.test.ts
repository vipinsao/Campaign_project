/**
 * QA — adversarial review of `smsSegments()`  (hypothesis 11).
 *
 * The question is always the same: does this number match what the carrier bills?
 */
import { describe, it, expect } from 'vitest';
import { smsSegments } from '@campaign/core';

describe('QA/sms — control characters (SAFE)', () => {
  it('counts LF and CR as single GSM-7 septets, not as an encoding downgrade', () => {
    // LF is 0x0A and CR is 0x0D in GSM 03.38. Both are in the basic set.
    expect(smsSegments('a\nb')).toEqual({ encoding: 'GSM-7', units: 3, segments: 1 });
    expect(smsSegments('a\rb')).toEqual({ encoding: 'GSM-7', units: 3, segments: 1 });
    expect(smsSegments('a\r\nb')).toEqual({ encoding: 'GSM-7', units: 4, segments: 1 });
  });

  it('a literal backslash-n (two characters) is two septets, not one', () => {
    // `\` is a GSM-7 EXTENDED character: escape + code = 2 septets. So the
    // two-character sequence costs 3, not 2.
    expect(smsSegments('\\n')).toEqual({ encoding: 'GSM-7', units: 3, segments: 1 });
  });
});

describe('QA/sms — combining characters and emoji (SAFE)', () => {
  it('precomposed e-acute is GSM-7; the decomposed form is UCS-2 at two units', () => {
    expect(smsSegments('\u00E9')).toEqual({ encoding: 'GSM-7', units: 1, segments: 1 });
    // 'e' + COMBINING ACUTE ACCENT. Visually identical, billed completely differently
    // — and correctly: a carrier encodes both code points in UTF-16.
    expect(smsSegments('e\u0301')).toEqual({ encoding: 'UCS-2', units: 2, segments: 1 });
  });

  it('a ZWJ family emoji costs its UTF-16 code units, which is what a carrier bills', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    expect(family.length, 'UTF-16 length of the sequence').toBe(8);
    expect(smsSegments(family)).toEqual({ encoding: 'UCS-2', units: 8, segments: 1 });
  });

  it('a single astral emoji is two units, not one character', () => {
    expect(smsSegments('\u{1F600}')).toEqual({ encoding: 'UCS-2', units: 2, segments: 1 });
  });
});

describe('QA/sms — GSM-7 escape pairs across a segment boundary (FIXED)', () => {
  /**
   * A concatenated GSM-7 segment carries 153 septets (7 go to the UDH). An extended
   * character is an ESC + code PAIR and cannot be split across a segment boundary,
   * so a segment holds at most floor(153 / 2) = 76 of them and wastes the 153rd
   * septet. `Math.ceil(units / 153)` does not know that.
   */
  it('153 euro signs bill as the 3 segments the carrier sends', () => {
    const text = '€'.repeat(153);
    const result = smsSegments(text);
    expect(result.units, '153 escape pairs = 306 septets').toBe(306);
    expect(
      result.segments,
      '76 euro signs fit per segment (152 septets); 153 needs three segments',
    ).toBe(3);
  });

  it('the single-segment boundary is counted on septets, not characters', () => {
    // 80 pairs = 160 septets exactly, and a single non-concatenated segment holds
    // 160. This one happens to be right; it is the 153-boundary that is wrong.
    expect(smsSegments('€'.repeat(80)).segments).toBe(1);
    expect(smsSegments('€'.repeat(81)).segments).toBe(2);
  });
});

describe('QA/sms — UCS-2 surrogate pairs across a segment boundary (FIXED)', () => {
  it('a surrogate pair is never split across a segment boundary', () => {
    // A concatenated UCS-2 segment carries 67 UTF-16 units. 67 is odd, and a
    // surrogate pair cannot be split across segments, so a segment made of astral
    // emoji holds 33 of them (66 units) and wastes the 67th. `ceil(units / 67)`
    // does not know that.
    const emoji = '\u{1F600}'.repeat(67); // 134 UTF-16 units
    const result = smsSegments(emoji);
    expect(result.units).toBe(134);
    expect(
      result.segments,
      '33 emoji fit per segment (66 units); 67 emoji needs three segments, not two',
    ).toBe(3);
  });
});

describe('QA/sms — GSM-7 alphabet coverage', () => {
  it('CHARACTERISATION: lowercase c-cedilla downgrades the whole message to UCS-2', () => {
    // GSM 03.38 has no lowercase c-cedilla; it maps to the uppercase code point.
    // Several providers (Twilio among them) apply that mapping and bill GSM-7.
    // This implementation does not, so a 100-character message with one 'c-cedilla'
    // is priced at two segments instead of one. Conservative, but wrong in the
    // direction that makes an operator over-estimate cost.
    expect(smsSegments('ç').encoding).toBe('UCS-2');
    expect(smsSegments('Ç').encoding).toBe('GSM-7');
  });

  it('CHARACTERISATION: form feed is a GSM-7 extended character but downgrades here', () => {
    expect(smsSegments('\f').encoding).toBe('UCS-2');
  });

  it('the documented extended set costs two septets each', () => {
    for (const ch of ['^', '{', '}', '\\', '[', '~', ']', '|', '€']) {
      expect(smsSegments(ch), `extended char ${ch}`).toEqual({
        encoding: 'GSM-7',
        units: 2,
        segments: 1,
      });
    }
  });
});
