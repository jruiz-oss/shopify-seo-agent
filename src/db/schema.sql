-- Each agent run
CREATE TABLE IF NOT EXISTS runs (
  id            SERIAL PRIMARY KEY,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'running', -- running | done | failed
  trigger       TEXT NOT NULL DEFAULT 'cron',    -- cron | manual
  summary       TEXT,
  error         TEXT,
  input_tokens  INT DEFAULT 0,
  output_tokens INT DEFAULT 0
);

-- Point-in-time snapshot of every Shopify resource's SEO-relevant state.
-- This is the "what already exists" record the agent diffs against.
CREATE TABLE IF NOT EXISTS resource_snapshots (
  id            SERIAL PRIMARY KEY,
  run_id        INT REFERENCES runs(id) ON DELETE CASCADE,
  target_type   TEXT NOT NULL,   -- product | collection | page | article | redirect | theme_file
  target_id     TEXT NOT NULL,   -- Shopify GID
  handle        TEXT,
  url           TEXT,
  state         JSONB NOT NULL,  -- title, seoTitle, seoDescription, bodyHtml, altMissing, ...
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resource_snapshots_target ON resource_snapshots(target_type, target_id, captured_at DESC);

-- Crawl of the live storefront (what Google actually sees)
CREATE TABLE IF NOT EXISTS crawl_pages (
  id            SERIAL PRIMARY KEY,
  run_id        INT REFERENCES runs(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  status        INT,
  data          JSONB NOT NULL,  -- title, metaDescription, h1, canonical, jsonLdTypes, wordCount, faq, imgMissingAlt...
  crawled_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crawl_pages_run ON crawl_pages(run_id);

-- GSC data pulled per run
CREATE TABLE IF NOT EXISTS gsc_rows (
  id            SERIAL PRIMARY KEY,
  run_id        INT REFERENCES runs(id) ON DELETE CASCADE,
  period        TEXT NOT NULL,    -- current | previous
  page          TEXT,
  query         TEXT,
  clicks        INT,
  impressions   INT,
  ctr           REAL,
  position      REAL
);
CREATE INDEX IF NOT EXISTS gsc_rows_run ON gsc_rows(run_id, period);

-- What the agent wants to do. Goes through approval.
CREATE TABLE IF NOT EXISTS proposals (
  id            SERIAL PRIMARY KEY,
  run_id        INT REFERENCES runs(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  target_label  TEXT,            -- human readable (product title / page url)
  change_type   TEXT NOT NULL,   -- seo_title | seo_description | body_html | alt_text | redirect | noindex | jsonld_snippet
  before_value  TEXT,
  after_value   TEXT NOT NULL,
  reasoning     TEXT NOT NULL,   -- why, citing GSC / crawl evidence
  expected_impact TEXT,          -- e.g. "CTR lift on 'x' query, 1.2k impr/mo at pos 6"
  category      TEXT NOT NULL DEFAULT 'seo',   -- seo | aeo | technical
  risk          TEXT NOT NULL DEFAULT 'low',   -- low | medium | high
  overrides_existing BOOLEAN NOT NULL DEFAULT false, -- true when target already had a hand-set value
  fingerprint   TEXT NOT NULL,   -- sha256(target_type|target_id|change_type|after_value)
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | applied | failed | rolled_back
  reviewed_at   TIMESTAMPTZ,
  review_note   TEXT,
  applied_at    TIMESTAMPTZ,
  apply_result  JSONB,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS proposals_status ON proposals(status);
CREATE INDEX IF NOT EXISTS proposals_fp ON proposals(fingerprint);
CREATE INDEX IF NOT EXISTS proposals_target ON proposals(target_type, target_id, change_type, created_at DESC);

-- Immutable log of every applied change (source of truth for "already done")
CREATE TABLE IF NOT EXISTS change_log (
  id            SERIAL PRIMARY KEY,
  proposal_id   INT REFERENCES proposals(id),
  applied_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  change_type   TEXT NOT NULL,
  before_value  TEXT,
  after_value   TEXT NOT NULL,
  rolled_back_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS change_log_target ON change_log(target_type, target_id, change_type, applied_at DESC);

-- Agent's own notes across runs (things it decided not to do and why, open questions, etc.)
CREATE TABLE IF NOT EXISTS agent_notes (
  id          SERIAL PRIMARY KEY,
  run_id      INT REFERENCES runs(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  note        TEXT NOT NULL
);
