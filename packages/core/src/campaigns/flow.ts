import type { Channel, SendCondition } from '@campaign/shared';

/**
 * Flow linearisation: compiling a visual canvas into an ordered message sequence.
 *
 * The canvas is what an operator manipulates. `campaign_messages` is what the
 * engine executes. This file is the compiler between them, and three things about
 * it are load-bearing:
 *
 *  1. VALIDATION ERRORS ARE ATTACHED TO NODES, not to the graph. An operator who
 *     is told "the flow is invalid" has to go looking; an operator whose Send SMS
 *     node is outlined in red with "SMS messages need body text" does not.
 *
 *  2. CYCLES ARE REJECTED, not tolerated. A cycle in a messaging journey is an
 *     infinite send, and the graph is the last place it can be caught cheaply. By
 *     the time it reaches the queue it is a live incident.
 *
 *  3. SYNC IS A DIFF BY `node_id`, never delete-all-and-reinsert. Queued rows
 *     reference `campaign_message_id`; recreating those rows on every save would
 *     orphan every message already in flight, and the operator's action that
 *     caused it would have been "moved a box slightly to the left".
 */

export type FlowNodeType = 'trigger' | 'delay' | 'send_email' | 'send_sms' | 'condition' | 'exit';

export type FlowNode = {
  readonly id: string;
  readonly type: FlowNodeType;
  readonly data?: {
    readonly delayMinutes?: number;
    readonly waitMinutes?: number;
    readonly condition?: SendCondition;
    readonly subject?: string;
    readonly body?: string;
    readonly html?: string;
    readonly previewText?: string;
  };
};

export type FlowEdge = {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  /** 'yes' | 'no' on a condition node; absent elsewhere. */
  readonly sourceHandle?: string | null;
};

export type FlowGraph = {
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
};

export type FlowIssue = {
  /** The node this belongs to, so the UI can render it in place. */
  readonly nodeId?: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
};

export type LinearisedMessage = {
  readonly nodeId: string;
  readonly channel: Channel;
  readonly sequenceOrder: number;
  readonly delayMinutes: number;
  readonly sendCondition: SendCondition;
  readonly branchPath: 'yes' | 'no' | null;
  readonly subjectTemplate: string | null;
  readonly bodyTemplate: string;
  readonly htmlTemplate: string | null;
};

export type FlowValidation = {
  readonly issues: readonly FlowIssue[];
  readonly valid: boolean;
};

/**
 * Validate the graph before anything is compiled from it.
 *
 * Everything here is checkable without touching the database, which is why it can
 * run on every keystroke in the editor rather than only on save.
 */
