import type { Classification, ErrorRule } from '@campaign/shared';

/**
 * Error classification as DATA  (I8).
 *
 * Everything a retry decision needs is in the table below, so the retry decision
 * itself is a lookup. The alternative -- a chain of `if (message.includes('invalid'))`
 * -- cannot be diffed in review, cannot be asserted over exhaustively, and cannot be
 * extended from real traffic by anyone who is not already fluent in the file. It is
 * also where "we retried a permanently-rejected message five times" comes from,
 * because a substring match on a paraphrased message is a coin toss.
 *
 * Two rules hold for every entry:
 *
 *  1. The `code` is the PROVIDER's own code, never a paraphrase of it. `message_queue`
 *     stores it verbatim for the same reason: forensics six months later must not
 *     depend on how a framework stringified an error object.
 *  2. `meaning` is written for the operator reading the failed-message drawer, not
 *     for the developer reading this file.
 */

/** Mapped transient codes retry up to this many times before being given up on. */
export const TRANSIENT_MAX_ATTEMPTS = 5;

/** Terminal means one attempt, ever. There is no second attempt to configure. */
export const TERMINAL_MAX_ATTEMPTS = 1;

/**
 * Unknown codes are transient, but capped hard.
 *
 * The three available defaults each fail differently, and only one fails cheaply:
 *
 *   terminal            - silently drops deliverable mail. A provider adds a code
 *                         we have never seen, and from that deploy onward every
 *                         message hitting it is destroyed with no retry. The
 *                         symptom is a quiet fall in delivery rate that nobody
 *                         attributes to a code table.
 *   unlimited transient - a retry loop burns the send budget. One provider outage
 *                         returning an unmapped 5xx and the queue spends the day
 *                         re-attempting the same thousand messages.
 *   transient, capped   - two attempts. If it was a blip the second attempt wins;
 *                         if it was permanent we have spent one extra call and the
 *                         message lands in the failed drawer with the real code
 *                         attached, which is what tells us to extend the table.
 *
 * The cap is the whole point. `classify` marks these `unmapped: true`, and the
 * caller is expected to log a warning naming provider and code, because an
 * unmapped code is a gap in this table that only real traffic can reveal.
 */
export const UNMAPPED_MAX_ATTEMPTS = 2;

/**
 * Credential, permission and account-state failures are transient-but-capped too,
 * for a different reason.
 *
 * They are genuinely unfixable by retrying -- no number of attempts makes a wrong
 * password right. But they are also not the recipient's fault, and marking them
 * terminal means a credential rotation that goes wrong for ninety seconds
 * permanently destroys every message in flight during that window. Two attempts
 * costs almost nothing and leaves the operator a queue to resume from once the
 * configuration is fixed.
 */
export const CONFIG_MAX_ATTEMPTS = 2;

