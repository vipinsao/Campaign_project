import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router';
import clsx from 'clsx';
import { AUDIENCE_FIELDS, AudienceOperator } from '@campaign/shared';
import type { AudienceDefinition, AudienceRule } from '@campaign/shared';
import { api } from '../../lib/api.ts';
import type { EstimateResponse } from '../../lib/types.ts';
import { useCampaign } from '../CampaignEditor.tsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.tsx';
import { int } from '../../lib/format.ts';
import { Tooltip } from '../../components/Tooltip.tsx';

/**
 * The rule builder, and the number it produces.
 *
 * The number is labelled "contacts matching the segment" and never "will receive
 * this", because it is an UPPER BOUND: `/audience/estimate` evaluates the audience
 * predicate and nothing else. It does not subtract opt-outs, address-level
 * suppressions, frequency caps or quiet-hours deferrals — those are send-time
 * gates, evaluated per message, per recipient, at the moment of sending. An
 * operator who reads this as a send count and sees 30% fewer messages go out
 * concludes the system is broken; the caption is what prevents that.
 *
 * "Show compiled SQL" is a disclosure, not a debug toggle. The compiler provably
 * never interpolates an operator-supplied value into SQL text — every value is a
 * `$n` placeholder — so showing the operator exactly what will run against their
 * data is safe, and it is the fastest way to understand why a segment matched
 * nobody.
 */

type Group = 'all' | 'any' | 'none';
const GROUPS: readonly Group[] = ['all', 'any', 'none'];

const GROUP_HELP: Record<Group, string> = {
  all: 'Every rule must hold.',
  any: 'At least one rule must hold.',
  none: 'No rule may hold.',
};

const NO_VALUE_OPS = new Set(['is_set', 'is_not_set']);
const LIST_OPS = new Set(['in', 'not_in']);
const DAY_OPS = new Set(['within_days', 'not_within_days']);

type Leaf = { field: string; op: string; value?: unknown };

function isLeaf(rule: AudienceRule): rule is Leaf {
  return typeof rule === 'object' && 'field' in rule;
}

