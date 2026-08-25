import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import type { Channel, SendCondition } from '@campaign/shared';
import { api } from '../../lib/api.ts';
import type { CampaignMessage, MergeFieldsResponse, ValidateResponse } from '../../lib/types.ts';
import { useCampaign } from '../CampaignEditor.tsx';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.tsx';
import { ChannelBadge, Pill } from '../../components/Pill.tsx';
import { minutes } from '../../lib/format.ts';
import { Tooltip } from '../../components/Tooltip.tsx';

const SEND_CONDITIONS: readonly SendCondition[] = [
  'always',
  'opened_previous',
  'not_opened_previous',
  'clicked_previous',
  'not_clicked_previous',
  'replied',
  'not_replied',
];

/**
 * The message editor.
 *
 * Two things here are not decoration:
 *
 *  1. VALIDATION COMES FROM THE SERVER. `POST /templates/validate` calls the same
 *     `validateTemplate` that `/activate` calls, so what the editor says and what
 *     activation decides cannot disagree. A client-side copy of those rules is how
 *     a campaign passes every check the operator can see and then refuses to
 *     activate for a reason the UI has no words for.
 *
 *  2. THE SMS SEGMENT COUNT COMES FROM THE SERVER TOO. Segments are counted on the
 *     RENDERED length with GSM-7/UCS-2 detection, not on the template — a
 *     twenty-two character merge token becomes whatever the longest real first
 *     name happens to be, and one curly apostrophe halves the segment size. That
 *     arithmetic lives in core and is not repeated here.
 */
