/**
 * I7 — the unsubscribe link in a real rendered email RESOLVES.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this test exists, and why it is shaped the way it is.
 *
 * An unsubscribe link that points at no route is the perfect bug. It ships. It
 * passes every unit test, because the template contains `{{unsubscribe_url}}` and
 * the renderer substitutes it and both of those are correct. It passes review,
 * because the route table has a `/u/:token` in it somewhere. And then every
 * recipient who wants out reaches a blank page, for the entire life of the system,
 * and nothing detects it — because nobody who works on the product ever clicks an
 * unsubscribe link in their own marketing mail.
 *
 * The consequence is not a 404 in a log. It is that the only remaining exit is the
 * spam button, and complaint rate is scored against the sending domain for months.
 *
 * So this test refuses every shortcut that would let the bug survive it:
 *
 *   - It BOOTS THE REAL APP on a real socket, rather than asserting against a
 *     route table. A route registered under the wrong prefix, or shadowed by an
 *     earlier `app.use`, is exactly the failure being hunted.
 *   - It RENDERS a real marketing email through core's `validateTemplate` and
 *     `render` — the same two functions the send path uses.
 *   - It parses the href out of the RENDERED HTML, not out of the template. The
 *     template's href is `{{unsubscribe_url}}`, which resolves fine and proves
 *     nothing; the rendered one is what lands in the inbox.
 *   - It FETCHES that URL over HTTP and demands 200 AND A NON-EMPTY BODY. A 200
 *     with a blank page is the same experience as a 404.
 *   - Then it POSTS the opt-out and checks the queue actually emptied, because an
 *     unsubscribe that records a preference and lets the three already-queued
 *     messages go out has not listened.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { serve } from '@hono/node-server';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import {
  seedTenant,
  seedContact,
  seedCampaign,
  seedCampaignMessage,
  optIn,
} from '../support/fixtures.ts';
import { FakeClock, render, validateTemplate } from '@campaign/core';
import type { MergeContext } from '@campaign/core';
import {
  buildDeps,
  createApp,
  mintUnsubscribeToken,
  unsubscribeUrl,
  hashPassword,
  type App,
} from '@campaign/api';

const CLOCK = new FakeClock('2026-06-15T12:00:00Z');
const SECRET = new TextEncoder().encode('i7-suite-secret');
const KEY = Buffer.alloc(32, 0x77);

/** A real socket, because the point is that the URL in the email resolves. */
const PORT = 43117;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/** A marketing email as an operator would actually write one. */
const SUBJECT = 'Thanks for your order, {{contact.first_name}}';
const BODY =
  'Hi {{contact.first_name}},\n\n' +
  'Thanks for shopping with us.\n\n' +
  'If you would rather not hear from us: {{unsubscribe_url}}\n';
const HTML =
  '<html><body>' +
  '<h1>Thanks, {{contact.first_name}}</h1>' +
  '<p>Your order is on its way.</p>' +
  '<p><a href="https://shop.example.com/orders">Track your order</a></p>' +
  '<hr>' +
  '<p class="footer"><a href="{{unsubscribe_url}}">Unsubscribe from these emails</a></p>' +
  '</body></html>';

let app: App;
let server: ReturnType<typeof serve>;

beforeAll(async () => {
  await resetDb();
  app = createApp(
    buildDeps({
      db: testDb(),
      clock: CLOCK,
      jwtSecret: SECRET,
      encryptionKey: KEY,
      publicBaseUrl: BASE_URL,
      rateLimit: { limit: 10_000, windowMs: 60_000, publicLimit: 10_000, loginLimit: 10_000 },
      env: { ...process.env, LOG_LEVEL: 'silent' },
    }),
  );
  server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await closeTestDb();
});

type World = {
  tenantId: string;
  contactId: string;
  campaignId: string;
  versionId: string;
  campaignMessageId: string;
  email: string;
  queuedIds: string[];
};

