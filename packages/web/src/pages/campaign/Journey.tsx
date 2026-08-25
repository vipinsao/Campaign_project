import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
} from '@xyflow/react';
import type { Edge, Node, NodeProps, NodeTypes } from '@xyflow/react';
import clsx from 'clsx';
import type { Channel, DelayAnchor, SendCondition } from '@campaign/shared';
import { ApiError, api, failuresByMessage } from '../../lib/api.ts';
import type { CampaignMessage } from '../../lib/types.ts';
import { useCampaign } from '../CampaignEditor.tsx';
import { ErrorState } from '../../components/States.tsx';
import { ChannelBadge, Pill } from '../../components/Pill.tsx';
import { Tooltip } from '../../components/Tooltip.tsx';
import { minutes, titleCase } from '../../lib/format.ts';

/**
 * The journey canvas.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Three decisions here are worth stating, because each of them is a place this
 * kind of screen usually goes wrong.
 *
 *  1. THE GRAPH IS A RENDERING OF THE SEQUENCE, NOT A SECOND SOURCE OF TRUTH.
 *     `campaign_messages` is a linear sequence carrying `delay_minutes`,
 *     `delay_anchor`, `send_condition` and `branch_path`. Everything on this
 *     canvas is derived from those columns and linearises straight back into
 *     them, so the canvas and the Messages tab cannot disagree. A free-form graph
 *     stored in a `flow_definition` blob alongside the rows the sender actually
 *     reads is how an operator moves a node, saves, and changes nothing.
 *
 *     Edges are therefore DERIVED and not hand-drawn: the order of the steps is
 *     the sequence, and a dangling edge an operator drew by hand would be a state
 *     the schema has no way to hold.
 *
 *  2. VALIDATION ERRORS RENDER ON THE OFFENDING NODE. A toast that says
 *     "3 problems" while every node still looks fine is worse than silence — it
 *     tells the operator something is wrong and hides which thing. Both sources
 *     land on the node: the structural checks below, and the activation failures
 *     the API returned in the 422's `details.failures`, keyed by
 *     `campaignMessageId` (see CampaignEditor).
 *
 *  3. SAVE IS validate → linearise → sync, IN THAT ORDER, AND IT STOPS AT THE
 *     FIRST STAGE THAT FAILS. Syncing a graph the client already knows to be
 *     invalid would half-write it: three PATCHes land, the fourth is rejected,
 *     and the campaign is now in a state that was never on anybody's screen.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── the step model ───────────────────────────────────────────────────────────

type SendStep = {
  readonly key: string;
  readonly kind: 'send';
  /** null for a step that has never been persisted. */
  readonly messageId: string | null;
  readonly channel: Channel;
  readonly subject: string | null;
  readonly body: string;
  readonly enabled: boolean;
  readonly delayMinutes: number;
  readonly delayAnchor: DelayAnchor;
  readonly condition: SendCondition;
  readonly branch: 'yes' | 'no' | null;
};

type Step = SendStep;

function toStep(message: CampaignMessage): SendStep {
  return {
    key: message.id,
    kind: 'send',
    messageId: message.id,
    channel: message.channel,
    subject: message.subjectTemplate,
    body: message.bodyTemplate,
    enabled: message.isEnabled,
    delayMinutes: message.delayMinutes,
    delayAnchor: message.delayAnchor,
    condition: message.sendCondition,
    branch: message.branchPath,
  };
}

// ── node data ────────────────────────────────────────────────────────────────

type Problem = { readonly text: string; readonly from: 'canvas' | 'activation' };

type TriggerData = {
  triggerType: string;
  category: string;
  problems: readonly Problem[];
};
type DelayData = { stepKey: string; minutes: number; anchor: DelayAnchor; problems: readonly Problem[] };
type ConditionData = { stepKey: string; condition: SendCondition; problems: readonly Problem[] };
type SendData = {
  stepKey: string;
  channel: Channel;
  subject: string | null;
  body: string;
  enabled: boolean;
  persisted: boolean;
  branch: 'yes' | 'no' | null;
  problems: readonly Problem[];
};
type ExitData = { sends: number };

