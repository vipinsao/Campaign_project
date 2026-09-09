/**
 * ATTACK: PUT /campaigns/:id/flow takes an arbitrary graph.
 *
 * The route accepts operator-supplied STRUCTURE and compiles it into rows the send
 * path executes, inside one transaction, with `validateFlow` as the only gate. The
 * questions worth asking of a compiler behind an HTTP endpoint are: does it reject
 * the shapes it promises to reject, does it stay inside the caller's own campaign,
 * and does a hostile SIZE cost the server more than it costs the caller.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import type { App } from '@campaign/api';
import { bootApp, seedWorld, authHeaders, type World } from './qa-sec-helpers.ts';

let app: App;
let a: World;
let b: World;

afterAll(closeTestDb);
beforeAll(resetDb);

beforeEach(async () => {
  await resetDb();
  app = bootApp();
  a = await seedWorld(app, 'Alpha');
  b = await seedWorld(app, 'Beta');
});

const asA = () => authHeaders(a.token);

const emailNode = (id: string) => ({
  id,
  type: 'send_email',
  data: { subject: 'Hi', body: 'Body {{unsubscribe_url}}', previewText: 'preview' },
});

/** A campaign with NO existing messages, so a save exercises the writer cleanly. */
async function blankCampaign(): Promise<string> {
  const response = await app.request('/campaigns', {
    method: 'POST',
    headers: asA(),
    body: JSON.stringify({ name: 'blank', category: 'lifecycle', triggerType: 'manual' }),
  });
  const body = (await response.json()) as { campaign: { id: string } };
  return body.campaign.id;
}

async function put(campaignId: string, flow: unknown): Promise<Response> {
  return await app.request(`/campaigns/${campaignId}/flow`, {
    method: 'PUT',
    headers: asA(),
    body: JSON.stringify({ flow }),
  });
}

