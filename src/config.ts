function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: req("DATABASE_URL"),

  // Shopify custom app (Admin API access token, shpat_...)
  shopify: {
    domain: req("SHOPIFY_STORE_DOMAIN"), // e.g. my-store.myshopify.com
    token: req("SHOPIFY_ADMIN_TOKEN"),
    apiVersion: process.env.SHOPIFY_API_VERSION ?? "2026-07",
  },

  // Public storefront URL the crawler and GSC use, e.g. https://www.brand.com
  siteUrl: req("SITE_URL").replace(/\/$/, ""),
  brandName: process.env.BRAND_NAME ?? "",
  brandNotes: process.env.BRAND_NOTES ?? "", // free text: positioning, audience, tone, no-go topics

  // GSC: service account JSON (stringified) with the site added as a user in Search Console
  gsc: {
    serviceAccountJson: req("GSC_SERVICE_ACCOUNT_JSON"),
    // sc-domain:brand.com  OR  https://www.brand.com/
    property: process.env.GSC_PROPERTY ?? `sc-domain:${new URL(req("SITE_URL")).hostname.replace(/^www\./, "")}`,
  },

  anthropic: {
    apiKey: req("ANTHROPIC_API_KEY"),
    model: process.env.AGENT_MODEL ?? "claude-sonnet-5",
    maxToolTurns: Number(process.env.AGENT_MAX_TURNS ?? 40),
  },

  agent: {
    // do not touch the same target+field again within this many days (lets you measure impact)
    cooldownDays: Number(process.env.COOLDOWN_DAYS ?? 45),
    // a rejected proposal blocks the same proposal for this many days
    rejectionMemoryDays: Number(process.env.REJECTION_MEMORY_DAYS ?? 90),
    // cap proposals per run so review stays manageable
    maxProposalsPerRun: Number(process.env.MAX_PROPOSALS_PER_RUN ?? 25),
    // cron schedule for automatic runs (default Monday 6am UTC). Empty string disables.
    cron: process.env.AGENT_CRON ?? "0 6 * * 1",
    // pages to crawl per run (top GSC pages + all key templates)
    crawlLimit: Number(process.env.CRAWL_LIMIT ?? 150),
  },

  dashboard: {
    user: process.env.DASHBOARD_USER ?? "admin",
    password: req("DASHBOARD_PASSWORD"),
  },
};
