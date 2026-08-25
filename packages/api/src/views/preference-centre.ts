import { escapeHtml } from '@campaign/core';
import { CampaignCategory } from '@campaign/shared';

/**
 * The preference centre, served as plain server-rendered HTML.
 *
 * No bundle, no framework, no client-side routing, and that is the point. This
 * page is reached from a link in an email that may be years old, opened in a
 * webmail proxy, on a corporate device, with JavaScript disabled or a script
 * blocker on. Every one of those has to be able to unsubscribe, because the
 * alternative to a working unsubscribe is a spam complaint, and complaints are
 * scored against the sending domain forever. A single `<form method="post">`
 * works in all of them.
 *
 * The page is also the only surface in this system a recipient — as opposed to an
 * operator — ever sees, which is why it states what it will do before it does it
 * rather than presenting six toggles and a save button.
 */

export type PreferenceCentreModel = {
  readonly token: string;
  readonly tenantName: string;
  readonly greetingName: string;
  readonly email: string | null;
  readonly phone: string | null;
  /** Current resolved state per category, for the channel this page is showing. */
  readonly categories: readonly {
    readonly category: string;
    readonly label: string;
    readonly optedIn: boolean;
  }[];
  readonly pausedUntil: string | null;
  readonly suppressed: boolean;
};

export const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  lifecycle: 'Order updates and follow-ups',
  promotional: 'Offers and promotions',
  transactional: 'Receipts and account notices',
  operational: 'Service and delivery notices',
};

/** Categories a recipient may switch off. Transactional and operational mail is
 *  not on the list because it carries information about something they bought. */
export const TOGGLEABLE_CATEGORIES: readonly string[] = CampaignCategory.options.filter(
  (c) => c === 'lifecycle' || c === 'promotional',
);

const STYLE = `
:root { color-scheme: light dark; }
body { font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0;
       background: #f6f7f9; color: #16181d; }
main { max-width: 34rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
.card { background: #fff; border: 1px solid #e3e6ea; border-radius: 12px; padding: 1.5rem; }
h1 { font-size: 1.35rem; margin: 0 0 .35rem; }
p.sub { margin: 0 0 1.5rem; color: #5b6270; }
fieldset { border: 0; padding: 0; margin: 0 0 1.5rem; }
legend { font-weight: 600; padding: 0; margin-bottom: .5rem; }
label.row { display: flex; gap: .7rem; align-items: flex-start; padding: .6rem 0;
            border-top: 1px solid #eef0f3; }
label.row:first-of-type { border-top: 0; }
button { font: inherit; border-radius: 8px; padding: .6rem 1rem; cursor: pointer; border: 1px solid #c8ccd3; background: #fff; }
button.primary { background: #16181d; color: #fff; border-color: #16181d; }
button.danger { color: #8a1c14; border-color: #e2b4af; }
.actions { display: flex; flex-wrap: wrap; gap: .6rem; }
.note { color: #5b6270; font-size: .875rem; margin-top: 1.5rem; }
.banner { background: #fdf3e7; border: 1px solid #f0d5ae; border-radius: 8px;
          padding: .75rem 1rem; margin-bottom: 1.25rem; }
@media (prefers-color-scheme: dark) {
  body { background: #101215; color: #e8eaee; }
  .card { background: #181b20; border-color: #2a2e36; }
  p.sub, .note { color: #9aa2b1; }
  label.row { border-color: #24282f; }
  button { background: #181b20; color: #e8eaee; border-color: #3a3f49; }
  button.primary { background: #e8eaee; color: #101215; border-color: #e8eaee; }
  .banner { background: #2a2118; border-color: #4a3a22; }
}
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function renderPreferenceCentre(model: PreferenceCentreModel): string {
  const action = `/u/${encodeURIComponent(model.token)}`;
  const address = model.email ?? model.phone ?? 'this address';

  const banner = model.suppressed
    ? `<div class="banner">You are currently unsubscribed from all marketing messages at
         <strong>${escapeHtml(address)}</strong>. Turning a category back on below will resubscribe you.</div>`
    : model.pausedUntil !== null
      ? `<div class="banner">Messages are paused until
           <strong>${escapeHtml(model.pausedUntil)}</strong>.</div>`
      : '';

  const rows = model.categories
    .map(
      (c) => `
      <label class="row">
        <input type="checkbox" name="category:${escapeHtml(c.category)}" value="opted_in"${
          c.optedIn ? ' checked' : ''
        }>
        <span><strong>${escapeHtml(c.label)}</strong></span>
      </label>`,
    )
    .join('');

  return page(
    `Email preferences — ${model.tenantName}`,
    `<div class="card">
      <h1>Email preferences</h1>
      <p class="sub">${escapeHtml(model.greetingName)}, these settings control what
        ${escapeHtml(model.tenantName)} sends to ${escapeHtml(address)}.</p>
      ${banner}

      <form method="post" action="${escapeHtml(action)}">
        <input type="hidden" name="channel" value="email">
        <fieldset>
          <legend>What you receive</legend>
          ${rows}
        </fieldset>
        <div class="actions">
          <button class="primary" type="submit" name="action" value="update">Save preferences</button>
          <button type="submit" name="action" value="pause">Pause everything for 30 days</button>
          <button class="danger" type="submit" name="action" value="unsubscribe_all">Unsubscribe from everything</button>
        </div>
      </form>

      <p class="note">Receipts, delivery notices and other messages about something you
        bought are not marketing and are not affected by these settings.</p>
    </div>`,
  );
}

export function renderPreferenceResult(model: {
  readonly tenantName: string;
  readonly headline: string;
  readonly detail: string;
  readonly token: string | null;
}): string {
  const back =
    model.token === null
      ? ''
      : `<p class="note"><a href="/u/${escapeHtml(encodeURIComponent(model.token))}">Change these settings again</a></p>`;
  return page(
    `${model.headline} — ${model.tenantName}`,
    `<div class="card">
      <h1>${escapeHtml(model.headline)}</h1>
      <p class="sub">${escapeHtml(model.detail)}</p>
      ${back}
    </div>`,
  );
}

/**
 * The page for a token that does not resolve.
 *
 * It is HTML with a 404, not a JSON error envelope. A recipient who followed a
 * link from an old email is not an API client, and handing them
 * `{"error":{"code":"not_found"}}` is how a person who wanted to unsubscribe
 * decides that reporting the message as spam is easier.
 */
export function renderUnknownToken(): string {
  return page(
    'This link is no longer valid',
    `<div class="card">
      <h1>This link is no longer valid</h1>
      <p class="sub">The preference link you followed has expired or was already replaced.
        Open the most recent message you received and use the unsubscribe link at the
        bottom of it, or reply to that message and ask to be removed.</p>
    </div>`,
  );
}
