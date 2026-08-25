# Failure taxonomy — reply classification

Dataset version: `24-cases`
Traces open-coded: 24
Errors grouped: 18

Derived by open coding real traces (free-text notes, no fixed vocabulary), then
axial coding those notes into the groups below. This file is an OUTPUT of that
process. It was not written in advance, which is the point: a taxonomy invented
up front only contains the failures we had already thought of, and those are the
ones already handled.

| # | Failure mode | Traces | Share of errors | Definition |
|---|---|---:|---:|---|
| 1 | Complaint phrased as a question | 3 | 17% | A problem written politely as a question was labelled `question`, so it never reached the escalation queue. |
| 2 | Terse, unpunctuated replies | 3 | 17% | Short lowercase replies with no punctuation were swept into `other` regardless of content. |
| 3 | Model attempting identity or arithmetic | 3 | 17% | The model tried to resolve an order number, compute a refund total or work out a date — all of which are deterministic and are never the model’s job. |
| 4 | Opt-out keyword inside prose | 2 | 11% | A carrier keyword (STOP, CANCEL, END) appears mid-sentence with a different meaning — "cancel my order" is not "cancel my subscription". |
| 5 | Machine-generated replies | 2 | 11% | Out-of-office notices, bounce notifications and autoresponders classified from their body text as if a person wrote them. |
| 6 | Category-scoped opt-out | 2 | 11% | The customer wants to leave one category, not the address. Suppression is address-level, so this must reach a human rather than an automatic suppression. |
| 7 | Quoted-text bleed | 1 | 6% | The reply quotes the original message and the classification came from the quoted text rather than the words the customer wrote. |
| 8 | Negation blindness | 1 | 6% | A literal keyword ("no complaints at all") outweighed the negation that reversed it. |
| 9 | Two topics in one reply | 1 | 6% | The second issue in a multi-topic reply was dropped; only the first sentence was classified. |

## How this drives the golden set

Cases are drawn per failure mode in proportion to the share above, so the golden
set has the same shape as the errors actually observed. A set that is uniform
across modes over-weights the rare ones and reports a regression in the common
one as a rounding error.
