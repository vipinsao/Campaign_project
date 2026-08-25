# ADR-003 — Consent is a ledger, not a boolean

**Status:** accepted · 2026-08-25

## Decision

Consent is an append-only table of state changes (`contact_consents`), and
suppression is a separate address-level list (`suppressions`). Neither is a boolean
column on the contact row. The database refuses `UPDATE` and `DELETE` on the ledger
via a trigger.

## Why a ledger

A boolean answers "are they opted in?" and nothing else. The questions that actually
get asked are:

- *Were they opted in on 4 March?*
- *Where did that consent come from — signup, checkout, an import?*
- *What is the evidence? Which IP, which user agent, which message carried the link?*
- *They say they never subscribed. Can we show otherwise?*

An `UPDATE` to a boolean destroys the only evidence the previous state ever existed.
The ledger answers all four from one indexed table, and the append-only trigger
means one well-meaning data-fix script cannot erase the history.

## Why suppression is separate, and address-level

Suppressing the *contact row* is not enough. Contacts get merged, re-imported and
duplicated, and every one of those operations is a chance to resurrect an address
somebody asked never to be contacted on again. Suppressing the **address** survives
all of it.

The two are related but not the same fact:

- `contact_consents` — what this *person* told us, when, and how we know.
- `suppressions` — whether this *address* is off limits right now.

A category-scoped opt-out ("stop sending me promotions") writes a ledger row and
**no** suppression, because the address is still contactable. A full opt-out writes
both.

## The precedence rule

A contact can hold `('*', opted_out, Tuesday)` and `('promotional', opted_in,
Wednesday)` simultaneously. **Most recent intent wins, treating wildcard and
category-specific rows as one timeline**, resolved in a SQL function so the send
gate and the analytics queries cannot drift apart.

The product promises a preference centre where someone can drop one category
instead of all mail. That promise is only honest if the later, narrower choice
actually takes effect. Resolving wildcard-always-wins would make the per-category
toggles decorative, which is worse than not offering them.

## What it costs

A read is a `DISTINCT ON` over an indexed history rather than a column fetch, and
the table grows without bound. Both are acceptable: the index makes the read fast
enough, and an audit trail that gets deleted is not an audit trail.