export function validateFlow(graph: FlowGraph): FlowValidation {
  const issues: FlowIssue[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  const triggers = graph.nodes.filter((n) => n.type === 'trigger');
  if (triggers.length === 0) {
    issues.push({ severity: 'error', message: 'The journey needs a trigger node to start from.' });
  } else if (triggers.length > 1) {
    for (const extra of triggers.slice(1)) {
      issues.push({
        nodeId: extra.id,
        severity: 'error',
        message: 'A journey can only have one trigger. Remove this one or merge the branches.',
      });
    }
  }

  const sends = graph.nodes.filter((n) => n.type === 'send_email' || n.type === 'send_sms');
  if (sends.length === 0) {
    issues.push({ severity: 'error', message: 'The journey does not send anything.' });
  }

  // Edges referencing nodes that no longer exist. This happens routinely when a
  // node is deleted client-side and the edge cleanup misses one.
  for (const edge of graph.edges) {
    if (!byId.has(edge.source)) {
      issues.push({
        severity: 'error',
        message: `An edge starts from a node that no longer exists (${edge.source}).`,
      });
    }
    if (!byId.has(edge.target)) {
      issues.push({
        severity: 'error',
        message: `An edge points at a node that no longer exists (${edge.target}).`,
      });
    }
  }

  for (const node of graph.nodes) {
    if (node.type === 'send_sms') {
      if (!node.data?.body?.trim()) {
        issues.push({ nodeId: node.id, severity: 'error', message: 'An SMS needs body text.' });
      }
      if (node.data?.html) {
        issues.push({ nodeId: node.id, severity: 'warning', message: 'HTML is ignored on SMS.' });
      }
    }
    if (node.type === 'send_email') {
      if (!node.data?.subject?.trim()) {
        issues.push({
          nodeId: node.id,
          severity: 'error',
          message: 'An email needs a subject line.',
        });
      }
      if (!node.data?.body?.trim() && !node.data?.html?.trim()) {
        issues.push({ nodeId: node.id, severity: 'error', message: 'An email needs a body.' });
      }
      if (!node.data?.previewText?.trim()) {
        issues.push({
          nodeId: node.id,
          severity: 'warning',
          message: 'No preview text. Mail clients will show the first line of the body instead.',
        });
      }
    }
    if (node.type === 'delay' && (node.data?.delayMinutes ?? 0) <= 0) {
      issues.push({
        nodeId: node.id,
        severity: 'error',
        message: 'A delay must be greater than zero.',
      });
    }
    if (node.type === 'condition') {
      const handles = new Set(
        graph.edges.filter((e) => e.source === node.id).map((e) => e.sourceHandle ?? 'yes'),
      );
      if (handles.size === 0) {
        issues.push({
          nodeId: node.id,
          severity: 'error',
          message: 'This condition leads nowhere.',
        });
      }
    }
  }

  // Nodes nothing can reach. Not an error — an operator building a branch may have
  // one disconnected for a moment — but silently compiling it away would mean a
  // message the operator can see on screen and will never be sent.
  const reachable = reachableFrom(graph, triggers[0]?.id);
  for (const node of graph.nodes) {
    if (node.type !== 'trigger' && !reachable.has(node.id)) {
      issues.push({
        nodeId: node.id,
        severity: 'warning',
        message: 'Nothing reaches this node, so it will never run.',
      });
    }
  }

  const cycle = findCycle(graph);
  if (cycle) {
    for (const nodeId of cycle) {
      issues.push({
        nodeId,
        severity: 'error',
        message:
          'This node is part of a loop. A loop in a journey is an unbounded send, ' +
          'so it is rejected here rather than discovered in the queue.',
      });
    }
  }

  return { issues, valid: !issues.some((i) => i.severity === 'error') };
}

function reachableFrom(graph: FlowGraph, start: string | undefined): Set<string> {
  const seen = new Set<string>();
  if (!start) return seen;
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const edge of graph.edges) {
      if (edge.source === current) stack.push(edge.target);
    }
  }
  return seen;
}

