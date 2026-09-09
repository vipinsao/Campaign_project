/**
 * ATTACK: I7 — "marketing mail without a working opt-out is not sendable" — as an
 * HTTP-layer property rather than a unit-tested pure function.
 *
 * `validateTemplate` carries I7 and tests/unit/template-renderer.test.ts proves the
 * function is right. That is not the same claim as "no HTTP request can leave this
 * system holding a live marketing message with no opt-out", which is the claim that
 * matters. The function is only load-bearing where it is CALLED, so this file walks
 * every route that can write `campaign_messages.body_template` or change
 * `campaigns.category` and asks each one the same question.
 *
 * The canvas (`PUT /campaigns/:id/flow`) is the newest of them and the one flow.ts
 * explicitly says must not "become a way to smuggle a marketing message with no
 * opt-out past the check". It is not. The older, plainer editor routes next to it
 * are.
 *
 * Why the DB row is what gets asserted: enrolment renders from live
 * `campaign_messages` (packages/core/src/triggers/enrolment.ts reads
 * `WHERE campaign_id = $1 AND is_enabled`), NOT from the activation snapshot in
 * `campaign_versions`. A row that is in that table with no opt-out is a message
 * that goes out with no opt-out.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import type { App } from '@campaign/api';
import { bootApp, seedWorld, authHeaders, type World } from './qa-sec-helpers.ts';

let app: App;
let a: World;

afterAll(closeTestDb);
beforeAll(resetDb);

beforeEach(async () => {
  await resetDb();
  app = bootApp();
  a = await seedWorld(app, 'Alpha');
});

const asA = () => authHeaders(a.token);

/** No opt-out merge field anywhere in it. This is the payload for the whole file. */
const NO_OPT_OUT = 'Half price this weekend only. Hi {{contact.first_name}}!';

async function createCampaign(category: string): Promise<string> {
  const response = await app.request('/campaigns', {
    method: 'POST',
    headers: asA(),
    body: JSON.stringify({ name: `${category} campaign`, category, triggerType: 'manual' }),
  });
  if (response.status !== 201) throw new Error(`create failed: ${response.status}`);
  return ((await response.json()) as { campaign: { id: string } }).campaign.id;
}

async function addMessage(campaignId: string, bodyTemplate: string): Promise<Response> {
  return app.request(`/campaigns/${campaignId}/messages`, {
    method: 'POST',
    headers: asA(),
    body: JSON.stringify({
      channel: 'email',
      sequenceOrder: 1,
      subjectTemplate: 'Sale',
      bodyTemplate,
    }),
  });
}

async function putFlow(
  campaignId: string,
  body: string,
  channel: 'email' | 'sms' = 'email',
): Promise<Response> {
  const node =
    channel === 'email'
      ? { id: 'm1', type: 'send_email', data: { subject: 'Sale', body, previewText: 'p' } }
      : { id: 'm1', type: 'send_sms', data: { body } };
  return app.request(`/campaigns/${campaignId}/flow`, {
    method: 'PUT',
    headers: asA(),
    body: JSON.stringify({
      flow: {
        nodes: [{ id: 't', type: 'trigger' }, node],
        edges: [{ id: 'e0', source: 't', target: 'm1' }],
      },
    }),
  });
}

/** Every live body template for a campaign, as the send path would read them. */
async function liveBodies(campaignId: string): Promise<string[]> {
  const { rows } = await testDb().query<{ body_template: string }>(
    `SELECT body_template FROM campaign_messages WHERE campaign_id = $1 AND is_enabled`,
    [campaignId],
  );
  return rows.map((r) => r.body_template);
}

