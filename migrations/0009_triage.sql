-- 0009 — the AI layer  (V1–V10)
--
-- The central idea this schema exists to make visible:
--
--   THE DETERMINISTIC/MODEL BOUNDARY.
--
-- A language model is genuinely good at reading prose, judging tone, summarising
-- and drafting. It must never be responsible for arithmetic, identity matching,
-- permission checks, or anything that has to give the same answer twice. The
-- `decided_by` column below puts that boundary in the DATA, not just in the code:
-- you can query how many decisions the model was actually responsible for.

-- ─────────────────────────────────────────────────────────────────────────────
-- prompts — versioned artefacts, immutable, content-addressed  (V3)
-- ─────────────────────────────────────────────────────────────────────────────
-- Prompts live on disk as prompts/<name>/v<N>.md; the file is the source of truth
-- and this table is the synced index. A changed prompt is a NEW VERSION, never an
-- edit — otherwise "it worked last week" has no answer.
CREATE TABLE prompts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  version      INT  NOT NULL,
  content      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  model_id     TEXT NOT NULL,
  output_schema JSONB NOT NULL,
  -- The bar a new version must clear before it can ship (V4).
  baseline_metrics JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, version),
  UNIQUE (content_hash)
);

CREATE TRIGGER prompts_append_only
  BEFORE UPDATE OR DELETE ON prompts
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- ─────────────────────────────────────────────────────────────────────────────
-- classifications
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE classifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reply_id   UUID NOT NULL REFERENCES inbound_replies(id) ON DELETE CASCADE,
  prompt_id  UUID REFERENCES prompts(id) ON DELETE RESTRICT,

  label      TEXT CHECK (label IN ('question','complaint','opt_out','positive','other')),
  confidence NUMERIC(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  extracted  JSONB NOT NULL DEFAULT '{}',

  status     TEXT NOT NULL CHECK (status IN ('auto','needs_review','reviewed','failed')),

  -- V1, visible in the data. A deterministic decision has no prompt_id and costs
  -- nothing; you can prove from SQL alone that opt-out detection never depended on
  -- a model being available.
  decided_by TEXT NOT NULL CHECK (decided_by IN ('deterministic','model','human')),

  human_label TEXT,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (reply_id, prompt_id),
  -- A model decision must name the prompt version that produced it; a deterministic
  -- decision must not pretend to have one.
  CONSTRAINT classifications_model_names_its_prompt
    CHECK ((decided_by = 'model') = (prompt_id IS NOT NULL)),
  CONSTRAINT classifications_reviewed_has_reviewer
    CHECK (status <> 'reviewed' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX classifications_review_queue
  ON classifications(tenant_id, created_at DESC) WHERE status = 'needs_review';

-- ─────────────────────────────────────────────────────────────────────────────
-- model_calls — V2: every call, no exceptions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE model_calls (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reply_id   UUID REFERENCES inbound_replies(id) ON DELETE SET NULL,
  prompt_id  UUID NOT NULL REFERENCES prompts(id) ON DELETE RESTRICT,
  model_id   TEXT NOT NULL,

  input_hash TEXT NOT NULL,
  raw_output TEXT,

  input_tokens  INT,
  output_tokens INT,
  cost_usd      NUMERIC(10,6),
  latency_ms    INT,
  cache_hit     BOOLEAN NOT NULL DEFAULT false,

  parse_status TEXT CHECK (parse_status IN ('ok','schema_violation','retry_ok','escalated')),
  error        TEXT,
  called_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- V8: the cache is keyed on the content hash and the prompt version, never on
-- wall-clock time. Identical input plus identical prompt version is the same answer.
CREATE INDEX model_calls_cache ON model_calls(prompt_id, input_hash) WHERE parse_status = 'ok';
CREATE INDEX model_calls_spend ON model_calls(tenant_id, called_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- token_budget_ledger — V7: refuse at the ceiling, before the call
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE token_budget_ledger (
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period      DATE NOT NULL,
  tokens_used BIGINT NOT NULL DEFAULT 0,
  cost_usd    NUMERIC(12,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, period),
  CONSTRAINT token_budget_nonneg CHECK (tokens_used >= 0 AND cost_usd >= 0)
);

ALTER TABLE tenants
  ADD COLUMN monthly_token_budget BIGINT NOT NULL DEFAULT 2000000,
  ADD COLUMN confidence_threshold NUMERIC(3,2) NOT NULL DEFAULT 0.75,
  -- V10: an autonomous system does not email customers until somebody decides it
  -- should. The default is off, in the schema, not in a config file.
  ADD COLUMN auto_send BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT tenants_confidence_threshold_valid
    CHECK (confidence_threshold > 0 AND confidence_threshold <= 1);

-- ─────────────────────────────────────────────────────────────────────────────
-- eval_runs / eval_cases — V4: CI blocks a merge that regresses the golden set
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE eval_cases (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset       TEXT NOT NULL,
  input_body    TEXT NOT NULL,
  expected_label TEXT NOT NULL,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dataset, input_body)
);

CREATE TABLE eval_runs (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id UUID NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  dataset_version TEXT NOT NULL,
  git_sha   TEXT,
  accuracy  NUMERIC(5,4),
  macro_f1  NUMERIC(5,4),
  per_label JSONB NOT NULL DEFAULT '{}',
  passed    BOOLEAN NOT NULL,
  total_cost_usd NUMERIC(10,6),
  ran_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX eval_runs_prompt ON eval_runs(prompt_id, ran_at DESC);
