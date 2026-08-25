/**
 * Compiling the journey canvas into an ordered message sequence.
 *
 * The canvas is what an operator manipulates; `campaign_messages` is what the
 * engine executes. Everything here is about the compiler between them behaving
 * predictably, and refusing the graphs that would misbehave in the queue.
 */
import { describe, it, expect } from 'vitest';
import {
  validateFlow,
  lineariseFlow,
  planMessageSync,
  type FlowGraph,
  type FlowNode,
  type FlowEdge,
} from '@campaign/core';

const node = (id: string, type: FlowNode['type'], data?: FlowNode['data']): FlowNode =>
  data ? { id, type, data } : { id, type };

const edge = (source: string, target: string, handle?: 'yes' | 'no'): FlowEdge =>
  handle
    ? { id: `${source}->${target}:${handle}`, source, target, sourceHandle: handle }
    : { id: `${source}->${target}`, source, target };

const EMAIL = { subject: 'Hello', body: 'Body {{unsubscribe_url}}', previewText: 'Hi' };
const SMS = { body: 'Text body' };

/** trigger → delay(3d) → email → sms */
const LINEAR: FlowGraph = {
  nodes: [
    node('t', 'trigger'),
    node('d', 'delay', { delayMinutes: 60 * 24 * 3 }),
    node('e', 'send_email', EMAIL),
    node('s', 'send_sms', SMS),
  ],
  edges: [edge('t', 'd'), edge('d', 'e'), edge('e', 's')],
};

describe('validation', () => {
  it('accepts a well-formed journey', () => {
    expect(validateFlow(LINEAR).valid).toBe(true);
  });

  it('requires a trigger and at least one send', () => {
    expect(validateFlow({ nodes: [node('e', 'send_email', EMAIL)], edges: [] }).valid).toBe(false);
    expect(
      validateFlow({ nodes: [node('t', 'trigger')], edges: [] }).issues.some((i) =>
        i.message.includes('does not send'),
      ),
    ).toBe(true);
  });

  it('attaches each error to the node it belongs to', () => {
    // The point of the whole design: an operator told "the flow is invalid" has to
    // go looking; an operator whose SMS node is outlined in red does not.
    const graph: FlowGraph = {
      nodes: [node('t', 'trigger'), node('s', 'send_sms', { body: '  ' })],
      edges: [edge('t', 's')],
    };
    const result = validateFlow(graph);
    expect(result.valid).toBe(false);
    const issue = result.issues.find((i) => i.nodeId === 's');
    expect(issue?.message).toMatch(/SMS needs body text/i);
  });

  it('REJECTS a cycle, including a self-loop', () => {
    // A loop in a journey is an unbounded send. The graph is the last place it is
    // cheap to catch.
    const selfLoop: FlowGraph = {
      nodes: [node('t', 'trigger'), node('e', 'send_email', EMAIL)],
      edges: [edge('t', 'e'), edge('e', 'e')],
    };
    const result = validateFlow(selfLoop);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => /loop/i.test(i.message))).toBe(true);

    const longer: FlowGraph = {
      nodes: [
        node('t', 'trigger'),
        node('a', 'send_email', EMAIL),
        node('b', 'delay', { delayMinutes: 10 }),
        node('c', 'send_sms', SMS),
      ],
      edges: [edge('t', 'a'), edge('a', 'b'), edge('b', 'c'), edge('c', 'a')],
    };
    expect(validateFlow(longer).valid).toBe(false);
  });

  it('warns rather than errors on a disconnected node', () => {
    // An operator mid-edit has a node unattached for a moment. Compiling it away
    // silently would mean a message visible on screen that never sends.
    const graph: FlowGraph = {
      nodes: [...LINEAR.nodes, node('orphan', 'send_email', EMAIL)],
      edges: [...LINEAR.edges],
    };
    const result = validateFlow(graph);
    expect(result.valid).toBe(true);
    const warning = result.issues.find((i) => i.nodeId === 'orphan');
    expect(warning?.severity).toBe('warning');
    expect(warning?.message).toMatch(/never run/i);
  });

  it('rejects an edge pointing at a node that no longer exists', () => {
    const graph: FlowGraph = { nodes: LINEAR.nodes, edges: [...LINEAR.edges, edge('e', 'ghost')] };
    expect(validateFlow(graph).valid).toBe(false);
  });

  it('rejects a zero or negative delay', () => {
    const graph: FlowGraph = {
      nodes: [
        node('t', 'trigger'),
        node('d', 'delay', { delayMinutes: 0 }),
        node('e', 'send_email', EMAIL),
      ],
      edges: [edge('t', 'd'), edge('d', 'e')],
    };
    expect(validateFlow(graph).valid).toBe(false);
  });
});