describe('the canvas is NOT a way around I7', () => {
  it('refuses a promotional email node with no opt-out, and writes nothing', async () => {
    const campaignId = await createCampaign('promotional');
    const response = await putFlow(campaignId, NO_OPT_OUT);

    expect(response.status, await response.clone().text()).toBe(400);
    const body = (await response.json()) as {
      error: { code: string; details?: { issues?: { nodeId: string; message: string }[] } };
    };
    expect(body.error.code).toBe('flow_invalid');
    expect(JSON.stringify(body.error.details)).toMatch(/unsubscribe_url|preferences_url/);

    expect(await liveBodies(campaignId)).toEqual([]);
    const { rows } = await testDb().query<{ flow_definition: unknown }>(
      `SELECT flow_definition FROM campaigns WHERE id = $1`,
      [campaignId],
    );
    expect(rows[0]!.flow_definition, 'the rejected graph must not be stored either').toBeNull();
  });

  it('refuses it on the SMS channel too, where the footer excuse does not exist', async () => {
    const campaignId = await createCampaign('promotional');
    const response = await putFlow(campaignId, 'Sale today!', 'sms');
    expect(response.status).toBe(400);
    expect(await liveBodies(campaignId)).toEqual([]);
  });

  it('refuses it for `lifecycle` as well — MARKETING_CATEGORIES is two entries, not one', async () => {
    const campaignId = await createCampaign('lifecycle');
    expect((await putFlow(campaignId, NO_OPT_OUT)).status).toBe(400);
    expect(await liveBodies(campaignId)).toEqual([]);
  });

  it('accepts preferences_url as the alternative, and only then writes the row', async () => {
    const campaignId = await createCampaign('promotional');
    const response = await putFlow(campaignId, `Sale. {{preferences_url}}`);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await liveBodies(campaignId)).toHaveLength(1);
  });

  it('still refuses when only ONE node of several omits the opt-out', async () => {
    // The interesting failure would be a validator that checks the first message
    // and stops, so the second box on the canvas is the one that goes out naked.
    const campaignId = await createCampaign('promotional');
    const response = await app.request(`/campaigns/${campaignId}/flow`, {
      method: 'PUT',
      headers: asA(),
      body: JSON.stringify({
        flow: {
          nodes: [
            { id: 't', type: 'trigger' },
            {
              id: 'm1',
              type: 'send_email',
              data: { subject: 'A', body: 'Fine. {{unsubscribe_url}}' },
            },
            { id: 'm2', type: 'send_email', data: { subject: 'B', body: NO_OPT_OUT } },
          ],
          edges: [
            { id: 'e0', source: 't', target: 'm1' },
            { id: 'e1', source: 'm1', target: 'm2' },
          ],
        },
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { details?: { issues?: { nodeId: string }[] } };
    };
    expect(body.error.details?.issues?.map((i) => i.nodeId)).toContain('m2');
    expect(
      await liveBodies(campaignId),
      'a partial write would leave m1 live and m2 missing',
    ).toEqual([]);
  });
});

describe('the routes NEXT to the canvas, which write the same column', () => {
  it('POST /campaigns/:id/messages accepts a promotional message with no opt-out', async () => {
    // Same tenant, same campaign, same column, same invariant — and no call to
    // validateTemplate anywhere in the handler. The advisory endpoint below proves
    // the system knows the template is illegal; the writer simply never asks.
    const campaignId = await createCampaign('promotional');

    const advisory = (await (
      await app.request('/templates/validate', {
        method: 'POST',
        headers: asA(),
        body: JSON.stringify({
          channel: 'email',
          category: 'promotional',
          subjectTemplate: 'Sale',
          bodyTemplate: NO_OPT_OUT,
        }),
      })
    ).json()) as { ok: boolean; errors: { message: string }[] };
    expect(advisory.ok, '/templates/validate agrees this template is not sendable').toBe(false);

    const response = await addMessage(campaignId, NO_OPT_OUT);
    expect(
      { status: response.status, liveBodies: await liveBodies(campaignId) },
      'the canvas refuses this exact template; the message editor stores it',
    ).toEqual({ status: 422, liveBodies: [] });
  });

  it('PATCH /campaigns/:id/messages/:messageId strips the opt-out out of a LIVE campaign', async () => {
    // The full operator sequence, all of it through the public API:
    //   1. build a compliant promotional campaign
    //   2. activate it — the activation gate runs validateTemplate and passes
    //   3. edit the copy, removing the opt-out
    // Step 3 is a 200 and there is no step that re-validates. The campaign is now
    // active, marketing, and enrolling contacts against a template with no way out.
    const campaignId = await createCampaign('promotional');
    const created = await addMessage(campaignId, `Sale. {{unsubscribe_url}}`);
    expect(created.status).toBe(201);
    const messageId = ((await created.json()) as { message: { id: string } }).message.id;

    const activated = await app.request(`/campaigns/${campaignId}/activate`, {
      method: 'POST',
      headers: asA(),
    });
    expect(activated.status, await activated.clone().text()).toBe(200);

    const patched = await app.request(`/campaigns/${campaignId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: asA(),
      body: JSON.stringify({ bodyTemplate: NO_OPT_OUT }),
    });
    expect(
      { patchAccepted: patched.status, liveBodies: await liveBodies(campaignId) },
      'the live row the enrolment renderer reads on the next send now has no opt-out',
    ).toEqual({ patchAccepted: 422, liveBodies: [`Sale. {{unsubscribe_url}}`] });
  });

  it('PATCH /campaigns/:id turns a live transactional campaign into a marketing one with no re-check', async () => {
    // `category` decides whether I7 applies at all, and it is a plain COALESCE in
    // the UPDATE with no validation in front of it. A transactional campaign has no
    // opt-out obligation, so it activates happily; flipping the category afterwards
    // moves the same live messages under the marketing rule without anything
    // looking at them again.
    const campaignId = await createCampaign('transactional');
    expect((await addMessage(campaignId, NO_OPT_OUT)).status).toBe(201);
    expect(
      (await app.request(`/campaigns/${campaignId}/activate`, { method: 'POST', headers: asA() }))
        .status,
    ).toBe(200);

    const patched = await app.request(`/campaigns/${campaignId}`, {
      method: 'PATCH',
      headers: asA(),
      body: JSON.stringify({ category: 'promotional' }),
    });

    // The proof that the resulting state is one the system itself rejects: ask the
    // activation gate to produce it, and it refuses — 422, on the campaign it is
    // already running.
    const reactivate = await app.request(`/campaigns/${campaignId}/activate`, {
      method: 'POST',
      headers: asA(),
    });
    const { rows } = await testDb().query<{ status: string; category: string }>(
      `SELECT status, category FROM campaigns WHERE id = $1`,
      [campaignId],
    );

    expect(
      {
        patchAccepted: patched.status,
        liveState: `${rows[0]!.status}/${rows[0]!.category}`,
        liveBodies: await liveBodies(campaignId),
        activateWouldSay: reactivate.status,
      },
      'PATCH created a live active/promotional campaign whose own activation gate says 422',
    ).toEqual({
      patchAccepted: 422,
      liveState: 'active/transactional',
      liveBodies: [NO_OPT_OUT],
      activateWouldSay: 200,
    });
  });
});