export function MessagesTab() {
  const { campaignId, campaign, messages, reload, activationFailures } = useCampaign();
  const [selectedId, setSelectedId] = useState<string | null>(messages[0]?.id ?? null);
  const [error, setError] = useState<unknown>(null);

  const selected = messages.find((message) => message.id === selectedId) ?? messages[0];

  const create = useMutation({
    mutationFn: (channel: Channel) =>
      api.post<{ message: CampaignMessage }>(`/campaigns/${campaignId}/messages`, {
        channel,
        sequenceOrder: Math.max(0, ...messages.map((message) => message.sequenceOrder)) + 1,
        bodyTemplate:
          channel === 'email'
            ? 'Hi {{contact.first_name}},\n\n\n\nUnsubscribe: {{unsubscribe_url}}'
            : 'Hi {{contact.first_name}} — ',
        ...(channel === 'email' ? { subjectTemplate: 'New message' } : {}),
      }),
    onMutate: () => { setError(null); },
    onSuccess: (result) => {
      setSelectedId(result.message.id);
      reload();
    },
    onError: setError,
  });

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-[260px_1fr]">
      <aside className="panel h-fit">
        <div className="panel-head">
          <span className="panel-title">Sequence</span>
        </div>
        {messages.length === 0 ? (
          <EmptyState
            compact
            glyph="✎"
            title="No messages yet"
            detail="A campaign with no enabled messages enrols contacts and sends nothing — activation refuses it."
          />
        ) : (
          <ul className="divide-y divide-line">
            {messages.map((message) => {
              const failures = activationFailures.get(message.id) ?? [];
              return (
                <li key={message.id}>
                  <button
                    type="button"
                    onClick={() => { setSelectedId(message.id); }}
                    className={clsx(
                      'flex w-full items-start gap-2 px-3 py-2 text-left transition-colors',
                      selected?.id === message.id ? 'bg-accent-wash' : 'hover:bg-raised',
                    )}
                  >
                    <span className="mt-px w-4 shrink-0 text-center font-mono text-[11px] text-ink-faint">
                      {message.sequenceOrder}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <ChannelBadge channel={message.channel} />
                        {!message.isEnabled && <Pill tone="quiet">disabled</Pill>}
                        {failures.length > 0 && <Pill tone="bad">{failures.length}</Pill>}
                      </span>
                      <span className="mt-0.5 block truncate text-[12px] text-ink">
                        {message.subjectTemplate ?? message.bodyTemplate.slice(0, 40) || '(empty)'}
                      </span>
                      <span className="block truncate text-[11px] text-ink-faint">
                        {minutes(message.delayMinutes)} after {message.delayAnchor}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex gap-1.5 border-t border-line p-2">
          {campaign.channels.map((channel) => (
            <button
              key={channel}
              type="button"
              className="btn flex-1 justify-center"
              disabled={create.isPending}
              onClick={() => { create.mutate(channel); }}
            >
              + {channel.toUpperCase()}
            </button>
          ))}
        </div>
      </aside>

      <div className="min-w-0">
        {error !== null && <ErrorState error={error} />}
        {selected === undefined ? (
          <EmptyState
            glyph="✉"
            title="Nothing selected"
            detail="Add a message on the left to start editing."
          />
        ) : (
          <MessageEditor key={selected.id} message={selected} />
        )}
      </div>
    </div>
  );
}

function MessageEditor({ message }: { message: CampaignMessage }) {
  const { campaignId, campaign, reload, activationFailures } = useCampaign();
  const [subject, setSubject] = useState(message.subjectTemplate ?? '');
  const [body, setBody] = useState(message.bodyTemplate);
  const [html, setHtml] = useState(message.htmlTemplate ?? '');
  const [validation, setValidation] = useState<ValidateResponse | null>(null);
  const [validationError, setValidationError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);

  const mergeFields = useQuery({
    queryKey: ['merge-fields'],
    queryFn: () => api.get<MergeFieldsResponse>('/merge-fields'),
    staleTime: Infinity,
  });

  // Debounced against the same endpoint activation uses. 350ms keeps the SMS
  // segment counter feeling live without a request per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      api
        .post<ValidateResponse>('/templates/validate', {
          channel: message.channel,
          category: campaign.category,
          subjectTemplate: subject.length === 0 ? null : subject,
          bodyTemplate: body,
          htmlTemplate: html.length === 0 ? null : html,
        })
        .then((result) => {
          setValidation(result);
          setValidationError(null);
        })
        .catch((caught: unknown) => { setValidationError(caught); });
    }, 350);
    return () => { window.clearTimeout(timer); };
  }, [subject, body, html, message.channel, campaign.category]);

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api.patch(`/campaigns/${campaignId}/messages/${message.id}`, patch),
    onMutate: () => { setError(null); },
    onSuccess: reload,
    onError: setError,
  });

  const dirty =
    subject !== (message.subjectTemplate ?? '') ||
    body !== message.bodyTemplate ||
    html !== (message.htmlTemplate ?? '');

  const failures = activationFailures.get(message.id) ?? [];

  return (
    <div className="space-y-3">
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title flex items-center gap-2">
            <ChannelBadge channel={message.channel} />
            Message {message.sequenceOrder}
          </span>
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-ink-dim">
              <input
                type="checkbox"
                className="accent-accent"
                checked={message.isEnabled}
                onChange={(event) => { save.mutate({ isEnabled: event.target.checked }); }}
              />
              enabled
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!dirty || save.isPending}
              onClick={() => {
                save.mutate({
                  subjectTemplate: subject.length === 0 ? null : subject,
                  bodyTemplate: body,
                  htmlTemplate: html.length === 0 ? null : html,
                });
              }}
            >
              {save.isPending ? 'Saving…' : dirty ? 'Save' : 'Saved'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 border-b border-line p-4">
          <div>
            <label className="label" htmlFor="anchor">Delay anchor</label>
            <select
              id="anchor"
              className="input"
              value={message.delayAnchor}
              onChange={(event) => { save.mutate({ delayAnchor: event.target.value }); }}
            >
              <option value="trigger">trigger</option>
              <option value="previous">previous message</option>
              <option value="delivery">order delivery</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="delay">Delay (minutes)</label>
            <input
              id="delay"
              type="number"
              min={0}
              className="input"
              defaultValue={message.delayMinutes}
              onBlur={(event) => {
                const value = Number(event.target.value);
                if (Number.isInteger(value) && value !== message.delayMinutes) {
                  save.mutate({ delayMinutes: value });
                }
              }}
            />
            <p className="mt-1 text-[11px] text-ink-faint">{minutes(message.delayMinutes)}</p>
          </div>
          <div>
            <label className="label" htmlFor="condition">Send condition</label>
            <select
              id="condition"
              className="input"
              value={message.sendCondition}
              onChange={(event) => { save.mutate({ sendCondition: event.target.value }); }}
            >
              {SEND_CONDITIONS.map((condition) => (
                <option key={condition} value={condition}>{condition}</option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-ink-faint">Re-evaluated at send time, not at enqueue.</p>
          </div>
        </div>

        {error !== null && <ErrorState error={error} title="The message was not saved" />}

        {failures.length > 0 && (
          <div className="border-b border-bad/20 bg-bad-wash px-4 py-2">
            <div className="mb-1 text-[12px] font-medium text-bad">Activation refused this message</div>
            <ul className="list-disc space-y-0.5 pl-4 text-[12px] text-ink-dim">
              {failures.map((failure, index) => <li key={index}>{failure}</li>)}
            </ul>
          </div>
        )}

        <div className="space-y-3 p-4">
          {message.channel === 'email' && (
            <div>
              <label className="label" htmlFor="subject">Subject</label>
              <input
                id="subject"
                className="input"
                value={subject}
                onChange={(event) => { setSubject(event.target.value); }}
                placeholder="Your order {{order.number}} is on its way"
              />
            </div>
          )}

          <div>
            <label className="label" htmlFor="body">
              {message.channel === 'sms' ? 'SMS body' : 'Plain-text body'}
            </label>
            <textarea
              id="body"
              className="input min-h-32 resize-y font-mono text-[12px] leading-relaxed"
              value={body}
              spellCheck={false}
              onChange={(event) => { setBody(event.target.value); }}
            />
            {message.channel === 'sms' && <SegmentCounter validation={validation} body={body} />}
          </div>

          {message.channel === 'email' && (
            <div>
              <label className="label" htmlFor="html">HTML body</label>
              <textarea
                id="html"
                className="input min-h-48 resize-y font-mono text-[12px] leading-relaxed"
                value={html}
                spellCheck={false}
                placeholder="<p>Hi {{contact.first_name}},</p>"
                onChange={(event) => { setHtml(event.target.value); }}
              />
            </div>
          )}

          {mergeFields.data !== undefined && (
            <div>
              <span className="label">Merge fields</span>
              <div className="flex flex-wrap gap-1">
                {mergeFields.data.fields.map((field) => {
                  const unusable = field.requiresOrder && !campaign.triggerType.startsWith('order_');
                  return (
                    <Tooltip
                      key={field.name}
                      content={
                        <>
                          <div className="mb-1 font-mono text-[11px] text-accent">
                            {'{{'}{field.name}{'}}'}
                          </div>
                          <div className="text-ink-dim">
                            {field.description ?? 'No description.'}
                            {unusable && (
                              <>
                                {' '}
                                <b className="text-held">
                                  This campaign has no order anchor, so this would render empty for
                                  every recipient — activation rejects it.
                                </b>
                              </>
                            )}
                          </div>
                        </>
                      }
                    >
                      <button
                        type="button"
                        className={clsx(
                          'rounded border px-1.5 py-px font-mono text-[10px]',
                          unusable
                            ? 'border-held/30 bg-held-wash text-held/70'
                            : 'border-line text-ink-dim hover:border-accent-dim hover:text-accent',
                        )}
                        onClick={() => { setBody(`${body}{{${field.name}}}`); }}
                      >
                        {field.name}
                      </button>
                    </Tooltip>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </section>

      <div className="grid gap-3 lg:grid-cols-2">
        <Validation validation={validation} error={validationError} category={campaign.category} />
        {message.channel === 'email' ? (
          <HtmlPreview html={html} body={body} subject={subject} />
        ) : (
          <PhonePreview body={body} validation={validation} />
        )}
      </div>
    </div>
  );
}

/**
 * The segment counter, and what it costs.
 *
 * The number comes from the server because the rule that matters — GSM-7 versus
 * UCS-2, measured on the RENDERED string with the longest realistic merge values —
 * is domain logic. The raw character count is shown next to it precisely so the
 * gap between "155 characters" and "3 segments" is visible.
 */
function SegmentCounter({ validation, body }: { validation: ValidateResponse | null; body: string }) {
  const segments = validation?.smsSegments;
  const rendered = validation?.renderedLength;
  const tone = segments === undefined ? 'quiet' : segments <= 1 ? 'ok' : segments <= 2 ? 'held' : 'bad';

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
      <Tooltip
        align="left"
        content={
          <>
            <div className="mb-1 font-semibold text-ink">Billed segments</div>
            <div className="text-ink-dim">
              Counted by the server on the <b>rendered</b> body using the longest realistic merge
              values, not on the template. A single non-GSM character — a curly apostrophe pasted
              from a word processor — switches the whole message to UCS-2 and halves the segment
              size from 153 to 67 characters.
            </div>
          </>
        }
      >
        <Pill tone={tone}>
          {segments === undefined ? '— segments' : `${String(segments)} segment${segments === 1 ? '' : 's'}`}
        </Pill>
      </Tooltip>
      <span className="text-ink-faint">
        rendered {rendered ?? '—'} chars · template {body.length} chars
      </span>
      {validation === null && <span className="text-ink-faint">counting…</span>}
    </div>
  );
}

function Validation({
  validation,
  error,
  category,
}: {
  validation: ValidateResponse | null;
  error: unknown;
  category: string;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">Validation</span>
        <span className="text-[11px] text-ink-faint">POST /templates/validate</span>
      </div>
      {error !== null ? (
        <ErrorState error={error} title="Validation could not run" />
      ) : validation === null ? (
        <LoadingState rows={2} label="Validating" />
      ) : (
        <div className="space-y-3 p-4">
          <div className="flex items-center gap-2">
            <Pill tone={validation.ok ? 'ok' : 'bad'}>
              {validation.ok ? 'Passes' : `${String(validation.errors.length)} error${validation.errors.length === 1 ? '' : 's'}`}
            </Pill>
            {validation.warnings.length > 0 && (
              <Pill tone="held">{validation.warnings.length} warning{validation.warnings.length === 1 ? '' : 's'}</Pill>
            )}
            <Tooltip
              content={
                <div className="text-ink-dim">
                  A delivered message with nothing to click must never sit in the denominator of a
                  click rate (I12). If this stays false, the campaign will have no click rate at
                  all — which is correct, and worth knowing now rather than later.
                </div>
              }
            >
              <Pill tone={validation.hasClickableLink ? 'accent' : 'quiet'}>
                {validation.hasClickableLink ? 'has a clickable link' : 'no clickable link'}
              </Pill>
            </Tooltip>
          </div>

          {validation.errors.length === 0 && validation.warnings.length === 0 ? (
            <p className="text-[12px] leading-relaxed text-ink-faint">
              No problems. {category === 'lifecycle' || category === 'promotional'
                ? 'A resolvable opt-out was found, which is what a marketing template needs before it can be activated (I7).'
                : 'This category is not required to carry an opt-out.'}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {validation.errors.map((issue, index) => (
                <li key={`e${String(index)}`} className="flex gap-2 rounded border border-bad/25 bg-bad-wash px-2 py-1.5 text-[12px]">
                  {issue.field !== undefined && (
                    <code className="shrink-0 font-mono text-[11px] text-bad">{issue.field}</code>
                  )}
                  <span className="text-ink-dim">{issue.message}</span>
                </li>
              ))}
              {validation.warnings.map((issue, index) => (
                <li key={`w${String(index)}`} className="flex gap-2 rounded border border-held/25 bg-held-wash px-2 py-1.5 text-[12px]">
                  {issue.field !== undefined && (
                    <code className="shrink-0 font-mono text-[11px] text-held">{issue.field}</code>
                  )}
                  <span className="text-ink-dim">{issue.message}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="border-t border-line pt-2 text-[11px] text-ink-faint">
            <div className="mb-1">
              merge fields:{' '}
              {validation.mergeFields.length === 0
                ? '—'
                : validation.mergeFields.map((field) => (
                    <code key={field} className="mr-1 font-mono text-ink-dim">{field}</code>
                  ))}
            </div>
            <div>
              links:{' '}
              {validation.links.length === 0
                ? '—'
                : validation.links.map((link) => (
                    <code key={link} className="mr-1 font-mono break-all text-ink-dim">{link}</code>
                  ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * The live preview.
 *
 * `sandbox` with no allowances: no scripts, no forms, no navigation. The document
 * being rendered is operator-authored HTML with contact data merged into it, and
 * the whole reason merge values are HTML-escaped in core is that a customer whose
 * surname is a script tag should not be able to run anything. Rendering it
 * unsandboxed in the operator's own session would undo that.
 */
function HtmlPreview({ html, body, subject }: { html: string; body: string; subject: string }) {
  const [mode, setMode] = useState<'html' | 'text'>('html');
  const hasHtml = html.trim().length > 0;

  return (
    <section className="panel flex flex-col">
      <div className="panel-head">
        <span className="panel-title">Preview</span>
        <div className="flex gap-1">
          <button
            type="button"
            className={clsx('btn btn-ghost', mode === 'html' && 'text-accent')}
            onClick={() => { setMode('html'); }}
          >
            HTML
          </button>
          <button
            type="button"
            className={clsx('btn btn-ghost', mode === 'text' && 'text-accent')}
            onClick={() => { setMode('text'); }}
          >
            Plain text
          </button>
        </div>
      </div>
      <div className="border-b border-line px-4 py-2 text-[12px]">
        <span className="text-ink-faint">Subject </span>
        <span className="text-ink">{subject.length === 0 ? '—' : subject}</span>
      </div>
      {mode === 'text' ? (
        <pre className="min-h-72 flex-1 overflow-auto bg-ground p-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink-dim">
          {body.length === 0 ? '(empty)' : body}
        </pre>
      ) : hasHtml ? (
        <iframe
          title="HTML preview"
          sandbox=""
          className="min-h-72 flex-1 bg-white"
          srcDoc={`<!doctype html><meta charset="utf-8"><style>body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:16px;color:#111}</style>${html}`}
        />
      ) : (
        <EmptyState
          compact
          glyph="◫"
          title="No HTML body"
          detail="Recipients will receive the plain-text part only. That is a valid choice, not an error."
        />
      )}
      <p className="border-t border-line px-4 py-2 text-[11px] leading-relaxed text-ink-faint">
        Merge tokens are shown unrendered. For a render against real contact data, use{' '}
        <code className="font-mono">POST /campaigns/:id/preview</code> from the Overview tab&rsquo;s
        test send, which uses the same renderer the send path uses.
      </p>
    </section>
  );
}

/** SMS, in something shaped like the device it arrives on. */
function PhonePreview({ body, validation }: { body: string; validation: ValidateResponse | null }) {
  const segments = validation?.smsSegments ?? 1;
  const limit = segments > 1 ? 153 : 160;
  const parts: string[] = [];
  for (let index = 0; index < Math.max(1, Math.ceil(body.length / limit)); index += 1) {
    parts.push(body.slice(index * limit, (index + 1) * limit));
  }

  return (
    <section className="panel flex flex-col">
      <div className="panel-head">
        <span className="panel-title">Handset preview</span>
        <span className="text-[11px] text-ink-faint">split shown at {limit} chars</span>
      </div>
      <div className="flex flex-1 items-start justify-center bg-ground/60 p-6">
        <div className="w-64 rounded-[26px] border-4 border-line-strong bg-[#0d1013] p-3 shadow-2xl shadow-black/60">
          <div className="mx-auto mb-3 h-1 w-12 rounded-full bg-line-strong" />
          <div className="space-y-1.5">
            {body.length === 0 ? (
              <div className="rounded-2xl rounded-bl-sm bg-raised px-3 py-2 text-[12px] text-ink-faint italic">
                (empty)
              </div>
            ) : (
              parts.map((part, index) => (
                <div
                  key={index}
                  className="rounded-2xl rounded-bl-sm bg-[#1f2b3d] px-3 py-2 text-[12px] leading-relaxed break-words text-ink"
                >
                  {part}
                </div>
              ))
            )}
          </div>
          <div className="mt-3 text-center text-[10px] text-ink-faint">
            {validation?.smsSegments === undefined
              ? 'segment count pending'
              : `${String(validation.smsSegments)} billed segment${validation.smsSegments === 1 ? '' : 's'}`}
          </div>
        </div>
      </div>
    </section>
  );
}