describe('linearisation', () => {
  it('accumulates delay along the path', () => {
    const messages = lineariseFlow(LINEAR);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      nodeId: 'e',
      channel: 'email',
      sequenceOrder: 1,
      delayMinutes: 4320,
    });
    // The SMS inherits the same accumulated delay: nothing adds between them.
    expect(messages[1]).toMatchObject({
      nodeId: 's',
      channel: 'sms',
      sequenceOrder: 2,
      delayMinutes: 4320,
    });
  });

  it('orders across channels, not within them', () => {
    // "Previous" in an email -> SMS journey crosses channels, so a per-channel
    // sequence would resolve not_opened_previous against the wrong message.
    const messages = lineariseFlow(LINEAR);
    expect(messages.map((m) => m.sequenceOrder)).toEqual([1, 2]);
    expect(messages.map((m) => m.channel)).toEqual(['email', 'sms']);
  });

  it('splits a condition into two branches, negating the no branch', () => {
    const graph: FlowGraph = {
      nodes: [
        node('t', 'trigger'),
        node('e', 'send_email', EMAIL),
        node('c', 'condition', { condition: 'opened_previous', waitMinutes: 60 * 24 * 4 }),
        node('yes', 'send_email', EMAIL),
        node('no', 'send_sms', SMS),
      ],
      edges: [edge('t', 'e'), edge('e', 'c'), edge('c', 'yes', 'yes'), edge('c', 'no', 'no')],
    };
    const messages = lineariseFlow(graph);

    const yesBranch = messages.find((m) => m.nodeId === 'yes');
    const noBranch = messages.find((m) => m.nodeId === 'no');

    expect(yesBranch).toMatchObject({ branchPath: 'yes', sendCondition: 'opened_previous' });
    // The no branch is the NEGATION, not 'always'. Sending unconditionally down
    // the no branch would mail everybody twice.
    expect(noBranch).toMatchObject({ branchPath: 'no', sendCondition: 'not_opened_previous' });

    // Both branches inherit the condition node's wait.
    expect(yesBranch?.delayMinutes).toBe(5760);
    expect(noBranch?.delayMinutes).toBe(5760);
  });

  it('stops at an exit node', () => {
    const graph: FlowGraph = {
      nodes: [
        node('t', 'trigger'),
        node('e', 'send_email', EMAIL),
        node('x', 'exit'),
        node('never', 'send_sms', SMS),
      ],
      edges: [edge('t', 'e'), edge('e', 'x'), edge('x', 'never')],
    };
    expect(lineariseFlow(graph).map((m) => m.nodeId)).toEqual(['e']);
  });

  it('returns nothing when there is no trigger', () => {
    expect(lineariseFlow({ nodes: [node('e', 'send_email', EMAIL)], edges: [] })).toEqual([]);
  });

  it('terminates on a rejoin instead of recursing without end', () => {
    // A documented limitation: two branches converging produce the shared node's
    // message once per branch. That is wrong-ish, and it is bounded — which is the
    // property that matters here.
    const graph: FlowGraph = {
      nodes: [
        node('t', 'trigger'),
        node('c', 'condition', { condition: 'clicked_previous' }),
        node('a', 'send_email', EMAIL),
        node('b', 'send_sms', SMS),
        node('join', 'send_email', EMAIL),
      ],
      edges: [
        edge('t', 'c'),
        edge('c', 'a', 'yes'),
        edge('c', 'b', 'no'),
        edge('a', 'join'),
        edge('b', 'join'),
      ],
    };
    const messages = lineariseFlow(graph);
    expect(messages.filter((m) => m.nodeId === 'join')).toHaveLength(2);
    expect(messages.length).toBeLessThan(10);
  });
});

describe('sync planning', () => {
  it('matches on node_id and never plans a delete', () => {
    // Queued rows reference campaign_message_id. Delete-all-and-reinsert on every
    // canvas save would orphan every message already in flight, and the operator's
    // action was moving a box.
    const linearised = lineariseFlow(LINEAR);
    const plan = planMessageSync(linearised, [
      { id: 'existing-email', node_id: 'e' },
      { id: 'removed', node_id: 'gone' },
    ]);

    expect(plan.update.map((m) => m.nodeId)).toEqual(['e']);
    expect(plan.create.map((m) => m.nodeId)).toEqual(['s']);
    expect(plan.disable).toEqual(['removed']);
  });

  it('treats a message with no node_id as unmanaged by the canvas', () => {
    // Messages created through the API rather than the canvas must not be disabled
    // by a canvas save.
    const plan = planMessageSync(lineariseFlow(LINEAR), [{ id: 'api-made', node_id: null }]);
    expect(plan.disable).toEqual([]);
  });
});
