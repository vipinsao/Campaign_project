/**
 * The demo dataset.
 *
 * Two rules govern everything in this file:
 *
 *  1. IT IS DETERMINISTIC. Every random choice comes from a seeded PRNG, so two
 *     runs produce identical data. A demo that looks different every time cannot
 *     be screenshotted, cannot be described in DEMO.md, and cannot be diffed when
 *     something looks wrong.
 *
 *  2. IT IS OBVIOUSLY DEMO DATA. Every address is `@example.com`, every phone
 *     number is in the reserved `+1500555xxxx` test range, and every name is
 *     generated. Nothing here could be mistaken for a real person, and the UI
 *     labels the tenant as a demo.
 *
 * The five campaigns are chosen to exercise every mechanism in the system rather
 * than to look impressive: one of them is deliberately left in `observe` so the
 * decision log has proceed-but-do-not-send rows in it, and one of them is
 * transactional so the quiet-hours exemption is visible.
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import argon2 from 'argon2';

const CONTACTS = 500;
const ORDERS = 1200;
const DAYS_OF_HISTORY = 90;

/** mulberry32 — small, fast, and identical across runs and machines. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = makeRng(20260825);
const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
const between = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

/** Six zones, chosen so the quiet-hours behaviour is visible in the demo. */
const TIMEZONES = [
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Australia/Sydney',
] as const;

const FIRST_NAMES = [
  'Ada', 'Grace', 'Alan', 'Edsger', 'Barbara', 'Ken', 'Margaret', 'Donald',
  'Radia', 'Leslie', 'Katherine', 'Tim', 'Anita', 'Vint', 'Frances', 'Dennis',
] as const;
const LAST_NAMES = [
  'Lovelace', 'Hopper', 'Turing', 'Dijkstra', 'Liskov', 'Thompson', 'Hamilton',
  'Knuth', 'Perlman', 'Lamport', 'Johnson', 'Berners-Lee', 'Borg', 'Cerf',
  'Allen', 'Ritchie',
] as const;

const TAG_POOL = ['vip', 'newsletter', 'wholesale', 'returning', 'no_marketing'] as const;

