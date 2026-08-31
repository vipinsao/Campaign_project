/**
 * The closed vocabulary of the decision log  (I14).
 *
 * Every enqueue and every skip writes a send_decisions row carrying one of these
 * codes. The point of a closed set is that an operator asking "why didn't Jane get
 * the review request?" gets an answer that is specific enough to act on, and that
 * the UI can render without a lookup table maintained by hand somewhere else.
 *
 * `'error'` is not a reason code. `'failed'` is not a reason code. If a new skip
 * path appears, it gets a new entry here — which is a deliberate speed bump,
 * because the alternative is a decision log full of strings nobody can group by.
 */
export const REASON_CODES = {
  // ── proceed ──────────────────────────────────────────────────────────────
  enqueued: 'Message queued for delivery.',
  sent: 'Handed to the provider successfully.',
  observe_mode_no_enqueue:
    'Campaign is in observe mode: the decision was evaluated and logged, but nothing was queued.',

  // ── trigger / audience / enrolment ───────────────────────────────────────
  audience_mismatch: 'Contact did not match the campaign audience.',
  one_time_per_contact: 'Campaign sends at most once per contact, and this contact has had it.',
  already_enrolled: 'An enrolment already exists for this contact and anchor.',
  duplicate_suppressed: 'An identical message is already queued (deduplicated by the database).',
  recipient_ambiguous:
    'The order number matched more than one order, so no recipient could be resolved safely.',
  recipient_not_found: 'No contact could be resolved for this event.',
  trigger_floor_not_set:
    'The time-trigger cutoff floor is unset, so the job failed closed and enrolled nobody.',
  trigger_floor_excluded: 'Anchor predates the time-trigger cutoff floor.',
  trigger_circuit_breaker:
    'Candidate count exceeded the per-run ceiling, so nobody was enrolled and the list was logged.',
  trigger_dry_run: 'Trigger is in dry-run: evaluated and logged, nothing queued.',

  // ── send-time gates (I1) ─────────────────────────────────────────────────
  campaign_not_active: 'Campaign was paused or archived after this message was queued.',
  enrollment_stopped: 'A stop condition ended this contact’s journey before the message sent.',
  consent_opted_out: 'Contact has opted out of this channel and category.',
  consent_never_given: 'No opt-in on record for this channel and category.',
  consent_paused: 'Contact paused messages on this channel.',
  consent_test_recipient:
    'Internal test recipient: the consent gate was exempted on purpose, not satisfied.',
  suppressed_unsubscribe: 'Address is suppressed: unsubscribed.',
  suppressed_sms_stop: 'Address is suppressed: STOP reply received.',
  suppressed_hard_bounce: 'Address is suppressed: hard bounce.',
  suppressed_complaint: 'Address is suppressed: spam complaint.',
  suppressed_manual: 'Address is suppressed: added manually by an operator.',
  suppressed_invalid: 'Address is suppressed: not a valid destination.',
  quiet_hours_deferred: 'Outside the recipient’s local sending window; deferred.',
  campaign_window_unsatisfiable:
    'The campaign’s send window does not overlap the tenant’s quiet-hours floor, so no send time exists. Fix the campaign schedule.',
  frequency_cap: 'Contact has already received the maximum messages for this channel and window.',
  no_recipient_address: 'Contact has no usable address on this channel.',
  send_condition_unmet: 'The message’s send condition was not satisfied at send time.',
  delivery_anchor_expired:
    'The order was never delivered within the anchor wait limit, so the message was cancelled.',

  // ── delivery outcomes (I8) ───────────────────────────────────────────────
  provider_terminal_error: 'The provider rejected the message permanently; it will not be retried.',
  provider_transient_error: 'The provider failed temporarily; the message will be retried.',
  retry_exhausted: 'Retry attempts exhausted.',
  stale_claim_exhausted: 'The message was reclaimed too many times without completing.',

  claim_lost:
    'The claim on this message was lost between the gate chain and the send, so it was not handed to the provider. Another worker or a cancellation took it.',
  internal_error:
    'The message could not be evaluated because of an unexpected error. The error is recorded against this decision.',

  // ── environment (I2) ─────────────────────────────────────────────────────
  worker_not_permitted_to_send:
    'This worker is not permitted to send (SEND_MODE is not live), so no row was claimed.',
} as const;

export type ReasonCode = keyof typeof REASON_CODES;

export function reasonSentence(code: ReasonCode): string {
  return REASON_CODES[code];
}

/** Suppression reasons map onto decision reason codes one-for-one. */
export const SUPPRESSION_REASON_CODE = {
  unsubscribe: 'suppressed_unsubscribe',
  sms_stop: 'suppressed_sms_stop',
  hard_bounce: 'suppressed_hard_bounce',
  complaint: 'suppressed_complaint',
  manual: 'suppressed_manual',
  invalid: 'suppressed_invalid',
} as const satisfies Record<string, ReasonCode>;
