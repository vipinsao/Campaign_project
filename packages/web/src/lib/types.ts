/**
 * The response shapes, transcribed from packages/api/src/routes/*.ts.
 *
 * These are hand-written rather than inferred because the API's JSON is built by
 * hand-written mappers (`campaignJson`, `toSummary`) and by raw `SELECT`s that
 * return snake_case rows. Where a route returns the raw row, the type below is
 * snake_case too — pretending otherwise in the client is how a field silently
 * reads `undefined` forever.
 */
import type {
  CampaignCategory,
  CampaignStatus,
  Channel,
  DelayAnchor,
  SendCondition,
  TriggerType,
  AudienceDefinition,
} from '@campaign/shared';

export type Page = { readonly limit: number; readonly offset: number; readonly total?: number };

// ── campaigns ────────────────────────────────────────────────────────────────

export type Campaign = {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: CampaignCategory;
  readonly triggerType: TriggerType;
  readonly triggerConfig: Record<string, unknown>;
  readonly channels: Channel[];
  readonly status: CampaignStatus;
  readonly audience: AudienceDefinition;
  readonly sendWindowStart: string | null;
  readonly sendWindowEnd: string | null;
  readonly sendDays: number[];
  readonly oneTimePerContact: boolean;
  readonly activeVersionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type CampaignMessage = {
  readonly id: string;
  readonly campaignId: string;
  readonly channel: Channel;
  readonly sequenceOrder: number;
  readonly delayAnchor: DelayAnchor;
  readonly delayMinutes: number;
  readonly sendCondition: SendCondition;
  readonly subjectTemplate: string | null;
  readonly htmlTemplate: string | null;
  readonly bodyTemplate: string;
  readonly previewText: string | null;
  readonly nodeId: string | null;
  readonly branchPath: 'yes' | 'no' | null;
  readonly isEnabled: boolean;
};

export type CampaignListResponse = { readonly campaigns: Campaign[]; readonly page: Page };
export type CampaignResponse = {
  readonly campaign: Campaign;
  readonly messages?: CampaignMessage[];
};
export type MessagesResponse = { readonly messages: CampaignMessage[] };

// ── analytics ────────────────────────────────────────────────────────────────

/** One rate, as the API returns it: value, denominator sentence, and caveat. */
export type ApiRate = {
  readonly key: string;
  readonly label: string;
  readonly value: number | null;
  readonly denominator: string;
  readonly applicable: boolean;
  readonly caveat?: string;
};

export type StatsResponse = {
  readonly campaignId: string;
  readonly status: CampaignStatus;
  readonly channels: Channel[];
  readonly counts: Record<string, number>;
  readonly events: Record<string, { total: number; uniqueContacts: number }>;
  readonly rates: ApiRate[];
};

export type FunnelResponse = {
  readonly campaignId: string;
  readonly stages: { readonly stage: string; readonly count: number; readonly unit: string }[];
  readonly note: string;
  readonly skipsByReason: { readonly reasonCode: string; readonly count: number }[];
  readonly unsubscribes: number;
};

export type MessageStat = {
  readonly id: string;
  readonly sequenceOrder: number;
  readonly channel: Channel;
  readonly sendCondition: SendCondition;
  readonly isEnabled: boolean;
  readonly queued: number;
  readonly sent: number;
  readonly delivered: number;
  readonly cancelled: number;
  readonly uniqueOpens: number;
  readonly uniqueClicks: number;
};

export type MessageStatsResponse = {
  readonly campaignId: string;
  readonly messages: MessageStat[];
};

export type EnrollmentsResponse = {
  readonly campaignId: string;
  readonly enrollments: Record<string, unknown>[];
  readonly page: Page;
};

// ── audience ─────────────────────────────────────────────────────────────────

export type ContactSample = {
  readonly id: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly tags: string[];
};

export type EstimateResponse = {
  readonly count: number;
  readonly sample: ContactSample[];
  readonly compiledSql: string;
  readonly params: unknown[];
};

// ── templates ────────────────────────────────────────────────────────────────

export type ValidationIssue = { readonly field?: string; readonly message: string };

export type ValidateResponse = {
  readonly ok: boolean;
  readonly errors: ValidationIssue[];
  readonly warnings: ValidationIssue[];
  readonly mergeFields: string[];
  readonly links: string[];
  readonly hasClickableLink: boolean;
  readonly smsSegments?: number;
  readonly renderedLength?: number;
};

export type MergeFieldsResponse = {
  readonly fields: {
    readonly name: string;
    readonly description: string | null;
    readonly requiresOrder: boolean;
  }[];
};

export type PreviewResponse = {
  readonly campaignMessageId: string;
  readonly channel: Channel;
  readonly preview: {
    readonly subject: string | null;
    readonly body: string;
    readonly html: string | null;
    readonly unsubscribeUrl: string;
    readonly contactId: string | null;
    readonly validation: ValidateResponse;
  };
};

// ── queue ────────────────────────────────────────────────────────────────────

/** A raw `message_queue` row as `/queue` returns it — snake_case, unmapped. */
export type QueueRow = {
  readonly id: string;
  readonly campaign_id: string;
  readonly campaign_message_id: string | null;
  readonly contact_id: string;
  readonly enrollment_id: string | null;
  readonly channel: Channel;
  readonly status: string;
  readonly recipient_address: string;
  readonly rendered_subject: string | null;
  readonly scheduled_at: string | null;
  readonly sent_at: string | null;
  readonly delivered_at: string | null;
  readonly attempts: number;
  readonly deferrals: number;
  readonly next_attempt_at: string | null;
  readonly provider: string | null;
  readonly provider_error_code: string | null;
  readonly provider_error_message: string | null;
  readonly error_class: 'terminal' | 'transient' | null;
  readonly tracking_id: string | null;
  readonly created_at: string;
  readonly campaign_name: string;
};

export type QueueResponse = {
  readonly messages: QueueRow[];
  readonly countsByStatus: Record<string, number>;
  readonly page: Page;
};

// ── decisions ────────────────────────────────────────────────────────────────

export type DecisionRow = {
  readonly id: string;
  readonly stage: string;
  readonly decision: 'proceed' | 'skip' | 'defer' | string;
  readonly reason_code: string;
  readonly reason_detail: string | null;
  readonly inputs: Record<string, unknown> | null;
  readonly decided_at: string;
  readonly campaign_id: string | null;
  readonly campaign_message_id: string | null;
  readonly contact_id: string | null;
  readonly order_id: string | null;
  readonly message_queue_id: string | null;
};

export type DecisionsResponse = {
  readonly decisions: DecisionRow[];
  /** The canned sentence per reason code, sent by the server so the client never
   *  keeps its own copy of a vocabulary that would drift. */
  readonly glossary: Record<string, string>;
  readonly page: Page;
};

// ── orders ───────────────────────────────────────────────────────────────────

export type OrderSummary = {
  readonly id: string;
  readonly orderNumber: string;
  readonly storeId: string;
  readonly storeName: string;
  readonly storeCode: string;
  readonly status: string;
  readonly total: string;
  readonly currency: string;
  readonly placedAt: string;
  readonly contactId: string;
  readonly contactEmailHint: string | null;
};

export type OrderLookupResponse =
  | { readonly kind: 'none' }
  | { readonly kind: 'single'; readonly match: OrderSummary }
  | {
      readonly kind: 'ambiguous';
      readonly candidates: OrderSummary[];
      readonly message: string;
      readonly disambiguateBy: string;
    };

export type OrderJourneyResponse = {
  readonly order: OrderSummary & {
    readonly shippedAt: string | null;
    readonly deliveredAt: string | null;
  };
  readonly enrollments: Record<string, unknown>[];
  readonly messages: Record<string, unknown>[];
  readonly decisions: DecisionRow[];
};

export type OrdersResponse = { readonly orders: OrderSummary[]; readonly page: Page };

// ── contacts ─────────────────────────────────────────────────────────────────

export type Contact = {
  readonly id: string;
  readonly externalId: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly timezone: string | null;
  readonly locale: string;
  readonly tags: string[];
  readonly attributes: Record<string, unknown>;
  readonly firstOrderAt: string | null;
  readonly lastOrderAt: string | null;
  readonly orderCount: number;
  readonly lifetimeValue: string;
  readonly createdAt: string;
};

export type ContactResponse = {
  readonly contact: Contact;
  readonly messages: { readonly queued: number; readonly sent: number; readonly cancelled: number };
};

export type ConsentLedgerRow = {
  readonly id: string;
  readonly channel: Channel;
  readonly category: CampaignCategory | null;
  readonly state: 'opted_in' | 'opted_out';
  readonly source: string;
  readonly evidence: Record<string, unknown> | null;
  readonly occurred_at: string;
};

export type SuppressionRow = {
  readonly channel: Channel;
  readonly address: string;
  readonly reason: string;
  readonly expires_at: string | null;
  readonly evidence: Record<string, unknown> | null;
  readonly created_at: string;
  readonly is_active?: boolean;
};

export type ConsentResponse = {
  readonly contactId: string;
  readonly ledger: ConsentLedgerRow[];
  readonly resolved: Record<string, Record<string, string | null>>;
  readonly suppressions: SuppressionRow[];
  readonly pauses: { readonly channel: Channel; readonly until: string | null }[];
};

// ── auth ─────────────────────────────────────────────────────────────────────

export type LoginResponse = {
  readonly token: string;
  readonly expiresIn: number;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly role: string;
    readonly tenantId: string;
  };
};
