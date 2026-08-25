# ADR-001 — PostgreSQL is the queue

**Status:** accepted · 2026-08-25

## Decision

The message queue is a PostgreSQL table claimed with `SELECT … FOR UPDATE SKIP
LOCKED` inside a transaction. There is no Redis and no broker.

## Why

**Transactional enqueue.** A message can be queued in the same transaction as the
business write that caused it. If the enrolment rolls back, so does the message. A
separate broker cannot do that without an outbox table and a relay process — which
is more moving parts than the queue itself, introduced to recover a property
Postgres already had.

**One fewer operational dependency.** A broker is a thing to provision, monitor,
back up, upgrade and page someone about. At the scale this system is designed for,
that cost is not repaid.

**`SKIP LOCKED` gives real concurrency.** Rows locked by another worker are skipped
rather than waited on, so N workers make progress on disjoint sets. The alternative
some systems reach for — read a batch, then compare-and-swap each row — has a
window between the read and the swap in which two workers both believe they own the
row. `SKIP LOCKED` closes that window in the lock manager, where it belongs.

## What it costs

Stated plainly, because a decision without a cost is a preference:

- **No fan-out.** One message, one consumer. Broadcasting to several independent
  subscribers means writing that yourself.
- **No cross-region replication** of the queue.
- **A throughput ceiling.** `batchSize × (60 / pollSeconds)` per worker. At the
  defaults — 100 rows, every 60 seconds — that is 100 messages/minute/worker, and
  the practical ceiling on modest hardware is in the **low thousands per minute**
  across all workers before claim contention and WAL volume start to dominate.

## When I would move

Three thresholds, any one of which is sufficient:

1. **Sustained above ~5,000 messages/minute.** Below that, more worker replicas is
   the cheaper answer and the `SKIP LOCKED` design already supports it correctly.
2. **A second independent consumer of the same events.** The moment something other
   than the sender needs each message, a queue table is being used as a topic and a
   broker is the right shape.
3. **Multi-region delivery** with regional workers.

The migration path is an outbox: keep the transactional write to Postgres, add a
relay that publishes to the broker. That preserves the property this decision was
made for while adding the fan-out it lacks.

## What I would not do

Reach for a broker *before* any of those thresholds because it is the conventional
answer. The conventional answer costs an operational dependency and buys nothing
measurable here, and "we might need it later" is how a system acquires
infrastructure nobody can explain.
