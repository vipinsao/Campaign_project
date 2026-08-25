import type { PoolClient } from 'pg';
import type { AudienceDefinition, AudienceRule } from '@campaign/shared';
import type { Clock } from '../clock.ts';
import type { Db } from '../db/pool.ts';
import { query, queryOne } from '../db/pool.ts';
import { compileAudience, describeRule } from './compiler.ts';

/**
 * Evaluates a compiled audience against the database.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: `matches` (does this one contact qualify?)
 * and `estimate` (how many qualify?) are two evaluations of the SAME compiled
 * predicate. `estimate` runs it as a WHERE clause; `matches` runs the identical
 * predicate string with `AND c.id = $n` appended. There is no in-memory evaluator in
 * this file, and adding one would be the bug.
 *
 * The reason is not elegance. Two implementations of a predicate always drift —
 * usually on NULLs, timezone boundaries, or an operator added to one and forgotten
 * in the other — and the failure mode is specific and bad: the operator sees "12,400
 * contacts" on the review screen, presses send, and 9,000 messages go out. The count
 * was wrong, but the count was TRUSTED, which makes it worse than showing no count
 * at all. Someone who sees no estimate goes and checks. Someone who sees a confident
 * wrong number does not.
 *
 * tests/integration/audience-matches-agrees-with-estimate.test.ts pins this: 500
 * contacts, ten definitions, zero permitted disagreements.
 */

export type AudienceDb = Db | PoolClient;

export type ContactSample = {
  readonly id: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly tags: readonly string[];
};

export type AudienceMatch = {
  readonly matched: boolean;
  /** Present only on a non-match: which top-level rule turned it away, in prose. */
  readonly failedRule?: string;
};

export type AudienceEstimate = {
  readonly count: number;
  readonly sample: readonly ContactSample[];
  /** The SQL that ran, `$n` placeholders intact, for the UI disclosure. */
  readonly compiledSql: string;
  readonly params: readonly unknown[];
};

type SampleJson = {
  id: string;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  tags: string[] | null;
};

type EstimateRow = { total_count: string; sample: SampleJson[] };

type DefinitionGroups = {
  readonly all?: readonly AudienceRule[];
  readonly any?: readonly AudienceRule[];
  readonly none?: readonly AudienceRule[];
};

function toSample(row: SampleJson): ContactSample {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    firstName: row.first_name,
    lastName: row.last_name,
    tags: row.tags ?? [],
  };
}

export class AudienceResolver {
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /**
   * Does one contact qualify?
   *
   * Note what is NOT here: no row is fetched and no rule is evaluated in TypeScript.
   * The contact id is appended to the same predicate `estimate` runs, and Postgres
   * answers the question. That is the whole design.
   */
  async matches(
    db: AudienceDb,
    tenantId: string,
    contactId: string,
    audience: AudienceDefinition,
  ): Promise<AudienceMatch> {
    if (await this.#evaluate(db, tenantId, contactId, audience)) {
      return { matched: true };
    }
    return { matched: false, failedRule: await this.#explain(db, tenantId, contactId, audience) };
  }

  /**
   * How many contacts qualify, plus a sample of them.
   *
   * The count and the sample come from one statement over a single CTE, so they are
   * read from the same snapshot. Two separate queries would let a concurrent import
   * land between them and produce a sample that is not a subset of the count — small,
   * but it is precisely the sort of inconsistency that makes an operator stop
   * believing the screen.
   */
  async estimate(
    db: AudienceDb,
    tenantId: string,
    audience: AudienceDefinition,
    sampleSize = 25,
  ): Promise<AudienceEstimate> {
    const compiled = compileAudience(audience, this.#clock);
    const params: unknown[] = [...compiled.params];
    const tenant = `$${params.push(tenantId)}`;
    const limit = `$${params.push(Math.max(0, Math.trunc(sampleSize)))}`;

    const sql = [
      'WITH matched AS (',
      '  SELECT c.id, c.email, c.phone, c.first_name, c.last_name, c.tags, c.created_at',
      '    FROM contacts c',
      `   WHERE c.tenant_id = ${tenant}`,
      `     AND (${compiled.sql})`,
      ')',
      'SELECT (SELECT count(*) FROM matched) AS total_count,',
      '       COALESCE((',
      "         SELECT jsonb_agg(to_jsonb(s) - 'created_at' ORDER BY s.created_at DESC, s.id)",
      `           FROM (SELECT * FROM matched ORDER BY created_at DESC, id LIMIT ${limit}) s`,
      "       ), '[]'::jsonb) AS sample",
    ].join('\n');

    const row = await queryOne<EstimateRow>(db, sql, params);
    return {
      count: Number(row?.total_count ?? 0),
      sample: (row?.sample ?? []).map(toSample),
      compiledSql: sql,
      params,
    };
  }

  /** The one predicate, scoped to a tenant and narrowed to a single contact. */
  async #evaluate(
    db: AudienceDb,
    tenantId: string,
    contactId: string,
    audience: AudienceDefinition,
  ): Promise<boolean> {
    const compiled = compileAudience(audience, this.#clock);
    const params: unknown[] = [...compiled.params];
    const tenant = `$${params.push(tenantId)}`;
    const contact = `$${params.push(contactId)}`;
    const rows = await query<{ one: number }>(
      db,
      `SELECT 1 AS one FROM contacts c` +
        ` WHERE c.tenant_id = ${tenant} AND (${compiled.sql}) AND c.id = ${contact} LIMIT 1`,
      params,
    );
    return rows.length > 0;
  }

  /**
   * Why did this contact not qualify?
   *
   * The cost is one query per top-level rule, worst case, on top of the one that
   * already said no. That is deliberate: this path runs when a human has clicked
   * "why was this contact skipped?" on a single contact, never in the send loop,
   * where the answer is a boolean nobody reads. Paying O(rules) round trips to turn
   * "did not match" into "last_order_at not_within_days 30" is the difference
   * between a support ticket and a self-service answer, and the alternative —
   * decomposing the predicate into per-rule columns in one query — would be a second
   * SQL builder to keep in step with the first, which is the exact mistake the top
   * of this file is about.
   */
  async #explain(
    db: AudienceDb,
    tenantId: string,
    contactId: string,
    audience: AudienceDefinition,
  ): Promise<string> {
    const exists = await query<{ one: number }>(
      db,
      'SELECT 1 AS one FROM contacts c WHERE c.tenant_id = $1 AND c.id = $2 LIMIT 1',
      [tenantId, contactId],
    );
    if (exists.length === 0) {
      // Distinguished from a rule failure on purpose: a caller passing a contact
      // from another tenant would otherwise read "no rule matched" and go hunting
      // through the segment for a bug that is in the caller.
      return 'contact does not exist in this tenant';
    }

    const groups = audience as DefinitionGroups;

    for (const rule of groups.all ?? []) {
      if (!(await this.#evaluate(db, tenantId, contactId, { all: [rule] }))) {
        return describeRule(rule);
      }
    }

    if (groups.any !== undefined && groups.any.length > 0) {
      if (!(await this.#evaluate(db, tenantId, contactId, { any: [...groups.any] }))) {
        return `no rule in 'any' matched: ${groups.any.map((r) => describeRule(r)).join('; ')}`;
      }
    }

    for (const rule of groups.none ?? []) {
      if (await this.#evaluate(db, tenantId, contactId, { all: [rule] })) {
        return `excluded by 'none': ${describeRule(rule)}`;
      }
    }

    // Reachable only if the contact was deleted or edited between the two queries.
    return 'no single top-level rule failed; the contact changed while it was being explained';
  }
}
