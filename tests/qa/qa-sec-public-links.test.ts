/**
 * ATTACK: GET /t/c/:shortCode and GET /r/:shortCode — the click redirect.
 *
 * qa-sec-public-webhooks.test.ts covers the pixel, the preference centre and the
 * provider callback. These two are the remaining unauthenticated routes, and they
 * are the interesting ones because a redirect on a domain that also sends mail is
 * the most valuable thing in the system to an attacker: the domain's sending
 * reputation is what makes a phishing link get delivered.
 *
 * Both paths share one handler, so both are driven here — a guard added to `/t/c/`
 * and forgotten on `/r/` is the shape of the bug.
 *
 * There is a second finding in this file that is not an attack at all: NOTHING in
 * packages/ ever inserts into `tracking_links`. The last test pins that.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { testDb, resetDb, closeTestDb } from '../support/db.ts';
import type { App } from '@campaign/api';
import { bootApp, seedWorld, type World } from './qa-sec-helpers.ts';

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

async function link(world: World, shortCode: string, targetUrl: string): Promise<void> {
  await testDb().query(
    `INSERT INTO tracking_links (tenant_id, message_queue_id, short_code, target_url)
     VALUES ($1,$2,$3,$4)`,
    [world.tenantId, world.queuedMessageId, shortCode, targetUrl],
  );
}

async function clickEvents(messageQueueId: string): Promise<number> {
  const { rows } = await testDb().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM message_events
      WHERE message_queue_id = $1 AND event_type = 'clicked'`,
    [messageQueueId],
  );
  return Number(rows[0]!.n);
}

describe('the redirect target', () => {
  it('comes from the stored row and cannot be steered by the request', async () => {
    await link(a, 'code-alpha', 'https://shop.example.com/offer');

    for (const url of [
      '/t/c/code-alpha?target=https://evil.example/phish',
      '/t/c/code-alpha?url=https://evil.example/phish',
      '/t/c/code-alpha?target_url=https://evil.example/phish',
      '/r/code-alpha?redirect=https://evil.example/phish',
    ]) {
      const response = await app.request(url);
      expect(response.status, url).toBe(302);
      expect(response.headers.get('location'), `${url} became an open redirect`).toBe(
        'https://shop.example.com/offer',
      );
    }
  });

  it('refuses a non-http scheme rather than emitting it as a Location', async () => {
    // The scheme test is `/^https?:\/\//i`. javascript: and data: in a Location
    // header are an XSS delivered by the sender's own domain; file:// and gopher://
    // are SSRF against whatever fetches the link.
    const hostile = [
      ['js', 'javascript:alert(document.domain)'],
      ['data', 'data:text/html,<script>alert(1)</script>'],
      ['file', 'file:///etc/passwd'],
      // The one that beats a naive startsWith check: a leading newline, which some
      // header writers will happily emit and split the response on.
      ['crlf', '\nhttps://evil.example/'],
      // And the one that beats a naive `includes('https://')`.
      ['prefix', 'ftp://evil.example/#https://shop.example.com'],
    ] as const;

    for (const [code, target] of hostile) {
      await link(a, `hostile-${code}`, target);
      const response = await app.request(`/t/c/hostile-${code}`);
      expect(response.status, `${target} was not refused`).toBe(404);
      expect(response.headers.get('location'), target).toBeNull();
    }
  });

  it('answers both /t/c and /r identically — one handler, two paths, no drift', async () => {
    await link(a, 'both-paths', 'https://shop.example.com/x');
    const viaEmail = await app.request('/t/c/both-paths');
    const viaSms = await app.request('/r/both-paths');
    expect(viaEmail.status).toBe(viaSms.status);
    expect(viaEmail.headers.get('location')).toBe(viaSms.headers.get('location'));
  });

  it('does not tell an enumerator which short codes exist', async () => {
    await link(a, 'realcode99', 'https://shop.example.com/x');
    const unknown = await app.request('/t/c/definitely-not-a-code');
    expect(unknown.status).toBe(404);
    // A miss and a scheme-rejected hit render the same page, so the 404 body does
    // not distinguish "no such code" from "code exists, target unusable".
    await link(a, 'badscheme1', 'javascript:alert(1)');
    const rejected = await app.request('/t/c/badscheme1');
    expect(await rejected.text()).toBe(await unknown.text());
  });
});

describe('what a click can be attributed to', () => {
  it('credits the contact and tenant on the LINK, not anything the caller supplies', async () => {
    await link(b, 'beta-code', 'https://shop.example.com/beta');

    // Anyone at all fetches B's link, claiming to be A in every way a request can.
    const response = await app.request('/t/c/beta-code', {
      headers: {
        'x-tenant-id': a.tenantId,
        'x-contact-id': a.contactId,
        authorization: `Bearer ${a.token}`,
      },
    });
    expect(response.status).toBe(302);

    const { rows } = await testDb().query<{ tenant_id: string; contact_id: string }>(
      `SELECT tenant_id, contact_id FROM message_events WHERE event_type = 'clicked'`,
    );
    expect(rows).toHaveLength(1);
    expect(
      { tenant: rows[0]!.tenant_id, contact: rows[0]!.contact_id },
      "a click on B's link was attributed to A",
    ).toEqual({ tenant: b.tenantId, contact: b.contactId });
    expect(await clickEvents(a.queuedMessageId)).toBe(0);
  });

  it('lets anyone holding one URL inflate the click count without limit', async () => {
    // Identical to the open-pixel finding in qa-sec-public-webhooks: the
    // idempotency key is shortCode : UTC date : hash(user-agent), and the caller
    // picks the user agent. One recipient forwarding a newsletter to a script owns
    // the click-through rate of the campaign.
    await link(a, 'inflate-me', 'https://shop.example.com/x');
    for (let i = 0; i < 25; i += 1) {
      const response = await app.request('/t/c/inflate-me', {
        headers: { 'user-agent': `Mozilla/5.0 (inflate ${i})` },
      });
      expect(response.status).toBe(302);
    }
    expect(
      await clickEvents(a.queuedMessageId),
      'one URL holder wrote 25 distinct clicks for a message sent to one person',
    ).toBe(1);
  });

  it('does not attribute a click to a message queue row from another tenant', async () => {
    // LATENT, not currently reachable: tracking_links.tenant_id and
    // message_queue.tenant_id are separate columns with no constraint tying them
    // together, and the handler reads `tl.tenant_id` for the event while taking
    // campaign_id and contact_id from the JOINed queue row. A single row where the
    // two disagree therefore writes an event with tenant A's id onto tenant B's
    // campaign — the same shape as the /events poisoning proven in
    // qa-sec-tenant-isolation. Nothing writes this table today (see the last test
    // in this file), so the hole is in the shape of the code rather than in an
    // exploit path; whoever finally wires up link tracking inherits it.
    await testDb().query(
      `INSERT INTO tracking_links (tenant_id, message_queue_id, short_code, target_url)
       VALUES ($1,$2,'mismatched','https://shop.example.com/x')`,
      [a.tenantId, b.queuedMessageId],
    );
    const response = await app.request('/t/c/mismatched');
    expect(response.status).toBe(302);

    const { rows } = await testDb().query<{ tenant_id: string; campaign_id: string }>(
      `SELECT tenant_id, campaign_id FROM message_events WHERE event_type = 'clicked'`,
    );
    expect(
      rows.map(
        (r) =>
          `${r.tenant_id === a.tenantId ? 'A' : 'B'}:${r.campaign_id === b.campaignId ? 'Bcampaign' : 'Acampaign'}`,
      ),
      "a link row naming tenant A wrote an event onto tenant B's campaign",
    ).toEqual([]);
  });
});

describe('the feature behind these two routes', () => {
  it('IS NOT WIRED UP: nothing in packages/ ever inserts a tracking_links row', () => {
    // Every row in this file's other tests was inserted by the test itself. The
    // send path renders `body_template` and queues it; `rewriteLinks` exists in
    // core and is called by nobody, so no short code is ever minted. Consequences:
    // /t/c and /r are permanently 404 in production, `clicked` events are never
    // recorded from mail, and `/campaigns/:id/stats` computes a click rate whose
    // denominator (`clickable_delivered`, a JOIN onto tracking_links) is always 0.
    //
    // A source scan rather than a behavioural test, in the style of
    // tests/invariants/i1-gates-run-on-every-path.test.ts: the claim is about the
    // whole tree, and no single request can demonstrate an absence.
    const root = new URL('../../packages/', import.meta.url).pathname;
    const sources: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) sources.push(full);
      }
    };
    walk(root);
    expect(sources.length, 'the source scan found no files, so it proves nothing').toBeGreaterThan(
      20,
    );

    const writers = sources.filter((file) => {
      const source = readFileSync(file, 'utf8');
      // A call site, not the declaration: `export function rewriteLinks(` is the
      // one occurrence that does not count as using it.
      const calls = source.replace(/export function rewriteLinks\s*\(/g, '');
      return /INSERT\s+INTO\s+tracking_links/i.test(source) || /\brewriteLinks\s*\(/.test(calls);
    });

    expect(
      writers,
      'no file in packages/ mints a short code, so the click-tracking routes are dead',
    ).not.toEqual([]);
  });
});
