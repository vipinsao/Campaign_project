import { addSuppression, type Db } from '@campaign/core';
import type { Channel, SuppressionReason } from '@campaign/shared';

/**
 * V9 — THE MODEL CANNOT REDUCE PROTECTION.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * This is the headline invariant of the package, and it is worth being precise
 * about what it says, because the obvious version is too weak.
 *
 * The weak version is "we don't ask the model to un-suppress anyone". That is a
 * convention. Conventions survive until the afternoon somebody adds a
 * `resubscribe` label to the schema because a customer wrote back "actually keep
 * sending them", and the change looks reasonable in review, and the classifier
 * already has the consent module imported so wiring it up is one line.
 *
 * The strong version — the one implemented here — is that the classifier is never
 * handed anything that could do it. `classifier.ts` does not import
 * `@campaign/core`'s consent module at all. It receives a `ProtectionCapability`:
 * an object with exactly one method. `recordConsent` is not on it. `optOut` is not
 * on it. There is no `removeSuppression` anywhere in the codebase to expose,
 * because there is no legitimate machine-driven reason for one to exist.
 *
 * Why this and not "just be careful": the direction of the error is asymmetric in
 * a way that quality metrics do not capture.
 *
 *   A hallucinated SUPPRESSION costs a marketing email. It is annoying, it is
 *   visible, it is reversible by a human with a reason and an audit trail.
 *
 *   A hallucinated UN-suppression sends mail to somebody who said STOP. In the
 *   UK/EU that is a PECR/GDPR matter; in the US it is TCPA exposure priced per
 *   message. It is not a quality problem that a better prompt or a higher
 *   confidence threshold makes acceptable — it is a category of action the system
 *   must be incapable of taking, at 99.9% accuracy just as much as at 60%.
 *
 * So the boundary is not "the model is usually right about consent". It is "the
 * model's output is not wired to anything that can weaken a protection". A model
 * that returns {label:'positive', action:'resubscribe'} in this system produces a
 * schema violation and a row in a human review queue. It does not produce a send.
 * ═════════════════════════════════════════════════════════════════════════════
 */

/** The reason a suppression may be written for. Both arms mean "this person asked
 *  us to stop"; neither can be used to record consent. */
export type ProtectionReason = Extract<SuppressionReason, 'unsubscribe' | 'sms_stop'>;

/**
 * The ONLY consent-adjacent capability the classifier is given.
 *
 * One method, add-only. If a future feature genuinely needs the classifier to do
 * something else with consent, the change shows up here — in a file whose entire
 * purpose is this argument — rather than as an extra import buried in a 400-line
 * classifier.
 */
export type ProtectionCapability = {
  addSuppression(opts: {
    readonly tenantId: string;
    readonly channel: Channel;
    readonly address: string;
    readonly reason: ProtectionReason;
    readonly evidence?: Record<string, unknown>;
  }): Promise<void>;
};

/**
 * Narrow the full consent module down to the one safe verb.
 *
 * Note what does NOT cross this boundary: `db`. The returned object closes over
 * the pool, so the classifier cannot reach past the capability and issue its own
 * `DELETE FROM suppressions`. Handing over a `Db` alongside a "please only use
 * addSuppression" comment would be the convention again, wearing a type.
 */
export function protectionCapability(db: Db): ProtectionCapability {
  return {
    addSuppression: (opts) =>
      addSuppression(db, {
        tenantId: opts.tenantId,
        channel: opts.channel,
        address: opts.address,
        reason: opts.reason,
        evidence: opts.evidence ?? {},
      }),
  };
}

/** The reason code for an opt-out arriving on a given channel. SMS STOP and an
 *  emailed UNSUBSCRIBE are legally distinct events and are recorded as such. */
export function protectionReasonFor(channel: Channel): ProtectionReason {
  return channel === 'sms' ? 'sms_stop' : 'unsubscribe';
}
