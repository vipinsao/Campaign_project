import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Db } from '@campaign/core';
import { queryOne } from '@campaign/core';

/**
 * Unsubscribe tokens.
 *
 * 32 bytes from the CSPRNG, base64url, stored as the primary key of
 * `unsubscribe_tokens`. Deliberately NOT a signed payload containing the contact
 * id, and not the contact id itself:
 *
 *  - A guessable or enumerable token lets anyone unsubscribe anyone. Support
 *    tickets that read "I never unsubscribed" are unfalsifiable once that is
 *    possible, because the ledger records an opt-out with no way to tell whose
 *    finger was on it.
 *  - An opaque row can be revoked. A self-describing signed token cannot be, short
 *    of rotating the key and invalidating every unsubscribe link in every inbox —
 *    including the ones in mail sent last month, which is precisely the mail whose
 *    recipients are most likely to want out.
 *
 * The token is minted per MESSAGE, so the opt-out evidence names the message that
 * carried the link. "They opted out" is weaker than "they opted out from this
 * message, sent on this date".
 */
export async function mintUnsubscribeToken(
  db: Db | PoolClient,
  opts: {
    readonly tenantId: string;
    readonly contactId: string;
    readonly messageQueueId?: string | null;
  },
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO unsubscribe_tokens (token, tenant_id, contact_id, message_queue_id)
     VALUES ($1,$2,$3,$4)`,
    [token, opts.tenantId, opts.contactId, opts.messageQueueId ?? null],
  );
  return token;
}

export function unsubscribeUrl(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl}/u/${encodeURIComponent(token)}`;
}

export type ResolvedToken = {
  readonly token: string;
  readonly tenant_id: string;
  readonly contact_id: string;
  readonly message_queue_id: string | null;
  readonly used_at: Date | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly first_name: string | null;
  readonly tenant_name: string;
};

/**
 * Resolve a token to its contact.
 *
 * `used_at` is returned rather than enforced. A token that has been used once must
 * keep working: people click the link in a second message, or come back a week
 * later to change one category rather than to leave entirely. Burning the token on
 * first use turns "let me adjust my preferences" into a dead link, and a dead
 * preference-centre link is how someone who wanted one fewer email ends up
 * reporting the whole sender as spam.
 */
export function resolveUnsubscribeToken(
  db: Db | PoolClient,
  token: string,
): Promise<ResolvedToken | undefined> {
  return queryOne<ResolvedToken>(
    db,
    `SELECT ut.token, ut.tenant_id, ut.contact_id, ut.message_queue_id, ut.used_at,
            c.email, c.phone, c.first_name, t.name AS tenant_name
       FROM unsubscribe_tokens ut
       JOIN contacts c ON c.id = ut.contact_id
       JOIN tenants  t ON t.id = ut.tenant_id
      WHERE ut.token = $1`,
    [token],
  );
}