/** A tenant, an opted-in contact, a live marketing campaign, three queued mails. */
async function seedWorld(email: string, queuedCount = 3): Promise<World> {
  const db = testDb();
  const tenantId = await seedTenant(db, { name: 'Northwind Coffee' });
  const contactId = await seedContact(db, tenantId, { email });
  await optIn(db, tenantId, contactId, 'email');

  const { campaignId, versionId } = await seedCampaign(db, tenantId, {
    name: 'Post-purchase',
    category: 'promotional',
    status: 'active',
  });
  const campaignMessageId = await seedCampaignMessage(db, tenantId, campaignId, {
    subject: SUBJECT,
    body: BODY,
  });
  await db.query(`UPDATE campaign_messages SET html_template = $2 WHERE id = $1`, [
    campaignMessageId,
    HTML,
  ]);

  const { rows: enrolment } = await db.query<{ id: string }>(
    `INSERT INTO enrollments (tenant_id, campaign_id, campaign_version_id, contact_id, anchor_type)
     VALUES ($1,$2,$3,$4,'manual') RETURNING id`,
    [tenantId, campaignId, versionId, contactId],
  );

  const queuedIds: string[] = [];
  for (let i = 0; i < queuedCount; i++) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO message_queue
         (tenant_id, enrollment_id, campaign_id, campaign_version_id, campaign_message_id,
          contact_id, anchor_id, channel, recipient_address, rendered_subject, rendered_body,
          scheduled_at)
       VALUES ($1,$2,$3,$4,$5,$6,gen_random_uuid(),'email',$7,'s','b',
               $8::timestamptz) RETURNING id`,
      [
        tenantId,
        enrolment[0]!.id,
        campaignId,
        versionId,
        campaignMessageId,
        contactId,
        email,
        new Date(CLOCK.now().getTime() + (i + 1) * 86_400_000).toISOString(),
      ],
    );
    queuedIds.push(rows[0]!.id);
  }

  return { tenantId, contactId, campaignId, versionId, campaignMessageId, email, queuedIds };
}

/**
 * Pull hrefs out of the RENDERED html.
 *
 * A regex is acceptable here because what is being parsed is our own rendered
 * output, not arbitrary internet HTML — and crucially it is parsed AFTER
 * rendering. Matching `{{unsubscribe_url}}` in the template would pass forever
 * while the rendered link pointed at nothing.
 */
function hrefs(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1] ?? '');
}

describe('I7 — a rendered marketing email carries a link that resolves', () => {
  it('validates, renders, and the href in the OUTPUT is fetchable with a real body', async () => {
    await resetDb();
    const world = await seedWorld('reader@example.com');

    // ── 1. The template is a valid marketing template. ──────────────────────
    const validation = validateTemplate(
      { channel: 'email', subject: SUBJECT, body: BODY, html: HTML },
      'promotional',
    );
    expect(validation.errors, JSON.stringify(validation.errors)).toEqual([]);
    expect(validation.mergeFields).toContain('unsubscribe_url');

    // ── 2. Render it for a real contact, with a real minted token. ──────────
    const token = await mintUnsubscribeToken(testDb(), {
      tenantId: world.tenantId,
      contactId: world.contactId,
    });
    const url = unsubscribeUrl(BASE_URL, token);
    const context: MergeContext = {
      contact: { first_name: 'Ada', last_name: 'Lovelace', email: world.email },
      unsubscribe_url: url,
      preferences_url: url,
    };
    const renderedHtml = render(HTML, context, { escape: true });

    // The template's placeholder is gone; something concrete took its place.
    expect(renderedHtml).not.toContain('{{');
    expect(renderedHtml).toContain('Ada');

    // ── 3. Extract the unsubscribe href from the RENDERED html. ─────────────
    const links = hrefs(renderedHtml);
    expect(links.length, 'the rendered email should contain links').toBeGreaterThan(0);

    const unsubscribeHref = links.find((href) => href.includes('/u/'));
    expect(
      unsubscribeHref,
      `no unsubscribe link found in the rendered email. Links were: ${links.join(', ')}`,
    ).toBeDefined();
    expect(unsubscribeHref).toBe(url);

    // ── 4. Fetch it against the booted app. THE ASSERTION. ──────────────────
    const response = await fetch(unsubscribeHref!);
    expect(
      response.status,
      'the unsubscribe link in a real rendered email must resolve to a real route',
    ).toBe(200);

    const body = await response.text();
    // A 200 with an empty body is the same experience as a 404.
    expect(body.length, 'the preference centre must render something').toBeGreaterThan(200);
    expect(body).toContain('<form');
    expect(body).toContain('unsubscribe_all');
    // It has to work without JavaScript: a plain form post, in a webmail proxy.
    expect(body).toContain('method="post"');
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('POSTing the opt-out cancels every message already queued', async () => {
    await resetDb();
    const world = await seedWorld('leaver@example.com');

    const token = await mintUnsubscribeToken(testDb(), {
      tenantId: world.tenantId,
      contactId: world.contactId,
    });
    const url = unsubscribeUrl(BASE_URL, token);

    const before = await testDb().query<{ status: string }>(
      `SELECT status FROM message_queue WHERE contact_id = $1`,
      [world.contactId],
    );
    expect(before.rows.map((r) => r.status)).toEqual(['pending', 'pending', 'pending']);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'unsubscribe_all', channel: 'email' }),
    });
    expect(response.status).toBe(200);

    const result = (await response.json()) as { cancelledMessageIds: string[] };
    expect(result.cancelledMessageIds).toHaveLength(3);

    // "Unsubscribed" while three messages are still queued is not unsubscribed.
    const after = await testDb().query<{ status: string; provider_error_code: string | null }>(
      `SELECT status, provider_error_code FROM message_queue WHERE contact_id = $1`,
      [world.contactId],
    );
    expect(after.rows.every((r) => r.status === 'cancelled')).toBe(true);
    expect(after.rows.every((r) => r.provider_error_code === 'suppressed_unsubscribe')).toBe(true);

    // The ledger records WHO asked and HOW, and the address is suppressed so a
    // re-import of the same person cannot resurrect it.
    const consent = await testDb().query<{
      state: string;
      source: string;
      evidence: Record<string, unknown>;
    }>(
      `SELECT state, source, evidence FROM contact_consents
        WHERE contact_id = $1 AND state = 'opted_out'`,
      [world.contactId],
    );
    expect(consent.rows).toHaveLength(1);
    expect(consent.rows[0]!.source).toBe('unsubscribe_link');
    expect(consent.rows[0]!.evidence['token']).toBe(token);

    const suppression = await testDb().query<{ reason: string }>(
      `SELECT reason FROM suppressions WHERE tenant_id = $1 AND address = $2`,
      [world.tenantId, world.email],
    );
    expect(suppression.rows[0]!.reason).toBe('unsubscribe');
  });

  it('the same link still works after it has been used', async () => {
    // A token burned on first use is a dead link for the person who comes back a
    // week later to re-enable one category. Dead preference links are how somebody
    // who wanted one fewer email reports the whole sender as spam instead.
    await resetDb();
    const world = await seedWorld('returner@example.com', 0);
    const token = await mintUnsubscribeToken(testDb(), {
      tenantId: world.tenantId,
      contactId: world.contactId,
    });
    const url = unsubscribeUrl(BASE_URL, token);

    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'unsubscribe_all' }),
    });

    const second = await fetch(url);
    expect(second.status).toBe(200);
    const body = await second.text();
    expect(body.length).toBeGreaterThan(200);
    // And it tells them what state they are actually in.
    expect(body).toContain('unsubscribed from all marketing messages');
  });

  it('a token that does not resolve still renders a page, never a blank one', async () => {
    const response = await fetch(`${BASE_URL}/u/this-token-was-never-issued`);
    // Not 200 — the link genuinely is not valid — but a recipient following a link
    // from an old email is not an API client, so they get HTML that tells them what
    // to do rather than a JSON error envelope.
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/html');
    const body = await response.text();
    expect(body.length).toBeGreaterThan(200);
    expect(body).toContain('no longer valid');
  });

  it("the app's own preview produces a link that resolves too", async () => {
    // Closes the loop: the operator checking their copy clicks the link in the
    // preview, and it must reach the same working page the recipient reaches. A
    // preview that renders `/u/PREVIEW` makes the one link that must work the one
    // link nobody ever exercises.
    await resetDb();
    const world = await seedWorld('previewed@example.com', 0);
    const db = testDb();
    const password = 'correct horse battery staple';
    const email = `op-${Math.random().toString(36).slice(2, 10)}@example.com`;
    await db.query(
      `INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1,$2,$3,'owner')`,
      [world.tenantId, email, await hashPassword(password)],
    );
    const login = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, tenantId: world.tenantId }),
    });
    const { token: jwt } = (await login.json()) as { token: string };

    const preview = await fetch(`${BASE_URL}/campaigns/${world.campaignId}/preview`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ contactId: world.contactId }),
    });
    expect(preview.status).toBe(200);

    const body = (await preview.json()) as {
      preview: { html: string; validation: { errors: unknown[] } };
    };
    expect(body.preview.validation.errors).toEqual([]);

    const link = hrefs(body.preview.html).find((href) => href.includes('/u/'));
    expect(link).toBeDefined();

    const resolved = await fetch(link!);
    expect(resolved.status).toBe(200);
    expect((await resolved.text()).length).toBeGreaterThan(200);
  });
});