async function main() {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is not set. Run `npm run dev` first, or point it at a database.');
    process.exit(1);
  }
  const db = new Pool({ connectionString: url });

  try {
    // Re-runnable without duplicating: the demo tenant is dropped and rebuilt.
    // Cascades clear everything hanging off it, so this is a genuine reset rather
    // than an accumulation.
    await db.query(`DELETE FROM tenants WHERE name = 'Demo Store (seeded data)'`);

    const now = new Date('2026-08-25T09:00:00Z');
    const start = new Date(now.getTime() - DAYS_OF_HISTORY * 86_400_000);

    const { rows: t } = await db.query<{ id: string }>(
      `INSERT INTO tenants (name, default_timezone, quiet_hours_start, quiet_hours_end,
                            freq_cap_count, freq_cap_window)
       VALUES ('Demo Store (seeded data)','Europe/London','08:00','21:00',3,'7 days')
       RETURNING id`,
    );
    const tenantId = t[0]!.id;

    await db.query(
      `INSERT INTO users (tenant_id, email, password_hash, role)
       VALUES ($1,'operator@example.com',$2,'owner')`,
      [tenantId, await argon2.hash('demo-password-change-me', { type: argon2.argon2id })],
    );

    const stores: string[] = [];
    for (const [name, code] of [
      ['Main Store', 'main'],
      ['Outlet Store', 'outlet'],
    ] as const) {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO stores (tenant_id, name, code) VALUES ($1,$2,$3) RETURNING id`,
        [tenantId, name, code],
      );
      stores.push(rows[0]!.id);
    }

    // ── contacts ─────────────────────────────────────────────────────────────
    const contactIds: string[] = [];
    for (let i = 0; i < CONTACTS; i++) {
      const first = pick(FIRST_NAMES);
      const last = pick(LAST_NAMES);
      const tags = TAG_POOL.filter(() => rng() < 0.18);
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO contacts (tenant_id, external_id, email, phone, first_name, last_name,
                               timezone, locale, tags, attributes, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'en',$8,$9,$10)
         RETURNING id`,
        [
          tenantId,
          `cust-${1000 + i}`,
          `${first.toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, '')}${i}@example.com`,
          // Reserved test range, so nothing here can dial a real handset.
          `+1500555${String(i).padStart(4, '0')}`,
          first,
          last,
          pick(TIMEZONES),
          tags,
          JSON.stringify({ plan: pick(['free', 'pro', 'enterprise']), score: between(0, 100) }),
          new Date(start.getTime() + rng() * (now.getTime() - start.getTime())),
        ],
      );
      contactIds.push(rows[0]!.id);
    }

    // Most contacts opted in at signup. The rest have no consent on record at all,
    // which is a different state from opted out and the gate treats it as such.
    for (const contactId of contactIds) {
      if (rng() < 0.88) {
        await db.query(
          `INSERT INTO contact_consents (tenant_id, contact_id, channel, state, source, occurred_at)
           VALUES ($1,$2,'email','opted_in','signup',$3), ($1,$2,'sms','opted_in','checkout',$3)`,
          [tenantId, contactId, start],
        );
      }
    }

    // ── orders ───────────────────────────────────────────────────────────────
    const orderStates = ['placed', 'shipped', 'delivered', 'delivered', 'delivered', 'cancelled'] as const;
    let delivered = 0;
    for (let i = 0; i < ORDERS; i++) {
      const contactId = pick(contactIds);
      const storeId = pick(stores);
      const placedAt = new Date(start.getTime() + rng() * (now.getTime() - start.getTime()));
      const status = pick(orderStates);

      const shippedAt =
        status === 'shipped' || status === 'delivered'
          ? new Date(placedAt.getTime() + between(4, 48) * 3_600_000)
          : null;
      const deliveredAt =
        status === 'delivered' && shippedAt
          ? new Date(shippedAt.getTime() + between(12, 120) * 3_600_000)
          : null;
      const cancelledAt =
        status === 'cancelled' ? new Date(placedAt.getTime() + between(1, 24) * 3_600_000) : null;

      if (deliveredAt && deliveredAt > now) continue;
      if (deliveredAt) delivered++;

      await db.query(
        `INSERT INTO orders (tenant_id, store_id, contact_id, order_number, status, total,
                             placed_at, shipped_at, delivered_at, cancelled_at,
                             carrier, tracking_number, items)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (tenant_id, store_id, order_number) DO NOTHING`,
        [
          tenantId,
          storeId,
          contactId,
          // Deliberately NOT globally unique: the same number exists in both
          // stores, which is what makes the I13 ambiguity demo reachable.
          `ORD-${10000 + (i % 900)}`,
          status,
          (between(1500, 24000) / 100).toFixed(2),
          placedAt,
          shippedAt,
          deliveredAt,
          cancelledAt,
          shippedAt ? pick(['royal-mail', 'dpd', 'evri']) : null,
          shippedAt ? `TRK${between(100000, 999999)}` : null,
          JSON.stringify([{ sku: `SKU-${between(1, 60)}`, qty: between(1, 3) }]),
        ],
      );
    }

    await db.query(
      `UPDATE contacts c
          SET order_count = agg.n,
              first_order_at = agg.first_at,
              last_order_at = agg.last_at,
              lifetime_value = agg.total
         FROM (SELECT contact_id, count(*) AS n, min(placed_at) AS first_at,
                      max(placed_at) AS last_at, sum(total) AS total
                 FROM orders WHERE tenant_id = $1 GROUP BY contact_id) agg
        WHERE c.id = agg.contact_id`,
      [tenantId],
    );

    // ── suppressions ─────────────────────────────────────────────────────────
    // A realistic mix: hard bounces are permanent, soft bounces expire. The demo
    // needs both so the send-time expiry check has something to do.
    for (let i = 0; i < 40; i++) {
      const contactId = contactIds[between(0, contactIds.length - 1)]!;
      const { rows } = await db.query<{ email: string }>(
        `SELECT email FROM contacts WHERE id = $1`,
        [contactId],
      );
      const reason = pick(['hard_bounce', 'complaint', 'unsubscribe', 'invalid'] as const);
      await db.query(
        `INSERT INTO suppressions (tenant_id, channel, address, reason, expires_at, created_at)
         VALUES ($1,'email',$2,$3,$4,$5)
         ON CONFLICT (tenant_id, channel, address) DO NOTHING`,
        [
          tenantId,
          rows[0]!.email,
          reason,
          reason === 'invalid' ? new Date(now.getTime() + 7 * 86_400_000) : null,
          new Date(start.getTime() + rng() * (now.getTime() - start.getTime())),
        ],
      );
      await db.query(
        `INSERT INTO contact_consents (tenant_id, contact_id, channel, state, source, occurred_at, evidence)
         VALUES ($1,$2,'email','opted_out',$3,$4,$5)`,
        [
          tenantId,
          contactId,
          reason === 'complaint' ? 'complaint' : reason === 'hard_bounce' ? 'bounce' : 'unsubscribe_link',
          new Date(start.getTime() + rng() * (now.getTime() - start.getTime())),
          JSON.stringify({ seeded: true, reason }),
        ],
      );
    }

    // ── campaigns ────────────────────────────────────────────────────────────
    const campaigns = await seedCampaigns(db, tenantId);

    console.log(`Seeded demo tenant ${tenantId}`);
    console.log(`  contacts     ${contactIds.length}`);
    console.log(`  orders       ${ORDERS} (${delivered} delivered)`);
    console.log(`  campaigns    ${campaigns.length}`);
    console.log(`  operator     operator@example.com / demo-password-change-me`);
    console.log('');
    console.log('Next: npm run demo:simulate');
  } finally {
    await db.end();
  }
}