export function AudienceTab() {
  const { campaignId, campaign, reload } = useCampaign();
  const [definition, setDefinition] = useState<AudienceDefinition>(campaign.audience ?? {});
  const [debounced, setDebounced] = useState<AudienceDefinition>(campaign.audience ?? {});
  const [showSql, setShowSql] = useState(false);
  const [raw, setRaw] = useState(false);
  const [rawText, setRawText] = useState(() => JSON.stringify(campaign.audience ?? {}, null, 2));
  const [rawError, setRawError] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<EstimateResponse | null>(null);
  const [estimateError, setEstimateError] = useState<unknown>(null);
  const [estimating, setEstimating] = useState(true);

  // Debounced, because a rule builder fires an edit per keystroke and this query
  // does a COUNT over the tenant's contacts. 400ms is long enough to swallow a
  // burst of typing and short enough to feel live.
  useEffect(() => {
    const timer = window.setTimeout(() => { setDebounced(definition); }, 400);
    return () => { window.clearTimeout(timer); };
  }, [definition]);

  useEffect(() => {
    let cancelled = false;
    setEstimating(true);
    api
      .post<EstimateResponse>('/audience/estimate', { audience: debounced, sampleSize: 10 })
      .then((result) => {
        if (cancelled) return;
        setEstimate(result);
        setEstimateError(null);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setEstimateError(caught);
        setEstimate(null);
      })
      .finally(() => { if (!cancelled) setEstimating(false); });
    return () => { cancelled = true; };
  }, [debounced]);

  const save = useMutation({
    mutationFn: (next: AudienceDefinition) => api.patch(`/campaigns/${campaignId}`, { audience: next }),
    onSuccess: reload,
  });

  const dirty = JSON.stringify(definition) !== JSON.stringify(campaign.audience ?? {});
  const hasNested = GROUPS.some((group) => (definition[group] ?? []).some((rule) => !isLeaf(rule)));

  function update(next: AudienceDefinition) {
    setDefinition(next);
    setRawText(JSON.stringify(next, null, 2));
  }

  function updateRules(group: Group, rules: AudienceRule[]) {
    const next = { ...definition };
    if (rules.length === 0) delete next[group];
    else next[group] = rules;
    update(next);
  }

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-[1fr_360px]">
      <div className="space-y-3">
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Segment</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={clsx('btn btn-ghost', raw && 'text-accent')}
                onClick={() => { setRaw(!raw); }}
              >
                {raw ? 'Builder' : 'Edit as JSON'}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!dirty || save.isPending}
                onClick={() => { save.mutate(definition); }}
              >
                {save.isPending ? 'Saving…' : dirty ? 'Save segment' : 'Saved'}
              </button>
            </div>
          </div>

          {save.isError && <ErrorState error={save.error} title="The segment was not saved" />}

          {raw ? (
            <div className="p-4">
              <textarea
                className="input min-h-72 font-mono text-[12px] leading-relaxed"
                value={rawText}
                spellCheck={false}
                onChange={(event) => {
                  setRawText(event.target.value);
                  try {
                    setDefinition(JSON.parse(event.target.value) as AudienceDefinition);
                    setRawError(null);
                  } catch (caught) {
                    setRawError(caught instanceof Error ? caught.message : 'not valid JSON');
                  }
                }}
              />
              {rawError !== null && <p className="mt-2 text-[12px] text-bad">{rawError}</p>}
              <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
                The definition is <code className="font-mono">.strict()</code> on the server: an
                unrecognised key such as <code className="font-mono">alll</code> is rejected rather
                than ignored, because an ignored combinator compiles to “match everyone”.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-line">
              {hasNested && (
                <p className="bg-held-wash px-4 py-2 text-[12px] text-held">
                  This segment contains nested groups. The builder edits flat rules only — use{' '}
                  <b>Edit as JSON</b> so nothing is silently dropped.
                </p>
              )}
              {GROUPS.map((group) => (
                <RuleGroup
                  key={group}
                  group={group}
                  rules={definition[group] ?? []}
                  onChange={(rules) => { updateRules(group, rules); }}
                />
              ))}
              {GROUPS.every((group) => (definition[group] ?? []).length === 0) && (
                <p className="px-4 py-3 text-[12px] leading-relaxed text-ink-faint">
                  An empty segment matches <b className="text-held">every contact in the tenant</b>.
                  That is stated rather than implied — add a rule to narrow it.
                </p>
              )}
            </div>
          )}
        </section>

        <section className="panel">
          <button
            type="button"
            className="panel-head w-full cursor-pointer text-left"
            onClick={() => { setShowSql(!showSql); }}
            aria-expanded={showSql}
          >
            <span className="panel-title">
              <span className="mr-1.5 inline-block font-mono text-ink-faint">{showSql ? '▾' : '▸'}</span>
              Show compiled SQL
            </span>
            <span className="text-[11px] text-ink-faint">
              placeholders intact — no operator value is ever spliced into the text
            </span>
          </button>
          {showSql && (
            estimate === null ? (
              <p className="px-4 py-3 text-[12px] text-ink-faint">
                Nothing compiled yet — the estimate below has not returned.
              </p>
            ) : (
              <div className="space-y-3 p-4">
                <pre className="overflow-x-auto rounded border border-line bg-ground p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-dim">
                  {estimate.compiledSql}
                </pre>
                <div>
                  <div className="label">Bound parameters</div>
                  {estimate.params.length === 0 ? (
                    <p className="text-[12px] text-ink-faint">None — this predicate binds no values.</p>
                  ) : (
                    <ol className="space-y-1">
                      {estimate.params.map((param, index) => (
                        <li key={index} className="flex gap-2 font-mono text-[11px]">
                          <span className="text-accent">${index + 1}</span>
                          <span className="text-ink-dim">{JSON.stringify(param)}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </div>
            )
          )}
        </section>
      </div>

      <aside className="space-y-3">
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Estimate</span>
            {estimating && <span className="text-[11px] text-ink-faint">recounting…</span>}
          </div>
          {estimateError !== null ? (
            <ErrorState error={estimateError} title="The segment did not compile" />
          ) : estimate === null ? (
            <LoadingState rows={2} label="Counting" />
          ) : (
            <div className="p-4">
              <div
                className={clsx(
                  'text-3xl leading-none font-semibold tabular-nums transition-opacity',
                  estimating ? 'opacity-40' : 'opacity-100',
                )}
              >
                {int(estimate.count)}
              </div>
              <div className="mt-1.5 text-[12px] text-ink-dim">contacts matching the segment</div>
              <p className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-ink-faint">
                An <b className="text-held">upper bound</b>. This counts who matches the audience
                predicate. It does not subtract opt-outs, suppressed addresses, frequency caps or
                quiet-hours deferrals — those are evaluated per recipient at send time, so fewer
                messages than this will go out, and that is the system working.
              </p>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Sample</span>
            <Tooltip
              align="right"
              content={
                <>
                  <div className="mb-1 font-semibold text-ink">Ten real contacts</div>
                  <div className="text-ink-dim">
                    Drawn by the same compiled predicate that produced the count, not a second
                    query. Two implementations always drift, and the operator sees a count that
                    disagrees with who actually matched.
                  </div>
                </>
              }
            >
              <span className="text-[11px] text-ink-faint underline decoration-dotted underline-offset-4">
                why these
              </span>
            </Tooltip>
          </div>
          {estimate === null ? (
            <LoadingState rows={4} label="Sampling" />
          ) : estimate.sample.length === 0 ? (
            <EmptyState
              compact
              glyph="∅"
              title="No contact matches this segment"
              detail="The count is zero, so there is nothing to sample. Loosen a rule."
            />
          ) : (
            <ul className="divide-y divide-line">
              {estimate.sample.map((contact) => (
                <li key={contact.id} className="px-4 py-2">
                  <Link
                    to={`/contacts/${contact.id}`}
                    className="block truncate text-[12px] text-ink hover:text-accent"
                  >
                    {[contact.firstName, contact.lastName].filter(Boolean).join(' ') || '(no name)'}
                  </Link>
                  <div className="truncate text-[11px] text-ink-faint">
                    {contact.email ?? contact.phone ?? '—'}
                  </div>
                  {contact.tags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {contact.tags.slice(0, 4).map((tag) => (
                        <span key={tag} className="rounded bg-raised px-1 font-mono text-[10px] text-ink-faint">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}

function RuleGroup({
  group,
  rules,
  onChange,
}: {
  group: Group;
  rules: readonly AudienceRule[];
  onChange: (rules: AudienceRule[]) => void;
}) {
  return (
    <div className="p-4">
      <div className="mb-2 flex items-center gap-2">
        <span
          className={clsx(
            'rounded border px-1.5 py-px font-mono text-[11px] uppercase',
            group === 'all' && 'border-accent-dim bg-accent-wash text-accent',
            group === 'any' && 'border-info/40 bg-info-wash text-info',
            group === 'none' && 'border-bad/35 bg-bad-wash text-bad',
          )}
        >
          {group}
        </span>
        <span className="text-[11px] text-ink-faint">{GROUP_HELP[group]}</span>
        <button
          type="button"
          className="btn btn-ghost ml-auto"
          onClick={() => { onChange([...rules, { field: 'tags', op: 'contains', value: '' }]); }}
        >
          + rule
        </button>
      </div>

      {rules.length === 0 ? (
        <p className="text-[11px] text-ink-faint">No rules in this group.</p>
      ) : (
        <div className="space-y-1.5">
          {rules.map((rule, index) =>
            isLeaf(rule) ? (
              <LeafRow
                key={index}
                leaf={rule}
                onChange={(next) => {
                  const copy = [...rules];
                  copy[index] = next;
                  onChange(copy);
                }}
                onRemove={() => { onChange(rules.filter((_, position) => position !== index)); }}
              />
            ) : (
              <div key={index} className="rounded border border-held/30 bg-held-wash px-2 py-1.5 font-mono text-[11px] text-held">
                nested group — edit as JSON
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function LeafRow({
  leaf,
  onChange,
  onRemove,
}: {
  leaf: Leaf;
  onChange: (next: Leaf) => void;
  onRemove: () => void;
}) {
  const takesValue = !NO_VALUE_OPS.has(leaf.op);
  const isList = LIST_OPS.has(leaf.op);
  const isDays = DAY_OPS.has(leaf.op);
  const custom = !(leaf.field in AUDIENCE_FIELDS);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select
        className="input w-44"
        value={custom ? '__attribute' : leaf.field}
        onChange={(event) => {
          onChange({
            ...leaf,
            field: event.target.value === '__attribute' ? 'attributes.' : event.target.value,
          });
        }}
      >
        {Object.keys(AUDIENCE_FIELDS).map((field) => (
          <option key={field} value={field}>{field}</option>
        ))}
        <option value="__attribute">attributes.…</option>
      </select>

      {custom && (
        <input
          className="input w-44 font-mono text-[12px]"
          value={leaf.field}
          placeholder="attributes.plan"
          onChange={(event) => { onChange({ ...leaf, field: event.target.value }); }}
        />
      )}

      <select
        className="input w-40"
        value={leaf.op}
        onChange={(event) => {
          const op = event.target.value;
          const next: Leaf = { field: leaf.field, op };
          if (!NO_VALUE_OPS.has(op)) next.value = LIST_OPS.has(op) ? [] : (leaf.value ?? '');
          onChange(next);
        }}
      >
        {AudienceOperator.options.map((op) => (
          <option key={op} value={op}>{op}</option>
        ))}
      </select>

      {takesValue && (
        <input
          className="input min-w-40 flex-1 font-mono text-[12px]"
          placeholder={isList ? 'comma, separated, values' : isDays ? 'number of days' : 'value'}
          value={Array.isArray(leaf.value) ? (leaf.value as unknown[]).join(', ') : String(leaf.value ?? '')}
          onChange={(event) => {
            const text = event.target.value;
            const value: unknown = isList
              ? text.split(',').map((part) => part.trim()).filter((part) => part.length > 0)
              : isDays
                ? Number(text)
                : text;
            onChange({ ...leaf, value });
          }}
        />
      )}

      <button type="button" className="btn btn-ghost px-2" onClick={onRemove} aria-label="remove rule">
        ✕
      </button>
    </div>
  );
}
