import type { Clock } from '@campaign/core';
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
 * The version implemented here narrows what the classifier is HANDED: a
 * `ProtectionCapability` with exactly one method. `recordConsent` is not on it,
 * `optOut` is not on it, and there is no `removeSuppression` function to put on
 * it — though `DELETE FROM suppressions` does exist, spelled inline, in
 * `api/routes/suppressions.ts`, `api/routes/public.ts` and `worker/jobs/index.ts`.
 * Those are operator- and job-driven paths; none is reachable from a model output.
 *
 * Be precise about what this does and does not prove, because an overstated
 * guarantee is worse than an honest narrow one:
 *
 *   WHAT HOLDS. `protection.addSuppression` is called from exactly ONE place in
 *   classifier.ts, behind `decidedBy === 'deterministic' && label === 'opt_out'`.
 *   The model's label is not an input to that branch. An adversarial review drove
 *   hostile payloads — `resubscribe: true`, `suppression: {action: 'remove'}`,
 *   SQL in the extracted fields — through the first-call, repair-retry, cache-hit
 *   and escalation branches at confidence 1.0, and none of them reached anything
 *   that removes, weakens or shortens a suppression.
 *
 *   WHAT DOES NOT. This is not a capability system. `TriageDeps.db` is a full
 *   unrestricted pool sitting in the adjacent field of the same object, and the
 *   classifier uses it on every path. A future edit to classifier.ts could issue
 *   any statement it likes. The guarantee is one guarded call site plus the tests
 *   that pin it — strong in practice, and not enforced by the compiler.
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
 * The returned object closes over the pool rather than exposing it, so nothing
 * reachable THROUGH THIS OBJECT can issue a `DELETE FROM suppressions`.
 *
 * That is a real narrowing and it is not a sandbox: the classifier also receives
 * `TriageDeps.db`, an unrestricted pool, because it has to write classifications
 * and read the cache. Removing that would mean routing every triage write through
 * a capability too, which is the honest next step and is not done here. What this
 * type buys is that the CONSENT surface is one add-only verb, so a change that
 * weakened protection could not be a one-line wiring change — it would have to
 * add a statement, in a diff, that a reviewer would see.
 */
export function protectionCapability(db: Db, clock: Clock): ProtectionCapability {
  return {
    addSuppression: (opts) =>
      addSuppression(db, {
        clock,
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
