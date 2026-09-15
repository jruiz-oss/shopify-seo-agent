# Shopify SEO/AEO Agent

An agent that reads your Shopify catalog, crawls the live storefront, pulls Google Search Console data, decides what to change, and applies it to Shopify after you approve. It keeps a permanent change log and refuses to redo work that already exists on the site or that it did recently.

## How a run works

1. Snapshot every active product, collection, page, and article (title, SEO title/description, body HTML, image alt, redirects).
2. Pull GSC: two trailing 28-day windows (current vs previous), by page, by query, and page x query.
3. Crawl the homepage, all collections/pages, and the top 150 GSC pages. Records title tag, meta description, H1/H2, JSON-LD types, word count, alt coverage, 404s.
4. Build a brief: CTR-below-expected pages, striking-distance queries (pos 4-15), decliners, on-page issues, duplicate titles/metas, dead URLs with traffic, question-intent queries.
5. Claude works the brief with tools (drill into resources, query history, notes) and submits proposals.
6. Every proposal passes the dedupe guard before it is stored (see below).
7. You review in the dashboard. Approve, approve+apply, or reject with a note the agent remembers.
8. Applied changes go to Shopify via Admin GraphQL and into `change_log`. Any applied change can be rolled back from the dashboard.

## Overlap protection (why it won't redo existing work)

`src/agent/dedupe.ts`, enforced in code, not just in the prompt:

- Value already live on Shopify: rejected.
- Same target+field changed by the agent within `COOLDOWN_DAYS` (default 45): rejected, so you can measure impact before touching it again.
- Identical proposal you rejected within `REJECTION_MEMORY_DAYS` (default 90): rejected.
- A pending/approved proposal already exists for that field: rejected.
- Existing hand-set SEO title (differs from product title) or a meta description in the 70-170 char range is treated as prior work. The agent can still propose an override, but the card is flagged `overrides existing` and excluded from "Approve all low-risk".
- Redirect for the same path already exists: rejected.
- The agent also writes notes (things it looked at and skipped) that future runs read first.

## What it can change

| change_type | Shopify write | Risk default |
|---|---|---|
| seo_title | product/collection `seo.title`; page/article `global.title_tag` metafield | low |
| seo_description | same pattern, `description` / `global.description_tag` | low |
| body_html | descriptionHtml / body. Agent must return full HTML, existing content preserved | medium |
| alt_text | productUpdateMedia alt | low |
| redirect | urlRedirectCreate (only for GSC pages that 404) | low |
| noindex | `seo.hidden` metafield (thin/duplicate pages with 0 clicks) | medium |
| jsonld_snippet | theme file upsert, e.g. `snippets/seo-agent-jsonld.liquid` (you still need to render the snippet in theme.liquid once) | high |

## Setup

### 1. Shopify custom app
Shopify admin > Settings > Apps and sales channels > Develop apps > Create app. Configure Admin API scopes:
`read_products, write_products, read_content, write_content, read_online_store_pages, write_online_store_pages, read_online_store_navigation, write_online_store_navigation, read_themes, write_themes`. Install, copy the Admin API access token (`shpat_...`).

### 2. Google Search Console service account
Google Cloud console > new project > enable "Google Search Console API" > IAM > Service accounts > create > Keys > add JSON key. In Search Console > Settings > Users and permissions, add the service account email (Restricted is enough). Paste the JSON as a single line into `GSC_SERVICE_ACCOUNT_JSON`. `GSC_PROPERTY` is `sc-domain:yourbrand.com` for a domain property or `https://www.yourbrand.com/` for a URL-prefix property.

### 3. Env vars
See `.env.example`. `BRAND_NOTES` matters: audience, tone, products or claims to never touch. The agent reads it every run.

### 4. Run
```
npm install
npm run migrate
npm run snapshot        # sanity check Shopify access
npm run run:agent       # one manual run
npm start               # dashboard + weekly cron (AGENT_CRON, default Mon 06:00 UTC)
```

Dashboard: `/` proposals inbox, `/runs` run summaries and agent notes, `/log` applied change log. Basic auth with `DASHBOARD_USER` / `DASHBOARD_PASSWORD`.

## Railway
One service from this repo (start command `npm start`) plus the Postgres plugin. Railway injects `DATABASE_URL`. Set the rest of the env vars on the service. The cron runs inside the process, so keep the service always-on (no sleep).

## Cost
Default model is `claude-sonnet-5`. A run on a 500-product store is typically 150-400k input tokens and 10-30k output tokens. Set `AGENT_MODEL=claude-opus-5` if you want deeper reasoning on content rewrites.

## Notes
- GSC data lags 2-3 days; windows account for that.
- `body_html` changes are shown as a line diff in the dashboard. Read them.
- Rolling back a `jsonld_snippet` restores the previous file content if there was one.
- Product schema is usually emitted by the theme already; the agent checks crawl coverage before proposing schema work.