async function seedCampaigns(db: Pool, tenantId: string): Promise<string[]> {
  const created: string[] = [];

  const define = async (spec: {
    name: string;
    description: string;
    category: 'lifecycle' | 'promotional' | 'transactional' | 'operational';
    trigger: string;
    triggerConfig?: Record<string, unknown>;
    status: 'draft' | 'observe' | 'active' | 'paused';
    channels: string[];
    audience?: Record<string, unknown>;
    messages: {
      channel: 'email' | 'sms';
      order: number;
      anchor?: 'trigger' | 'previous' | 'delivery';
      delayMinutes?: number;
      condition?: string;
      subject?: string;
      body: string;
      html?: string;
    }[];
    stopOn?: string[];
  }) => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO campaigns (tenant_id, name, description, category, trigger_type,
                              trigger_config, channels, status, audience)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        tenantId,
        spec.name,
        spec.description,
        spec.category,
        spec.trigger,
        JSON.stringify(spec.triggerConfig ?? {}),
        spec.channels,
        spec.status,
        JSON.stringify(spec.audience ?? {}),
      ],
    );
    const campaignId = rows[0]!.id;

    for (const m of spec.messages) {
      await db.query(
        `INSERT INTO campaign_messages
           (tenant_id, campaign_id, channel, sequence_order, delay_anchor, delay_minutes,
            send_condition, subject_template, body_template, html_template, node_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          tenantId,
          campaignId,
          m.channel,
          m.order,
          m.anchor ?? 'trigger',
          m.delayMinutes ?? 0,
          m.condition ?? 'always',
          m.subject ?? null,
          m.body,
          m.html ?? null,
          `node-${m.order}`,
        ],
      );
    }

    for (const condition of spec.stopOn ?? []) {
      await db.query(
        `INSERT INTO campaign_stop_conditions (tenant_id, campaign_id, condition_type)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [tenantId, campaignId, condition],
      );
    }

    // Activate: snapshot a version, exactly as the API does.
    const { rows: v } = await db.query<{ id: string }>(
      `INSERT INTO campaign_versions (tenant_id, campaign_id, version, snapshot)
       VALUES ($1,$2,1,$3) RETURNING id`,
      [tenantId, campaignId, JSON.stringify({ seeded: true, name: spec.name })],
    );
    await db.query(`UPDATE campaigns SET active_version_id = $2 WHERE id = $1`, [
      campaignId,
      v[0]!.id,
    ]);

    created.push(campaignId);
    return campaignId;
  };

  const OPT_OUT = 'Unsubscribe: {{unsubscribe_url}}';

  // 1. Welcome series — contact_created, two emails.
  await define({
    name: 'Welcome series',
    description: 'Two emails to a newly created contact.',
    category: 'lifecycle',
    trigger: 'contact_created',
    status: 'active',
    channels: ['email'],
    messages: [
      {
        channel: 'email',
        order: 1,
        subject: 'Welcome, {{contact.first_name}}',
        body: `Thanks for joining us, {{contact.first_name}}. ${OPT_OUT}`,
        html: `<p>Thanks for joining us, {{contact.first_name}}.</p><p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>`,
      },
      {
        channel: 'email',
        order: 2,
        anchor: 'previous',
        delayMinutes: 60 * 24 * 3,
        subject: 'Getting started',
        body: `Here is how to get the most out of your account. ${OPT_OUT}`,
      },
    ],
  });

  // 2. Post-purchase review request — DELIVERY-anchored, email then a conditional SMS.
  //    This is the campaign that exercises the most machinery in one journey.
  await define({
    name: 'Post-purchase review request',
    description: 'Three days after the order is delivered, ask for a review. SMS follow-up if unopened.',
    category: 'lifecycle',
    trigger: 'order_delivered',
    status: 'active',
    channels: ['email', 'sms'],
    messages: [
      {
        channel: 'email',
        order: 1,
        anchor: 'delivery',
        delayMinutes: 60 * 24 * 3,
        subject: 'How was order {{order.number}}?',
        body: `Hi {{contact.first_name}}, how did we do with order {{order.number}}? ${OPT_OUT}`,
        html: `<p>Hi {{contact.first_name}}, how did we do with order {{order.number}}?</p><p><a href="https://example.com/review">Leave a review</a></p><p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>`,
      },
      {
        channel: 'sms',
        order: 2,
        anchor: 'previous',
        delayMinutes: 60 * 24 * 4,
        condition: 'not_opened_previous',
        body: `{{contact.first_name}}, a quick word on order {{order.number}}? Reply STOP to opt out.`,
      },
    ],
    stopOn: ['replied', 'clicked'],
  });

  // 3. Shipping notification — TRANSACTIONAL, so quiet hours do not apply and no
  //    opt-out link is required. Both of those are visible in the UI.
  await define({
    name: 'Shipping notification',
    description: 'Transactional. Exempt from quiet hours; no opt-out required.',
    category: 'transactional',
    trigger: 'order_shipped',
    status: 'active',
    channels: ['sms'],
    messages: [
      {
        channel: 'sms',
        order: 1,
        body: `Your order {{order.number}} has shipped with {{order.carrier}}. Tracking: {{order.tracking_number}}`,
      },
    ],
  });

  // 4. Win-back — the time trigger, with the floor and circuit breaker guarding it.
  await define({
    name: 'Win-back',
    description: 'Sixty days since the last order. Guarded by the cutoff floor and the circuit breaker.',
    category: 'promotional',
    trigger: 'days_since_last_order',
    triggerConfig: { days: 60 },
    status: 'active',
    channels: ['email'],
    audience: { none: [{ field: 'tags', op: 'contains', value: 'no_marketing' }] },
    messages: [
      {
        channel: 'email',
        order: 1,
        subject: 'We have missed you',
        body: `It has been a while, {{contact.first_name}}. ${OPT_OUT}`,
        html: `<p>It has been a while, {{contact.first_name}}.</p><p><a href="https://example.com/shop">Have another look</a></p><p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>`,
      },
    ],
  });

  // 5. Deliberately left in OBSERVE, so the decision log carries
  //    proceed-but-do-not-send rows and the /inspect page has something to show.
  await define({
    name: 'VIP early access (observing)',
    description: 'Left in observe mode on purpose: it logs every decision and queues nothing.',
    category: 'promotional',
    trigger: 'order_placed',
    status: 'observe',
    channels: ['email'],
    audience: { all: [{ field: 'tags', op: 'contains', value: 'vip' }] },
    messages: [
      {
        channel: 'email',
        order: 1,
        subject: 'Early access for you',
        body: `Because you are a regular, {{contact.first_name}}, here is a first look. ${OPT_OUT}`,
      },
    ],
  });

  return created;
}

await main();