/** Depth-first search returning the nodes on the first cycle found, if any. */
function findCycle(graph: FlowGraph): string[] | undefined {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>(graph.nodes.map((n) => [n.id, WHITE]));
  const path: string[] = [];

  const visit = (id: string): string[] | undefined => {
    colour.set(id, GREY);
    path.push(id);
    for (const edge of graph.edges) {
      if (edge.source !== id) continue;
      const next = edge.target;
      if (!colour.has(next)) continue;
      if (colour.get(next) === GREY) return path.slice(path.indexOf(next));
      if (colour.get(next) === WHITE) {
        const found = visit(next);
        if (found) return found;
      }
    }
    path.pop();
    colour.set(id, BLACK);
    return undefined;
  };

  for (const node of graph.nodes) {
    if (colour.get(node.id) === WHITE) {
      const found = visit(node.id);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Walk the graph into an ordered message list.
 *
 * Delay accumulates along the path, so a Delay node before two Send nodes delays
 * both. A Condition node adds its wait and then splits: each branch inherits the
 * accumulated delay and carries its handle as `branchPath`, which becomes the
 * `send_condition` applied at send time.
 *
 * KNOWN LIMITATION, stated rather than hidden: this flattens branches into a
 * single ordered sequence, so it cannot express a true rejoin — two branches that
 * converge back onto one node produce that node's messages twice, once per branch.
 * A proper state machine per enrolment is the right model and is the thing I would
 * change first. The validator rejects the cycle case; the rejoin case is accepted
 * and documented.
 */
export function lineariseFlow(graph: FlowGraph): LinearisedMessage[] {
  const messages: LinearisedMessage[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const trigger = graph.nodes.find((n) => n.type === 'trigger');
  if (!trigger) return messages;

  let sequence = 0;

  const walk = (
    nodeId: string,
    cumulativeDelay: number,
    branchPath: 'yes' | 'no' | null,
    condition: SendCondition,
    depth: number,
  ): void => {
    // A depth bound rather than a visited set: the same node legitimately appears
    // on two branches. The bound stops a rejoin from recursing without end.
    if (depth > 64) return;
    const node = byId.get(nodeId);
    if (!node) return;

    let delay = cumulativeDelay;
    let nextCondition = condition;

    switch (node.type) {
      case 'delay':
        delay += node.data?.delayMinutes ?? 0;
        break;

      case 'send_email':
      case 'send_sms': {
        const channel: Channel = node.type === 'send_email' ? 'email' : 'sms';
        messages.push({
          nodeId: node.id,
          channel,
          sequenceOrder: ++sequence,
          delayMinutes: delay,
          sendCondition: condition,
          branchPath,
          subjectTemplate: channel === 'email' ? (node.data?.subject ?? null) : null,
          bodyTemplate: node.data?.body ?? '',
          htmlTemplate: channel === 'email' ? (node.data?.html ?? null) : null,
        });
        break;
      }

      case 'condition': {
        delay += node.data?.waitMinutes ?? 0;
        const chosen = node.data?.condition ?? 'opened_previous';
        for (const edge of graph.edges.filter((e) => e.source === node.id)) {
          const handle = edge.sourceHandle === 'no' ? 'no' : 'yes';
          walk(edge.target, delay, handle, handle === 'yes' ? chosen : negate(chosen), depth + 1);
        }
        return; // branches handled; do not fall through
      }

      case 'exit':
        return;

      case 'trigger':
        nextCondition = 'always';
        break;
    }

    for (const edge of graph.edges.filter((e) => e.source === node.id)) {
      walk(edge.target, delay, branchPath, nextCondition, depth + 1);
    }
  };

  walk(trigger.id, 0, null, 'always', 0);
  return messages;
}

/** The 'no' branch of a condition is its negation, not 'always'. */
function negate(condition: SendCondition): SendCondition {
  switch (condition) {
    case 'opened_previous':
      return 'not_opened_previous';
    case 'not_opened_previous':
      return 'opened_previous';
    case 'clicked_previous':
      return 'not_clicked_previous';
    case 'not_clicked_previous':
      return 'clicked_previous';
    case 'replied':
      return 'not_replied';
    case 'not_replied':
      return 'replied';
    case 'always':
      return 'always';
  }
}

export type MessageSyncPlan = {
  readonly create: LinearisedMessage[];
  readonly update: LinearisedMessage[];
  readonly disable: string[];
};

/**
 * Diff the linearised flow against what is already stored.
 *
 * Existing messages are matched by `node_id`. A message whose node has gone is
 * DISABLED rather than deleted, because queued rows reference it — deleting it
 * would cascade away messages that are already scheduled to send, and the
 * operator's action was moving a box on a canvas.
 */
export function planMessageSync(
  linearised: readonly LinearisedMessage[],
  existing: readonly { id: string; node_id: string | null }[],
): MessageSyncPlan {
  const existingByNode = new Map<string, { id: string; node_id: string | null }>();
  for (const message of existing) {
    if (message.node_id !== null) existingByNode.set(message.node_id, message);
  }
  const create: LinearisedMessage[] = [];
  const update: LinearisedMessage[] = [];

  for (const message of linearised) {
    if (existingByNode.has(message.nodeId)) update.push(message);
    else create.push(message);
  }

  const liveNodes = new Set(linearised.map((m) => m.nodeId));
  const disable = existing
    .filter((m) => m.node_id !== null && !liveNodes.has(m.node_id))
    .map((m) => m.id);

  return { create, update, disable };
}