export const ERROR_TABLE: readonly ErrorRule[] = [
  // -- SMTP -------------------------------------------------------------------
  // Reply codes are RFC 5321: 5xx is a permanent rejection, 4xx asks us to come
  // back later. Greylisting is why 4xx must never be treated as failure -- a
  // greylisting server rejects the first delivery from every new sender on
  // purpose and accepts the retry.
  {
    provider: 'smtp',
    code: '421',
    class: 'transient',
    meaning: 'The receiving server is not accepting mail right now (throttling or greylisting).',
  },
  {
    provider: 'smtp',
    code: '450',
    class: 'transient',
    meaning: 'Mailbox temporarily unavailable; commonly greylisting on a first delivery.',
  },
  {
    provider: 'smtp',
    code: '451',
    class: 'transient',
    meaning: 'The receiving server hit a local error while processing and asked us to retry.',
  },
  {
    provider: 'smtp',
    code: '452',
    class: 'transient',
    meaning: 'The receiving server is out of storage for this delivery.',
  },
  {
    provider: 'smtp',
    code: '454',
    class: 'transient',
    meaning: 'TLS negotiation with the receiving server failed temporarily.',
  },
  {
    provider: 'smtp',
    code: '535',
    class: 'transient',
    meaning: 'SMTP authentication was rejected. This is a credential problem, not a recipient one.',
    maxAttempts: CONFIG_MAX_ATTEMPTS,
  },
  {
    provider: 'smtp',
    code: '550',
    class: 'terminal',
    meaning: 'The recipient mailbox does not exist, or the server refused delivery permanently.',
  },
  {
    provider: 'smtp',
    code: '551',
    class: 'terminal',
    meaning: 'The recipient is not local to this server and it will not relay.',
  },
  {
    provider: 'smtp',
    code: '552',
    class: 'terminal',
    meaning: 'The recipient exceeded their permanent storage allocation.',
  },
  {
    provider: 'smtp',
    code: '553',
    class: 'terminal',
    meaning: 'The recipient address was rejected as invalid.',
  },
  {
    provider: 'smtp',
    code: '554',
    class: 'terminal',
    meaning: 'The transaction was refused outright, usually by a reputation or content filter.',
  },
  // nodemailer surfaces socket-level trouble as a string `code` rather than a
  // reply code. These describe the network, not the recipient, so they retry.
  {
    provider: 'smtp',
    code: 'ETIMEDOUT',
    class: 'transient',
    meaning: 'The connection to the SMTP server timed out.',
  },
  {
    provider: 'smtp',
    code: 'ECONNRESET',
    class: 'transient',
    meaning: 'The SMTP server closed the connection mid-conversation.',
  },
  {
    provider: 'smtp',
    code: 'ECONNREFUSED',
    class: 'transient',
    meaning: 'The SMTP server refused the connection.',
  },
  {
    provider: 'smtp',
    code: 'ESOCKET',
    class: 'transient',
    meaning: 'The TLS or socket layer failed while talking to the SMTP server.',
  },
  {
    provider: 'smtp',
    code: 'EDNS',
    class: 'transient',
    meaning: 'The SMTP host name could not be resolved.',
  },
  {
    provider: 'smtp',
    code: 'EAUTH',
    class: 'transient',
    meaning: 'SMTP authentication failed. Check the configured credentials.',
    maxAttempts: CONFIG_MAX_ATTEMPTS,
  },
  {
    provider: 'smtp',
    code: 'EENVELOPE',
    class: 'terminal',
    meaning: 'The envelope was rejected: the sender or the recipient address is not acceptable.',
  },

  // -- Postmark ---------------------------------------------------------------
  // Postmark returns its own numeric ErrorCode in the JSON body alongside an HTTP
  // status, and the two disagree often enough that only the body code is mapped
  // here. The HTTP_* entries cover the case where there is no body to read.
  {
    provider: 'postmark',
    code: '300',
    class: 'terminal',
    meaning: 'Postmark rejected the request as malformed, usually an invalid email address.',
  },
  {
    provider: 'postmark',
    code: 'InvalidEmail',
    class: 'terminal',
    meaning: 'The recipient address is not a valid email address.',
  },
  {
    provider: 'postmark',
    code: '400',
    class: 'transient',
    meaning: 'The sender signature is not registered with Postmark. A configuration fault.',
    maxAttempts: CONFIG_MAX_ATTEMPTS,
  },
  {
    provider: 'postmark',
    code: '401',
    class: 'transient',
    meaning: 'The sender signature is registered but not yet confirmed.',
    maxAttempts: CONFIG_MAX_ATTEMPTS,
  },
  {
    provider: 'postmark',
    code: '402',
    class: 'terminal',
    meaning: 'Postmark could not parse the request body. Retrying an identical body cannot help.',
  },
  {
    provider: 'postmark',
    code: '403',
    class: 'terminal',
    meaning: 'The request contained fields Postmark rejected.',
  },
  {
    provider: 'postmark',
    code: '405',
    class: 'transient',
    meaning:
      'The Postmark account is not permitted to send, usually pending approval or suspended.',
    maxAttempts: CONFIG_MAX_ATTEMPTS,
  },
  {
    provider: 'postmark',
    code: '406',
    class: 'terminal',
    meaning:
      'Postmark holds this recipient as inactive after a hard bounce or a spam complaint, and ' +
      'will not accept mail for them until they are reactivated.',
  },
  {
    provider: 'postmark',
    code: 'InactiveRecipient',
    class: 'terminal',
    meaning: 'Postmark has this recipient suppressed after a hard bounce or a spam complaint.',
  },
  {
    provider: 'postmark',
    code: '411',
    class: 'terminal',
    meaning: 'The message carried an attachment type Postmark forbids.',
  },
  {
    provider: 'postmark',
    code: '429',
    class: 'transient',
    meaning: 'Postmark rate-limited this account.',
  },
  {
    provider: 'postmark',
    code: '500',
    class: 'transient',
    meaning: 'Postmark reported an internal error.',
  },
  {
    provider: 'postmark',
    code: '503',
    class: 'transient',
    meaning: 'Postmark is temporarily unavailable.',
  },
  {
    provider: 'postmark',
    code: 'HTTP_429',
    class: 'transient',
    meaning: 'Postmark rate-limited this account.',
  },
  {
    provider: 'postmark',
    code: 'HTTP_500',
    class: 'transient',
    meaning: 'Postmark returned a server error with no usable body.',
  },
  {
    provider: 'postmark',
    code: 'HTTP_502',
    class: 'transient',
    meaning: 'A gateway between us and Postmark failed.',
  },
  {
    provider: 'postmark',
    code: 'HTTP_503',
    class: 'transient',
    meaning: 'Postmark is temporarily unavailable.',
  },
  {
    provider: 'postmark',
    code: 'HTTP_504',
    class: 'transient',
    meaning: 'The request to Postmark timed out at a gateway.',
  },
  {
    provider: 'postmark',
    code: 'ETIMEDOUT',
    class: 'transient',
    meaning: 'The request to Postmark timed out.',
  },
  {
    provider: 'postmark',
    code: 'ECONNRESET',
    class: 'transient',
    meaning: 'The connection to Postmark was reset.',
  },

  // -- Twilio -----------------------------------------------------------------
  // Twilio codes are stable, documented and five digits, which makes them the best
  // argument in this file for classification-as-data: the mapping is a fact about
  // Twilio, not a judgement about our code.
  {
    provider: 'twilio',
    code: '20003',
    class: 'transient',
    meaning: 'Twilio rejected the account credentials.',
    maxAttempts: CONFIG_MAX_ATTEMPTS,
  },
  {
    provider: 'twilio',
    code: '20429',
    class: 'transient',
    meaning: 'Twilio rate-limited this account.',
  },
  {
    provider: 'twilio',
    code: '21211',
    class: 'terminal',
    meaning: 'The destination number is not a valid phone number.',
  },
  {
    provider: 'twilio',
    code: '21212',
    class: 'transient',
    meaning:
      'The configured sending number is not valid. A configuration fault, not a recipient one.',
    maxAttempts: CONFIG_MAX_ATTEMPTS,
  },
  {
    provider: 'twilio',
    code: '21214',
    class: 'terminal',
    meaning: 'The destination number cannot be reached by any carrier route.',
  },
  {
    provider: 'twilio',
    code: '21408',
    class: 'transient',
    meaning:
      'Sending to this region is not enabled on the Twilio account; an operator has to enable it.',
    maxAttempts: CONFIG_MAX_ATTEMPTS,
  },
  {
    provider: 'twilio',
    code: '21610',
    class: 'terminal',
    meaning:
      'The recipient replied STOP. Twilio blocks this pair permanently, and so must we: ' +
      'retrying is both futile and a TCPA problem.',
  },
  {
    provider: 'twilio',
    code: '21612',
    class: 'terminal',
    meaning: 'No carrier route exists between the sending number and this destination.',
  },
  {
    provider: 'twilio',
    code: '21614',
    class: 'terminal',
    meaning: 'The destination number is not a mobile number and cannot receive SMS.',
  },
  {
    provider: 'twilio',
    code: '21617',
    class: 'terminal',
    meaning: 'The message body exceeds the maximum length Twilio accepts.',
  },
  {
    provider: 'twilio',
    code: '30001',
    class: 'transient',
    meaning: 'Twilio queue overflow; the message was not accepted for delivery.',
  },
  {
    provider: 'twilio',
    code: '30002',
    class: 'transient',
    meaning: 'The Twilio account is suspended.',
    maxAttempts: CONFIG_MAX_ATTEMPTS,
  },
  {
    provider: 'twilio',
    code: '30003',
    class: 'terminal',
    meaning: 'The destination handset is unreachable; the carrier gave up on delivery.',
  },
  {
    provider: 'twilio',
    code: '30005',
    class: 'terminal',
    meaning: 'The destination number is unknown to the carrier.',
  },
  {
    provider: 'twilio',
    code: '30006',
    class: 'terminal',
    meaning: 'The destination is a landline, or the carrier does not accept SMS for it.',
  },
  {
    provider: 'twilio',
    code: '30007',
    class: 'terminal',
    meaning:
      'The carrier filtered this message as spam. Resending the same content will be filtered again.',
  },
  {
    provider: 'twilio',
    code: '30010',
    class: 'terminal',
    meaning: 'The message price exceeded the configured maximum.',
  },
  {
    provider: 'twilio',
    code: 'HTTP_429',
    class: 'transient',
    meaning: 'Twilio rate-limited this account.',
  },
  {
    provider: 'twilio',
    code: 'HTTP_500',
    class: 'transient',
    meaning: 'Twilio returned a server error with no usable body.',
  },
  {
    provider: 'twilio',
    code: 'HTTP_502',
    class: 'transient',
    meaning: 'A gateway between us and Twilio failed.',
  },
  {
    provider: 'twilio',
    code: 'HTTP_503',
    class: 'transient',
    meaning: 'Twilio is temporarily unavailable.',
  },
  {
    provider: 'twilio',
    code: 'HTTP_504',
    class: 'transient',
    meaning: 'The request to Twilio timed out at a gateway.',
  },
  {
    provider: 'twilio',
    code: 'ETIMEDOUT',
    class: 'transient',
    meaning: 'The request to Twilio timed out.',
  },
  {
    provider: 'twilio',
    code: 'ECONNRESET',
    class: 'transient',
    meaning: 'The connection to Twilio was reset.',
  },

  // -- Mock -------------------------------------------------------------------
  // The mock provider is in this table for the same reason it writes to a real
  // outbox table: the demo has to exercise the retry path, not describe it. Its
  // simulated failures split between a terminal and a transient code so a reviewer
  // watching the queue sees both a permanently-dropped message and a retried one.
  {
    provider: 'mock',
    code: 'mock_invalid_recipient',
    class: 'terminal',
    meaning: 'Simulated permanent rejection: the recipient address was refused.',
  },
  {
    provider: 'mock',
    code: 'mock_rate_limited',
    class: 'transient',
    meaning: 'Simulated rate limiting.',
  },
  {
    provider: 'mock',
    code: 'mock_transient_failure',
    class: 'transient',
    meaning: 'Simulated temporary provider failure.',
  },
  {
    provider: 'mock',
    code: 'mock_timeout',
    class: 'transient',
    meaning: 'Simulated request timeout.',
  },
];

