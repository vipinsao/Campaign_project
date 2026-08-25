/**
 * Shared setup for the V1–V10 triage suites.
 *
 * Everything here builds REAL rows through the real constraints, and tenant
 * seeding goes through tests/support/fixtures.ts rather than being reinvented —
 * a fixture that bypasses a CHECK is a fixture that tests a schema nobody has.
 *
 * Not a `.test.ts` file, so vitest does not collect it as a suite.
 */
import type { Pool } from 'pg';
import { FakeClock } from '@campaign/core';
import {
  contentHash,
  fixtureKey,
  MockModelClient,
  protectionCapability,
  syncPrompts,
  type ModelFixture,
  type PromptRecord,
  type ProtectionCapability,
  type TriageDeps,
} from '@campaign/triage';
import { seedTenant, seedContact } from '../support/fixtures.ts';

export const CLOCK_START = '2026-08-25T10:00:00.000Z';

export function fakeClock(): FakeClock {
  return new FakeClock(CLOCK_START);
}

/** A tenant with triage settings set explicitly, so a test never depends on a
 *  default it did not state. */
export async function seedTriageTenant(
  db: Pool,
  opts: { confidenceThreshold?: number; autoSend?: boolean; monthlyTokenBudget?: number } = {},
): Promise<string> {
  const tenantId = await seedTenant(db);
  await db.query(
    `UPDATE tenants
        SET confidence_threshold = COALESCE($2, confidence_threshold),
            auto_send            = COALESCE($3, auto_send),
            monthly_token_budget = COALESCE($4, monthly_token_budget)
      WHERE id = $1`,
    [
      tenantId,
      opts.confidenceThreshold ?? null,
      opts.autoSend ?? null,
      opts.monthlyTokenBudget ?? null,
    ],
  );
  return tenantId;
}

export type SeededReply = {
  id: string;
  tenantId: string;
  channel: 'email' | 'sms';
  fromAddress: string;
  body: string;
};

export async function seedReply(
  db: Pool,
  tenantId: string,
  body: string,
  opts: { channel?: 'email' | 'sms'; fromAddress?: string; contactId?: string } = {},
): Promise<SeededReply> {
  const channel = opts.channel ?? 'email';
  const fromAddress =
    opts.fromAddress ?? `replier${Math.random().toString(36).slice(2, 10)}@example.com`;
  const contactId = opts.contactId ?? (await seedContact(db, tenantId, { email: fromAddress }));
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO inbound_replies (tenant_id, contact_id, channel, from_address, body, content_hash)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [tenantId, contactId, channel, fromAddress, body, contentHash(body)],
  );
  return { id: rows[0]!.id, tenantId, channel, fromAddress, body };
}

/** The prompt versions on disk, synced into the prompts table. */
export async function syncedPrompt(db: Pool, version: number): Promise<PromptRecord> {
  const prompts = await syncPrompts(db);
  const found = prompts.find((p) => p.name === 'reply-classification' && p.version === version);
  if (!found) throw new Error(`reply-classification v${version} is not on disk`);
  return found;
}

export type ModelAnswer = {
  label?: string;
  confidence?: number;
  summary?: string;
  urgency?: string;
  entities?: unknown;
  [extra: string]: unknown;
};

/** A fixture whose payload is exactly what is passed in — including deliberately
 *  invalid shapes, which is how the V5 and V9 suites drive a schema violation. */
export function fixtureFor(
  prompt: PromptRecord,
  body: string,
  answer: ModelAnswer | string,
): Record<string, ModelFixture> {
  const raw = typeof answer === 'string' ? answer : JSON.stringify(answer);
  return {
    [fixtureKey({
      promptName: prompt.name,
      promptVersion: prompt.version,
      inputHash: contentHash(body),
    })]: {
      raw,
      modelId: 'claude-sonnet-5',
      inputTokens: 400,
      outputTokens: 60,
    },
  };
}

export function validAnswer(overrides: ModelAnswer = {}): ModelAnswer {
  return {
    label: 'question',
    confidence: 0.92,
    summary: 'The customer is asking about delivery.',
    urgency: 'low',
    entities: { order_number_mentioned: null, product_mentioned: null },
    ...overrides,
  };
}

export function mockClient(fixtures: Record<string, ModelFixture>): MockModelClient {
  return new MockModelClient({ fixtures });
}

export function triageDeps(args: {
  db: Pool;
  prompt: PromptRecord;
  model: TriageDeps['model'];
  clock?: FakeClock;
  protection?: ProtectionCapability;
}): TriageDeps {
  return {
    db: args.db,
    clock: args.clock ?? fakeClock(),
    model: args.model,
    prompt: args.prompt,
    protection: args.protection ?? protectionCapability(args.db, args.clock ?? fakeClock()),
  };
}