type TriggerNode = Node<TriggerData, 'trigger'>;
type DelayNode = Node<DelayData, 'delay'>;
type ConditionNode = Node<ConditionData, 'condition'>;
type SendNode = Node<SendData, 'send'>;
type ExitNode = Node<ExitData, 'exit'>;
type FlowNode = TriggerNode | DelayNode | ConditionNode | SendNode | ExitNode;

// ── node chrome ──────────────────────────────────────────────────────────────

function Problems({ problems }: { problems: readonly Problem[] }) {
  if (problems.length === 0) return null;
  return (
    <ul className="mt-1.5 space-y-1 border-t border-bad/25 pt-1.5">
      {problems.map((problem, index) => (
        <li key={index} className="flex gap-1.5 text-[10px] leading-snug text-bad">
          <span className="shrink-0 font-mono opacity-70">
            {problem.from === 'activation' ? '422' : '!'}
          </span>
          <span>{problem.text}</span>
        </li>
      ))}
    </ul>
  );
}

function Shell({
  tone,
  selected,
  problems,
  children,
}: {
  tone: 'trigger' | 'delay' | 'condition' | 'send' | 'exit';
  selected: boolean;
  problems: readonly Problem[];
  children: React.ReactNode;
}) {
  const bad = problems.length > 0;
  return (
    <div
      className={clsx(
        'w-56 rounded-md border px-2.5 py-2 text-left shadow-lg shadow-black/40 transition-colors',
        bad
          ? 'border-bad bg-bad-wash'
          : selected
            ? 'border-accent bg-raised'
            : tone === 'trigger'
              ? 'border-info/40 bg-info-wash'
              : tone === 'exit'
                ? 'border-line-strong bg-quiet-wash'
                : 'border-line-strong bg-surface',
      )}
    >
      {children}
      <Problems problems={problems} />
    </div>
  );
}

function NodeLabel({ glyph, text, tone }: { glyph: string; text: string; tone: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={clsx('font-mono text-[11px]', tone)}>{glyph}</span>
      <span className="text-[10px] font-semibold tracking-wide text-ink-faint uppercase">{text}</span>
    </div>
  );
}

function TriggerNodeView({ data, selected }: NodeProps<TriggerNode>) {
  return (
    <Shell tone="trigger" selected={selected} problems={data.problems}>
      <NodeLabel glyph="◉" text="Trigger" tone="text-info" />
      <div className="mt-1 font-mono text-[12px] break-all text-ink">{data.triggerType}</div>
      <div className="mt-0.5 text-[10px] text-ink-faint">{titleCase(data.category)}</div>
      <Handle type="source" position={Position.Bottom} />
    </Shell>
  );
}

function DelayNodeView({ data, selected }: NodeProps<DelayNode>) {
  return (
    <Shell tone="delay" selected={selected} problems={data.problems}>
      <NodeLabel glyph="◷" text="Delay" tone="text-held" />
      <div className="mt-1 text-[12px] text-ink">{minutes(data.minutes)}</div>
      <div className="mt-0.5 text-[10px] text-ink-faint">
        measured from <span className="font-mono">{data.anchor}</span>
      </div>
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
    </Shell>
  );
}

/**
 * The only node with two outputs, and the labels are on the handles rather than
 * on the edges — an operator reading this canvas has to be able to tell which way
 * "not opened" goes without hovering anything.
 */
function ConditionNodeView({ data, selected }: NodeProps<ConditionNode>) {
  return (
    <Shell tone="condition" selected={selected} problems={data.problems}>
      <NodeLabel glyph="◇" text="Condition" tone="text-accent" />
      <div className="mt-1 font-mono text-[11px] break-all text-ink">{data.condition}</div>
      <div className="mt-1.5 flex justify-between text-[10px]">
        <span className="text-ok">yes → send</span>
        <span className="text-ink-faint">no → skip</span>
      </div>
      <Handle type="target" position={Position.Top} />
      <Handle id="yes" type="source" position={Position.Bottom} style={{ left: '25%' }} />
      <Handle id="no" type="source" position={Position.Bottom} style={{ left: '75%' }} />
    </Shell>
  );
}