describe('the graph validator', () => {
  it('rejects a cycle', async () => {
    const flow = {
      nodes: [{ id: 't', type: 'trigger' }, emailNode('m1'), emailNode('m2')],
      edges: [
        { id: 'e0', source: 't', target: 'm1' },
        { id: 'e1', source: 'm1', target: 'm2' },
        { id: 'e2', source: 'm2', target: 'm1' },
      ],
    };
    const response = await put(a.campaignId, flow);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('flow_invalid');
  });

  it('treats a node id carrying SQL as data, not as SQL', async () => {
    const hostile = "n1'); DROP TABLE campaign_messages; --";
    const flow = {
      nodes: [{ id: 't', type: 'trigger' }, emailNode(hostile)],
      edges: [{ id: 'e0', source: 't', target: hostile }],
    };
    const campaignId = await blankCampaign();
    const response = await put(campaignId, flow);
    expect(response.status, await response.clone().text()).toBe(200);

    const { rows } = await testDb().query<{ node_id: string }>(
      `SELECT node_id FROM campaign_messages WHERE campaign_id = $1 AND node_id = $2`,
      [campaignId, hostile],
    );
    expect(rows.length).toBe(1);
    const { rows: alive } = await testDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM campaign_messages`,
    );
    expect(Number(alive[0]!.n)).toBeGreaterThan(0);
  });

  it("does not let a node id collide with another campaign's node_id", async () => {
    // B's seeded message already carries node_id 'node-beta'. UNIQUE is
    // (campaign_id, node_id), so reusing the name must create A's own row and
    // leave B's untouched.
    const flow = {
      nodes: [{ id: 't', type: 'trigger' }, emailNode('node-beta')],
      edges: [{ id: 'e0', source: 't', target: 'node-beta' }],
    };
    const campaignId = await blankCampaign();
    expect((await put(campaignId, flow)).status).toBe(200);

    const { rows } = await testDb().query<{ id: string; campaign_id: string }>(
      `SELECT id, campaign_id FROM campaign_messages WHERE node_id = 'node-beta'`,
    );
    expect(rows.length, "A got its own row; B's was not adopted or overwritten").toBe(2);
    expect(rows.some((r) => r.id === b.campaignMessageId && r.campaign_id === b.campaignId)).toBe(
      true,
    );
  });
});

describe('shapes the validator accepts and the writer cannot store', () => {
  it('does not 500 when linearisation emits the same node twice', async () => {
    // A rejoin: both branches of the condition lead to the SAME send node. There is
    // no cycle, nothing is unreachable, so validateFlow says valid — and
    // lineariseFlow's documented "rejoin produces that node's messages twice"
    // then hands planMessageSync two creates with one node_id, against a
    // UNIQUE (campaign_id, node_id).
    const flow = {
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'cond', type: 'condition', data: { condition: 'opened_previous' } },
        emailNode('shared'),
      ],
      edges: [
        { id: 'e0', source: 't', target: 'cond' },
        { id: 'e1', source: 'cond', target: 'shared', sourceHandle: 'yes' },
        { id: 'e2', source: 'cond', target: 'shared', sourceHandle: 'no' },
      ],
    };
    const validation = await app.request('/flow/validate', {
      method: 'POST',
      headers: asA(),
      body: JSON.stringify({ flow }),
    });
    const validated = (await validation.json()) as {
      validation: { valid: boolean };
      preview: { nodeId: string }[];
    };
    expect(validated.validation.valid, 'the validator accepts this graph').toBe(true);
    expect(validated.preview.map((m) => m.nodeId)).toEqual(['shared', 'shared']);

    const campaignId = await blankCampaign();
    const response = await put(campaignId, flow);
    expect(
      response.status,
      'a graph the validator accepted must not be refused by the writer',
    ).toBe(200);
  });
});

describe('hostile size', () => {
  it('does not blow the stack on a long chain', async () => {
    // findCycle recurses once per node along a path. A 10,000-node chain is a
    // 10,000-frame recursion, and RangeError is not an ApiError.
    const N = 10_000;
    const nodes: unknown[] = [{ id: 'n0', type: 'trigger' }, emailNode('m')];
    const edges: unknown[] = [{ id: 'e-m', source: `n${N - 1}`, target: 'm' }];
    for (let i = 1; i < N; i += 1) {
      nodes.push({ id: `n${i}`, type: 'delay', data: { delayMinutes: 1 } });
      edges.push({ id: `e${i}`, source: `n${i - 1}`, target: `n${i}` });
    }

    const response = await app.request('/flow/validate', {
      method: 'POST',
      headers: asA(),
      body: JSON.stringify({ flow: { nodes, edges } }),
    });
    expect(
      response.status,
      'a 10k-node chain should be rejected by a size bound, not by the call stack',
    ).toBeLessThan(500);
  }, 60_000);

  it('bounds the cost of a large graph', async () => {
    // validateFlow is O(nodes x edges): reachableFrom and findCycle both rescan the
    // whole edge list per node. 3,000 nodes is ~9M comparisons of pure event-loop
    // time for one authenticated request, and the operator budget is 600/minute.
    const N = 3_000;
    const nodes: unknown[] = [{ id: 'n0', type: 'trigger' }, emailNode('m')];
    const edges: unknown[] = [{ id: 'e-m', source: 'n0', target: 'm' }];
    for (let i = 1; i < N; i += 1) {
      nodes.push({ id: `n${i}`, type: 'delay', data: { delayMinutes: 1 } });
      edges.push({ id: `e${i}`, source: 'n0', target: `n${i}` });
    }

    const started = Date.now();
    const response = await app.request('/flow/validate', {
      method: 'POST',
      headers: asA(),
      body: JSON.stringify({ flow: { nodes, edges } }),
    });
    const elapsed = Date.now() - started;
    expect(response.status).toBeLessThan(500);
    expect(
      elapsed,
      `one request occupied the event loop for ${elapsed}ms; there is no node-count cap`,
    ).toBeLessThan(1_000);
  }, 60_000);
});

describe('the sequence_order parking trick', () => {
  it("does not collide a removed node's restored number with a new node's", async () => {
    // The writer parks every existing sequence_order negative, writes the new
    // graph, and then flips whatever is still negative back POSITIVE. A message
    // whose node was removed therefore returns to its ORIGINAL number — which is
    // the number the new graph's first message just took. UNIQUE (campaign_id,
    // sequence_order) does the rest.
    //
    // The campaign seeded here already has one message at sequence_order 1 with a
    // node_id that the new graph does not mention, which is exactly the everyday
    // case: edit a journey, delete a box, press save.
    const flow = {
      nodes: [{ id: 't', type: 'trigger' }, emailNode('fresh')],
      edges: [{ id: 'e0', source: 't', target: 'fresh' }],
    };
    const response = await put(a.campaignId, flow);
    expect(
      response.status,
      'saving a journey that drops an existing node must not be a conflict',
    ).toBe(200);
  });
});