function indexKey(provider: string, code: string): string {
  return `${provider.trim().toLowerCase()} ${code.trim().toLowerCase()}`;
}

/**
 * Lookup index, built once at module load.
 *
 * Codes are compared case-insensitively because the same provider spells them both
 * ways across its API and its webhooks, and a case-sensitive miss here would be
 * indistinguishable from a genuinely unknown code -- which is the one outcome this
 * table exists to make visible.
 */
const INDEX: ReadonlyMap<string, ErrorRule> = new Map(
  ERROR_TABLE.map((rule) => [indexKey(rule.provider, rule.code), rule]),
);

/** The attempt ceiling a rule implies, with the class default filled in. */
export function maxAttemptsFor(rule: ErrorRule): number {
  if (rule.maxAttempts !== undefined) return rule.maxAttempts;
  return rule.class === 'terminal' ? TERMINAL_MAX_ATTEMPTS : TRANSIENT_MAX_ATTEMPTS;
}

/**
 * Classify a provider error code.
 *
 * This never throws and never returns undefined. A classifier that can fail forces
 * every call site into a second decision about what to do when classification
 * itself broke, and that decision is invariably made badly during an incident.
 */
export function classify(provider: string, code: string): Classification {
  const rule = INDEX.get(indexKey(provider, code));
  if (rule) {
    return {
      class: rule.class,
      meaning: rule.meaning,
      maxAttempts: maxAttemptsFor(rule),
      unmapped: false,
    };
  }
  return {
    class: 'transient',
    meaning:
      `Unrecognised ${provider} error code '${code}'. Treated as temporary and retried at most ` +
      `${UNMAPPED_MAX_ATTEMPTS} times. Add it to ERROR_TABLE once its meaning is known.`,
    maxAttempts: UNMAPPED_MAX_ATTEMPTS,
    unmapped: true,
  };
}

/**
 * What the retry path asks, and usually all it asks.
 *
 * `attemptsSoFar` counts attempts already made, so the message queue's `attempts`
 * column can be passed straight in.
 */
export function shouldRetry(provider: string, code: string, attemptsSoFar: number): boolean {
  const classification = classify(provider, code);
  return classification.class === 'transient' && attemptsSoFar < classification.maxAttempts;
}