function SendNodeView({ data, selected }: NodeProps<SendNode>) {
  return (
    <Shell tone="send" selected={selected} problems={data.problems}>
      <div className="flex items-center justify-between gap-1.5">
        <NodeLabel
          glyph="✉"
          text={data.channel === 'email' ? 'Send email' : 'Send SMS'}
          tone={data.channel === 'email' ? 'text-accent' : 'text-ok'}
        />
        <span className="flex items-center gap-1">
          {!data.persisted && <Pill tone="info">new</Pill>}
          {!data.enabled && <Pill tone="quiet">off</Pill>}
        </span>
      </div>
      <div className="mt-1 truncate text-[12px] text-ink">
        {data.channel === 'email'
          ? (data.subject ?? '(no subject)')
          : data.body.slice(0, 40) || '(empty)'}
      </div>
      {data.channel === 'email' && (
        <div className="mt-0.5 truncate text-[10px] text-ink-faint">
          {data.body.slice(0, 48) || '(empty body)'}
        </div>
      )}
      {data.branch !== null && (
        <div className="mt-1 font-mono text-[10px] text-ink-faint">branch: {data.branch}</div>
      )}
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
    </Shell>
  );
}

function ExitNodeView({ data }: NodeProps<ExitNode>) {
  return (
    <Shell tone="exit" selected={false} problems={[]}>
      <NodeLabel glyph="◼" text="Exit" tone="text-ink-faint" />
      <div className="mt-1 text-[11px] text-ink-dim">
        {data.sends === 0
          ? 'Nothing is sent on this path.'
          : `Journey ends after ${String(data.sends)} message${data.sends === 1 ? '' : 's'}.`}
      </div>
      <Handle type="target" position={Position.Top} />
    </Shell>
  );
}

/** Module scope on purpose: React Flow warns loudly about a new object each render. */
const NODE_TYPES = {
  trigger: TriggerNodeView,
  delay: DelayNodeView,
  condition: ConditionNodeView,
  send: SendNodeView,
  exit: ExitNodeView,
} as unknown as NodeTypes;

// ── validation ───────────────────────────────────────────────────────────────

type ProblemMap = Map<string, Problem[]>;

function addProblem(map: ProblemMap, key: string, text: string, from: Problem['from'] = 'canvas') {
  map.set(key, [...(map.get(key) ?? []), { text, from }]);
}

/**
 * The structural checks, which are the ones the API cannot make for us.
 *
 * Everything about a single message's TEMPLATE (opt-out link, unknown merge
 * fields, subject presence) is checked by `POST /templates/validate` and again by
 * `/activate`, both of which call core's `validateTemplate`. Repeating those here
 * would give the canvas a second opinion about whether a campaign is sendable,
 * and a second opinion is worth less than none. What this function checks is the
 * SHAPE of the sequence — things that are only wrong in the context of the other
 * steps, which is exactly what the graph is for.
 */
function validate(
  steps: readonly Step[],
  channels: readonly Channel[],
  orderAnchored: boolean,
): ProblemMap {
  const problems: ProblemMap = new Map();

  if (steps.length === 0) {
    addProblem(problems, 'trigger', 'This journey sends nothing: it would enrol contacts and stop.');
    return problems;
  }

  steps.forEach((step, index) => {
    if (!channels.includes(step.channel)) {
      addProblem(
        problems,
        step.key,
        `This step is ${step.channel.toUpperCase()}, which the campaign does not send on. Enable the channel on Overview or change this step.`,
      );
    }
    if (step.body.trim().length === 0) {
      addProblem(problems, step.key, 'The body is empty, so this step would deliver a blank message.');
    }
    if (step.channel === 'email' && (step.subject ?? '').trim().length === 0) {
      addProblem(problems, step.key, 'An email with no subject line cannot be activated.');
    }
    if (step.delayAnchor === 'delivery' && !orderAnchored) {
      addProblem(
        problems,
        `${step.key}:delay`,
        'Anchored to `delivery`, but this campaign has no order to be delivered — the delay would never resolve.',
      );
    }
    if (index === 0 && step.condition !== 'always') {
      addProblem(
        problems,
        `${step.key}:condition`,
        'The first step has no previous message, so this condition can never be true.',
      );
    }
    if (index === 0 && step.delayAnchor === 'previous') {
      addProblem(
        problems,
        `${step.key}:delay`,
        'The first step has no previous message to measure a delay from.',
      );
    }
  });

  return problems;
}

// ── linearise ────────────────────────────────────────────────────────────────

type SyncPlan = {
  readonly creates: readonly { step: SendStep; sequenceOrder: number }[];
  readonly updates: readonly { step: SendStep; sequenceOrder: number }[];
  readonly deletes: readonly string[];
};

function linearise(steps: readonly Step[], existing: readonly CampaignMessage[]): SyncPlan {
  const kept = new Set(steps.map((step) => step.messageId).filter((id): id is string => id !== null));
  return {
    creates: steps
      .map((step, index) => ({ step, sequenceOrder: index + 1 }))
      .filter((entry) => entry.step.messageId === null),
    updates: steps
      .map((step, index) => ({ step, sequenceOrder: index + 1 }))
      .filter((entry) => entry.step.messageId !== null),
    deletes: existing.filter((message) => !kept.has(message.id)).map((message) => message.id),
  };
}

function bodyOf(step: SendStep, sequenceOrder: number) {
  return {
    channel: step.channel,
    sequenceOrder,
    delayAnchor: step.delayAnchor,
    delayMinutes: step.delayMinutes,
    sendCondition: step.condition,
    subjectTemplate: step.channel === 'email' ? step.subject : null,
    bodyTemplate: step.body,
    nodeId: step.key,
    branchPath: step.condition === 'always' ? null : (step.branch ?? 'yes'),
    isEnabled: step.enabled,
  };
}

// ── the tab ──────────────────────────────────────────────────────────────────

export function JourneyTab() {
  const { campaignId, campaign, messages, reload, activationFailures, clearActivationFailures } =
    useCampaign();
  const [steps, setSteps] = useState<readonly Step[]>(() => messages.map(toStep));
  const [selected, setSelected] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saveFailures, setSaveFailures] = useState<Map<string, string[]>>(new Map());
  const [note, setNote] = useState<string | null>(null);

  /**
   * Re-seed from the server whenever the server's answer changes.
   *
   * Without this, a step created here keeps its temporary `new-…` key after the
   * save that gave it a real id, and the next save would POST it a second time.
   * Comparing against a signature of what the API returned is also what makes
   * `dirty` mean "different from what is stored" rather than "edited at some
   * point" — the difference between a Save button that goes quiet after a
   * successful write and one that stays lit forever.
   */
  const incoming = messages.map(toStep);
  const signature = JSON.stringify(incoming);
  const [baseline, setBaseline] = useState(signature);
  if (baseline !== signature) {
    setBaseline(signature);
    setSteps(incoming);
    setSelected(null);
    setAttempted(false);
  }

  const orderAnchored = campaign.triggerType.startsWith('order_');
  const problems = validate(steps, campaign.channels, orderAnchored);

  /**
   * The server's activation failures, merged onto the same nodes.
   *
   * They arrive keyed by `campaignMessageId`, which is exactly the id a persisted
   * step carries, so the join is direct. A step created on this canvas and not yet
   * saved has no id and therefore cannot carry one — which is correct: the server
   * has never seen it.
   */
  const serverProblems: ProblemMap = new Map();
  for (const source of [activationFailures, saveFailures]) {
    for (const [messageId, texts] of source) {
      const key = messageId === '__campaign' ? 'trigger' : messageId;
      for (const text of texts) addProblem(serverProblems, key, text, 'activation');
    }
  }

  const problemsFor = (key: string): readonly Problem[] => [
    ...(attempted ? (problems.get(key) ?? []) : []),
    ...(serverProblems.get(key) ?? []),
  ];

  const totalProblems =
    (attempted ? [...problems.values()].reduce((sum, list) => sum + list.length, 0) : 0) +
    [...serverProblems.values()].reduce((sum, list) => sum + list.length, 0);

  // ── the graph, derived ─────────────────────────────────────────────────────
  /**
   * Two passes: lay the slots out, then wire them.
   *
   * The `no` edge of a condition has to point at whatever comes AFTER the message
   * it guards, and that node does not exist yet while the condition is being
   * created. Building the slot list first is what lets the skip edge be a real
   * edge to a real node instead of a decorative stub that stops at the send.
   */
  type Slot = { id: string; kind: 'delay' | 'condition' | 'send'; step: SendStep };
  const slots: Slot[] = [];
  for (const step of steps) {
    if (step.delayMinutes > 0 || step.delayAnchor !== 'trigger') {
      slots.push({ id: `${step.key}:delay`, kind: 'delay', step });
    }
    if (step.condition !== 'always') {
      slots.push({ id: `${step.key}:condition`, kind: 'condition', step });
    }
    slots.push({ id: step.key, kind: 'send', step });
  }

  const STEP_Y = 138;
  const nodes: FlowNode[] = [
    {
      id: 'trigger',
      type: 'trigger',
      position: { x: 0, y: 0 },
      data: {
        triggerType: campaign.triggerType,
        category: campaign.category,
        problems: problemsFor('trigger'),
      },
      selected: selected === 'trigger',
    },
  ];

  for (const [index, slot] of slots.entries()) {
    const position = { x: 0, y: (index + 1) * STEP_Y };
    if (slot.kind === 'delay') {
      nodes.push({
        id: slot.id,
        type: 'delay',
        position,
        data: {
          stepKey: slot.step.key,
          minutes: slot.step.delayMinutes,
          anchor: slot.step.delayAnchor,
          problems: problemsFor(slot.id),
        },
        selected: selected === slot.id,
      });
    } else if (slot.kind === 'condition') {
      nodes.push({
        id: slot.id,
        type: 'condition',
        position,
        data: {
          stepKey: slot.step.key,
          condition: slot.step.condition,
          problems: problemsFor(slot.id),
        },
        selected: selected === slot.id,
      });
    } else {
      nodes.push({
        id: slot.id,
        type: 'send',
        position,
        data: {
          stepKey: slot.step.key,
          channel: slot.step.channel,
          subject: slot.step.subject,
          body: slot.step.body,
          enabled: slot.step.enabled,
          persisted: slot.step.messageId !== null,
          branch: slot.step.condition === 'always' ? null : (slot.step.branch ?? 'yes'),
          problems: problemsFor(slot.id),
        },
        selected: selected === slot.id,
      });
    }
  }

  nodes.push({
    id: 'exit',
    type: 'exit',
    position: { x: 0, y: (slots.length + 1) * STEP_Y },
    data: { sends: steps.length },
  });

  const idAt = (index: number): string => slots[index]?.id ?? 'exit';
  const edges: Edge[] = [{ id: 'trigger->0', source: 'trigger', target: idAt(0) }];
  for (const [index, slot] of slots.entries()) {
    const next = idAt(index + 1);
    edges.push({
      id: `${slot.id}->${next}`,
      source: slot.id,
      target: next,
      ...(slot.kind === 'condition' ? { sourceHandle: 'yes', label: 'yes', animated: true } : {}),
    });
    if (slot.kind === 'condition') {
      // Skip exactly one message and rejoin. `send_condition` gates a single
      // message; it does not end the journey, and an edge that implied it did
      // would be a picture of a system that does not exist.
      const rejoin = idAt(index + 2);
      edges.push({
        id: `${slot.id}:no->${rejoin}`,
        source: slot.id,
        sourceHandle: 'no',
        target: rejoin,
        label: 'no',
        style: { strokeDasharray: '4 3' },
      });
    }
  }


  // ── mutations ──────────────────────────────────────────────────────────────

  const save = useMutation({
    mutationFn: async () => {
      const plan = linearise(steps, messages);
      // Deletes first: a delete frees the sequence_order a later create may want,
      // and the server disables rather than deletes anything that has already sent.
      for (const id of plan.deletes) {
        await api.del(`/campaigns/${campaignId}/messages/${id}`);
      }
      for (const entry of plan.updates) {
        await api.patch(
          `/campaigns/${campaignId}/messages/${entry.step.messageId ?? ''}`,
          bodyOf(entry.step, entry.sequenceOrder),
        );
      }
      for (const entry of plan.creates) {
        await api.post(`/campaigns/${campaignId}/messages`, bodyOf(entry.step, entry.sequenceOrder));
      }
      return plan;
    },
    onMutate: () => {
      setSaveError(null);
      setNote(null);
      setSaveFailures(new Map());
    },
    onSuccess: (plan) => {
      setNote(
        `Synced: ${String(plan.creates.length)} created, ${String(plan.updates.length)} updated, ${String(plan.deletes.length)} removed.`,
      );
      clearActivationFailures();
      reload();
    },
    onError: (error) => {
      // A 422 from the message endpoints carries per-message failures in exactly
      // the same shape activation does, so it lands on the nodes too rather than
      // in a banner that names no node.
      if (error instanceof ApiError) setSaveFailures(failuresByMessage(error.details));
      setSaveError(error);
    },
  });

  function onSave() {
    setAttempted(true);
    setNote(null);
    if (problems.size > 0) {
      setSaveError(null);
      return;
    }
    save.mutate();
  }

  function addStep(channel: Channel) {
    const key = `new-${String(Date.now())}-${String(steps.length)}`;
    setSteps([
      ...steps,
      {
        key,
        kind: 'send',
        messageId: null,
        channel,
        subject: channel === 'email' ? 'New message' : null,
        body:
          channel === 'email'
            ? 'Hi {{contact.first_name}},\n\n\n\nUnsubscribe: {{unsubscribe_url}}'
            : 'Hi {{contact.first_name}} — ',
        enabled: true,
        delayMinutes: steps.length === 0 ? 0 : 1440,
        delayAnchor: steps.length === 0 ? 'trigger' : 'previous',
        condition: 'always',
        branch: null,
      },
    ]);
    setSelected(key);
  }

  function patchStep(key: string, patch: Partial<SendStep>) {
    setSteps(steps.map((step) => (step.key === key ? { ...step, ...patch } : step)));
  }

  const dirty = JSON.stringify(steps) !== signature;
  const selectedStep =
    selected === null ? undefined : steps.find((step) => selected.startsWith(step.key));

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-[1fr_320px]">
      <section className="panel flex min-h-[560px] flex-col overflow-hidden">
        <div className="panel-head">
          <span className="panel-title">Journey</span>
          <div className="flex items-center gap-2">
            {campaign.channels.map((channel) => (
              <button
                key={channel}
                type="button"
                className="btn"
                onClick={() => { addStep(channel); }}
              >
                + {channel.toUpperCase()}
              </button>
            ))}
            <button
              type="button"
              className="btn btn-primary"
              disabled={save.isPending || !dirty}
              onClick={onSave}
            >
              {save.isPending ? 'Syncing…' : dirty ? 'Validate & save' : 'Saved'}
            </button>
          </div>
        </div>

        {totalProblems > 0 && (
          <p className="border-b border-bad/25 bg-bad-wash px-4 py-2 text-[12px] text-bad">
            {totalProblems} problem{totalProblems === 1 ? '' : 's'} — each one is drawn on the node it
            belongs to. Nothing was written.
          </p>
        )}
        {note !== null && (
          <p className="border-b border-ok/25 bg-ok-wash px-4 py-2 text-[12px] text-ok">{note}</p>
        )}
        {saveError !== null && <ErrorState error={saveError} title="The journey was not synced" />}

        <div className="min-h-0 flex-1">
          <ReactFlow<FlowNode>
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable={false}
            fitView
            fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_event, node) => { setSelected(node.id); }}
            onPaneClick={() => { setSelected(null); }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#222833" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        <p className="border-t border-line px-4 py-2 text-[11px] leading-relaxed text-ink-faint">
          Edges are derived from the sequence rather than drawn by hand — the schema stores a linear
          sequence with a per-message condition, and an edge you could draw but not store would be a
          lie about what the sender will do.
        </p>
      </section>

      <aside className="space-y-3">
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Step</span>
            {selectedStep !== undefined && <ChannelBadge channel={selectedStep.channel} />}
          </div>
          {selectedStep === undefined ? (
            <p className="px-4 py-3 text-[12px] leading-relaxed text-ink-faint">
              Select a node to edit it. Delay, condition and send all belong to the same row in{' '}
              <code className="font-mono">campaign_messages</code>, so editing any of them edits one
              message.
            </p>
          ) : (
            <StepInspector
              step={selectedStep}
              channels={campaign.channels}
              onChange={(patch) => { patchStep(selectedStep.key, patch); }}
              onRemove={() => {
                setSteps(steps.filter((step) => step.key !== selectedStep.key));
                setSelected(null);
              }}
            />
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">How save works</span>
          </div>
          <ol className="space-y-2 px-4 py-3 text-[12px] leading-relaxed text-ink-dim">
            <li>
              <b className="text-ink">Validate.</b> Shape checks run here; template checks stay on the
              server so this screen and <code className="font-mono">/activate</code> cannot disagree.
            </li>
            <li>
              <b className="text-ink">Linearise.</b> Nodes become <code className="font-mono">sequence_order</code>{' '}
              1…n with their delay, condition and branch.
            </li>
            <li>
              <b className="text-ink">Sync.</b> DELETE, then PATCH, then POST against{' '}
              <code className="font-mono">/campaigns/:id/messages</code>. A message that has already
              queued rows is disabled by the server rather than deleted.
            </li>
          </ol>
        </section>
      </aside>
    </div>
  );
}

const CONDITIONS: readonly SendCondition[] = [
  'always',
  'opened_previous',
  'not_opened_previous',
  'clicked_previous',
  'not_clicked_previous',
  'replied',
  'not_replied',
];

const ANCHORS: readonly DelayAnchor[] = ['trigger', 'previous', 'delivery'];

function StepInspector({
  step,
  channels,
  onChange,
  onRemove,
}: {
  step: SendStep;
  channels: readonly Channel[];
  onChange: (patch: Partial<SendStep>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="space-y-3 p-4">
      <div>
        <span className="label">Channel</span>
        <div className="flex gap-2">
          {channels.map((channel) => (
            <button
              key={channel}
              type="button"
              className={step.channel === channel ? 'btn btn-primary flex-1 justify-center' : 'btn flex-1 justify-center'}
              onClick={() => { onChange({ channel }); }}
            >
              {channel.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label" htmlFor="delay-minutes">Delay (minutes)</label>
          <input
            id="delay-minutes"
            type="number"
            min={0}
            className="input"
            value={step.delayMinutes}
            onChange={(event) => { onChange({ delayMinutes: Math.max(0, Number(event.target.value)) }); }}
          />
        </div>
        <div>
          <label className="label" htmlFor="delay-anchor">Anchor</label>
          <select
            id="delay-anchor"
            className="input"
            value={step.delayAnchor}
            onChange={(event) => { onChange({ delayAnchor: event.target.value as DelayAnchor }); }}
          >
            {ANCHORS.map((anchor) => (
              <option key={anchor} value={anchor}>{anchor}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="label" htmlFor="condition">Send condition</label>
        <select
          id="condition"
          className="input"
          value={step.condition}
          onChange={(event) => {
            const condition = event.target.value as SendCondition;
            onChange({ condition, branch: condition === 'always' ? null : (step.branch ?? 'yes') });
          }}
        >
          {CONDITIONS.map((condition) => (
            <option key={condition} value={condition}>{condition}</option>
          ))}
        </select>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
          {step.condition === 'always'
            ? 'No condition node is drawn: this step always sends.'
            : 'Evaluated against the previous message in the sequence — across channels, so an SMS can gate on an email being opened.'}
        </p>
      </div>

      {step.channel === 'email' && (
        <div>
          <label className="label" htmlFor="subject">Subject</label>
          <input
            id="subject"
            className="input"
            value={step.subject ?? ''}
            onChange={(event) => { onChange({ subject: event.target.value }); }}
          />
        </div>
      )}

      <div>
        <label className="label" htmlFor="body">Body</label>
        <textarea
          id="body"
          className="input min-h-32 font-mono text-[12px] leading-relaxed"
          value={step.body}
          spellCheck={false}
          onChange={(event) => { onChange({ body: event.target.value }); }}
        />
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
          The Messages tab validates this against the server. Nothing here second-guesses that.
        </p>
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-[12px]">
        <input
          type="checkbox"
          className="accent-accent"
          checked={step.enabled}
          onChange={(event) => { onChange({ enabled: event.target.checked }); }}
        />
        <span className="text-ink-dim">Enabled</span>
      </label>

      <div className="flex items-center justify-between border-t border-line pt-3">
        <Tooltip
          align="left"
          content={
            <div className="text-ink-dim">
              Removing a step that already produced queued or sent rows does not delete it — the
              server disables it instead, because deleting would cascade and erase the record of what
              was sent.
            </div>
          }
        >
          <span className="text-[11px] text-ink-faint underline decoration-dotted underline-offset-4">
            what remove does
          </span>
        </Tooltip>
        <button type="button" className="btn btn-danger" onClick={onRemove}>
          Remove step
        </button>
      </div>
    </div>
  );
}
