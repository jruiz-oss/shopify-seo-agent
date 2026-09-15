import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { q, one } from "../db/index.js";
import * as shopify from "../connectors/shopify.js";
import * as gsc from "../connectors/gsc.js";
import { crawlMany, type CrawlData } from "../connectors/crawler.js";
import { systemPrompt } from "./prompt.js";
import { tools } from "./tools.js";
import { evaluate, fingerprint, type HistoryRecord } from "./dedupe.js";

type Ctx = {
  runId: number;
  resources: shopify.ShopifyResource[];
  byId: Map<string, shopify.ShopifyResource>;
  byUrl: Map<string, shopify.ShopifyResource>;
  redirects: Set<string>;
  crawl: Map<string, CrawlData>;
  gsc: Awaited<ReturnType<typeof gsc.pullAll>>;
  pageCur: Map<string, gsc.GscRow>;
  pagePrev: Map<string, gsc.GscRow>;
  proposalsMade: number;
};

const normUrl = (u: string) => u.replace(/\/$/, "").replace(/^http:/, "https:").toLowerCase();

export async function runAgent(trigger: "cron" | "manual" = "cron"): Promise<number> {
  const run = await one<{ id: number }>(`INSERT INTO runs (trigger) VALUES ($1) RETURNING id`, [trigger]);
  const runId = run!.id;
  const log = (m: string) => console.log(`[run ${runId}] ${m}`);

  try {
    // 1. Snapshot Shopify
    log("fetching Shopify catalog");
    const resources = await shopify.fetchAll();
    const redirectRows = await shopify.fetchRedirects();
    for (const r of resources) {
      await q(
        `INSERT INTO resource_snapshots (run_id, target_type, target_id, handle, url, state) VALUES ($1,$2,$3,$4,$5,$6)`,
        [runId, r.targetType, r.id, r.handle, r.url, JSON.stringify({ ...r, bodyHtml: (r.bodyHtml ?? "").slice(0, 20000) })],
      );
    }
    log(`snapshotted ${resources.length} resources, ${redirectRows.length} redirects`);

    // 2. GSC
    log("pulling GSC");
    const g = await gsc.pullAll();
    const insertRows = async (period: string, rows: gsc.GscRow[]) => {
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const values: any[] = [];
        const ph = chunk
          .map((r, j) => {
            values.push(runId, period, r.page ?? null, r.query ?? null, r.clicks, r.impressions, r.ctr, r.position);
            const b = j * 8;
            return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`;
          })
          .join(",");
        await q(`INSERT INTO gsc_rows (run_id, period, page, query, clicks, impressions, ctr, position) VALUES ${ph}`, values);
      }
    };
    await insertRows("current", g.pagesCur);
    await insertRows("previous", g.pagesPrev);
    await insertRows("current", g.pageQueryCur);
    log(`GSC: ${g.pagesCur.length} pages, ${g.queriesCur.length} queries, ${g.pageQueryCur.length} page-query rows`);

    // 3. Crawl: top GSC pages + all collections + all pages
    const byUrl = new Map(resources.map((r) => [normUrl(r.url), r]));
    const topPages = [...g.pagesCur].sort((a, b) => b.impressions - a.impressions).slice(0, config.agent.crawlLimit).map((r) => r.page!);
    const structural = resources.filter((r) => r.targetType !== "product" && r.targetType !== "article").map((r) => r.url);
    const urls = [...new Set([config.siteUrl + "/", ...topPages, ...structural])].slice(0, config.agent.crawlLimit + structural.length);
    log(`crawling ${urls.length} urls`);
    const crawled = await crawlMany(urls);
    for (const c of crawled) {
      await q(`INSERT INTO crawl_pages (run_id, url, status, data) VALUES ($1,$2,$3,$4)`, [runId, c.url, c.status, JSON.stringify(c)]);
    }

    const ctx: Ctx = {
      runId,
      resources,
      byId: new Map(resources.map((r) => [r.id, r])),
      byUrl,
      redirects: new Set(redirectRows.map((r) => r.path)),
      crawl: new Map(crawled.map((c) => [normUrl(c.url), c])),
      gsc: g,
      pageCur: new Map(g.pagesCur.map((r) => [normUrl(r.page!), r])),
      pagePrev: new Map(g.pagesPrev.map((r) => [normUrl(r.page!), r])),
      proposalsMade: 0,
    };

    // 4. Agent loop
    const brief = buildBrief(ctx);
    const usage = await agentLoop(ctx, brief, log);

    await q(`UPDATE runs SET status='done', finished_at=now(), input_tokens=$2, output_tokens=$3 WHERE id=$1`, [runId, usage.input, usage.output]);
    log("done");
    return runId;
  } catch (e: any) {
    console.error(e);
    await q(`UPDATE runs SET status='failed', finished_at=now(), error=$2 WHERE id=$1`, [runId, String(e?.stack ?? e)]);
    throw e;
  }
}

// ---------- brief: pre-aggregated opportunities so the model does not have to scan raw rows ----------

function expectedCtr(pos: number): number {
  // rough organic CTR curve, blended commercial
  if (pos <= 1) return 0.28;
  if (pos <= 2) return 0.15;
  if (pos <= 3) return 0.1;
  if (pos <= 5) return 0.06;
  if (pos <= 8) return 0.035;
  if (pos <= 12) return 0.02;
  return 0.01;
}

function buildBrief(ctx: Ctx): string {
  const lines: string[] = [];
  const { windows } = ctx.gsc;
  lines.push(`# Brief for run ${ctx.runId}`);
  lines.push(`Current window ${windows.current.start}..${windows.current.end}; previous ${windows.previous.start}..${windows.previous.end}`);

  const totCur = ctx.gsc.pagesCur.reduce((a, r) => ({ c: a.c + r.clicks, i: a.i + r.impressions }), { c: 0, i: 0 });
  const totPrev = ctx.gsc.pagesPrev.reduce((a, r) => ({ c: a.c + r.clicks, i: a.i + r.impressions }), { c: 0, i: 0 });
  lines.push(`Site: clicks ${totCur.c} (prev ${totPrev.c}), impressions ${totCur.i} (prev ${totPrev.i}). Catalog: ${ctx.resources.filter((r) => r.targetType === "product").length} products, ${ctx.resources.filter((r) => r.targetType === "collection").length} collections, ${ctx.resources.filter((r) => r.targetType === "page").length} pages, ${ctx.resources.filter((r) => r.targetType === "article").length} articles, ${ctx.redirects.size} redirects.`);

  // Homepage / site-wide crawl facts
  const home = ctx.crawl.get(normUrl(config.siteUrl + "/"));
  if (home) lines.push(`Homepage: title "${home.title}" (${home.titleLength}), meta ${home.metaDescriptionLength} chars, schema: ${home.jsonLdTypes.join(", ") || "none"}.`);
  const withCrawl = [...ctx.crawl.values()].filter((c) => c.status === 200);
  const schemaCoverage = {
    product: withCrawl.filter((c) => c.url.includes("/products/")).length,
    productWithSchema: withCrawl.filter((c) => c.url.includes("/products/") && c.hasProductSchema).length,
    breadcrumb: withCrawl.filter((c) => c.hasBreadcrumbSchema).length,
    faq: withCrawl.filter((c) => c.hasFaqSchema).length,
    org: withCrawl.filter((c) => c.hasOrgSchema).length,
  };
  lines.push(`Schema coverage across ${withCrawl.length} crawled pages: Product ${schemaCoverage.productWithSchema}/${schemaCoverage.product} product pages, BreadcrumbList on ${schemaCoverage.breadcrumb}, FAQPage on ${schemaCoverage.faq}, Organization on ${schemaCoverage.org}.`);

  // A. CTR underperformers
  const ctrGap = ctx.gsc.pagesCur
    .filter((r) => r.impressions >= 200)
    .map((r) => ({ ...r, exp: expectedCtr(r.position), gap: (expectedCtr(r.position) - r.ctr) * r.impressions }))
    .filter((r) => r.gap > 5)
    .sort((a, b) => b.gap - a.gap)
    .slice(0, 25);
  lines.push(`\n## A. CTR below expected for position (potential lost clicks/28d)`);
  for (const r of ctrGap) {
    const c = ctx.crawl.get(normUrl(r.page!));
    lines.push(`- ${r.page} | impr ${r.impressions} pos ${r.position.toFixed(1)} ctr ${(r.ctr * 100).toFixed(1)}% (exp ${(r.exp * 100).toFixed(1)}%) lost~${r.gap.toFixed(0)} | title(${c?.titleLength ?? "?"}) "${c?.title ?? "?"}" | meta ${c?.metaDescriptionLength ?? "?"}ch`);
  }

  // B. Striking distance queries
  const striking = ctx.gsc.pageQueryCur
    .filter((r) => r.position >= 4 && r.position <= 15 && r.impressions >= 100)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 40);
  lines.push(`\n## B. Striking-distance queries (pos 4-15, impr>=100)`);
  for (const r of striking) lines.push(`- "${r.query}" -> ${r.page} | impr ${r.impressions} clicks ${r.clicks} pos ${r.position.toFixed(1)}`);

  // C. Decliners
  const decl = ctx.gsc.pagesCur
    .map((r) => {
      const p = ctx.pagePrev.get(normUrl(r.page!));
      return p ? { page: r.page!, cur: r, prev: p, dClicks: r.clicks - p.clicks, dPos: r.position - p.position } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x && x.prev.clicks >= 20 && (x.dClicks <= -0.25 * x.prev.clicks || x.dPos >= 2))
    .sort((a, b) => a.dClicks - b.dClicks)
    .slice(0, 20);
  lines.push(`\n## C. Pages declining vs previous window`);
  for (const d of decl) lines.push(`- ${d.page} | clicks ${d.prev.clicks}->${d.cur.clicks} pos ${d.prev.position.toFixed(1)}->${d.cur.position.toFixed(1)} impr ${d.prev.impressions}->${d.cur.impressions}`);

  // D. On-page hygiene from crawl (only pages with impressions)
  const hygiene = withCrawl
    .filter((c) => (ctx.pageCur.get(normUrl(c.url))?.impressions ?? 0) >= 50)
    .map((c) => {
      const issues: string[] = [];
      if (!c.title) issues.push("no title");
      else if (c.titleLength > 65) issues.push(`title ${c.titleLength}ch`);
      if (!c.metaDescription) issues.push("no meta desc");
      else if (c.metaDescriptionLength < 70) issues.push(`meta ${c.metaDescriptionLength}ch`);
      if (c.h1.length !== 1) issues.push(`${c.h1.length} h1`);
      if (c.url.includes("/collections/") && c.wordCount < 120) issues.push(`thin (${c.wordCount}w)`);
      if (c.imagesMissingAlt > 0) issues.push(`${c.imagesMissingAlt}/${c.imagesTotal} img no alt`);
      if (c.robotsMeta?.includes("noindex")) issues.push("NOINDEX");
      return { c, issues, impr: ctx.pageCur.get(normUrl(c.url))?.impressions ?? 0 };
    })
    .filter((x) => x.issues.length)
    .sort((a, b) => b.impr - a.impr)
    .slice(0, 40);
  lines.push(`\n## D. On-page issues on pages with impressions`);
  for (const h of hygiene) lines.push(`- ${h.c.url} (impr ${h.impr}): ${h.issues.join(", ")}`);

  // E. Duplicate titles / meta
  const dupTitles = groupDup(withCrawl.map((c) => [c.title ?? "", c.url] as const));
  const dupMeta = groupDup(withCrawl.map((c) => [c.metaDescription ?? "", c.url] as const));
  lines.push(`\n## E. Duplicates`);
  for (const [t, urls] of dupTitles.slice(0, 10)) lines.push(`- title "${t}" on ${urls.length}: ${urls.slice(0, 4).join(", ")}`);
  for (const [t, urls] of dupMeta.slice(0, 10)) lines.push(`- meta "${t.slice(0, 60)}..." on ${urls.length}: ${urls.slice(0, 4).join(", ")}`);

  // F. 404s with traffic
  const dead = ctx.gsc.pagesCur.filter((r) => r.impressions >= 20 && ctx.crawl.get(normUrl(r.page!))?.status === 404);
  lines.push(`\n## F. GSC pages returning 404`);
  for (const d of dead) lines.push(`- ${d.page} | impr ${d.impressions} clicks ${d.clicks}`);

  // G. Question queries (AEO)
  const questions = ctx.gsc.queriesCur
    .filter((r) => /^(how|what|why|when|which|can|does|do|is|are|should|where|best)\b/i.test(r.query ?? "") && r.impressions >= 30)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 30);
  lines.push(`\n## G. Question-intent queries (AEO candidates)`);
  for (const r of questions) lines.push(`- "${r.query}" impr ${r.impressions} clicks ${r.clicks} pos ${r.position.toFixed(1)}`);

  // H. Prior work summary
  lines.push(`\n## H. Reminder`);
  lines.push(`Use get_history and get_notes before proposing on any target. propose_change enforces cooldown (${config.agent.cooldownDays}d) and rejection memory (${config.agent.rejectionMemoryDays}d).`);
  return lines.join("\n");
}

function groupDup(pairs: readonly (readonly [string, string])[]): [string, string[]][] {
  const m = new Map<string, string[]>();
  for (const [k, u] of pairs) {
    if (!k) continue;
    m.set(k, [...(m.get(k) ?? []), u]);
  }
  return [...m.entries()].filter(([, v]) => v.length > 1).sort((a, b) => b[1].length - a[1].length);
}

// ---------- tool execution ----------

async function execTool(ctx: Ctx, name: string, input: any): Promise<any> {
  switch (name) {
    case "search_resources": {
      const kw = String(input.keyword).toLowerCase();
      return ctx.resources
        .filter((r) => (!input.target_type || r.targetType === input.target_type) && (r.title.toLowerCase().includes(kw) || r.handle.includes(kw) || r.url.toLowerCase().includes(kw)))
        .slice(0, input.limit ?? 20)
        .map((r) => {
          const g = ctx.pageCur.get(normUrl(r.url));
          return { id: r.id, type: r.targetType, title: r.title, url: r.url, seoTitleLen: r.seoTitle?.length ?? 0, seoDescLen: r.seoDescription?.length ?? 0, clicks: g?.clicks ?? 0, impressions: g?.impressions ?? 0, position: g?.position };
        });
    }
    case "get_resource": {
      const r = ctx.byId.get(input.id_or_url) ?? ctx.byUrl.get(normUrl(input.id_or_url));
      const url = r ? normUrl(r.url) : normUrl(input.id_or_url);
      const crawl = ctx.crawl.get(url);
      const cur = ctx.pageCur.get(url);
      const prev = ctx.pagePrev.get(url);
      const queries = ctx.gsc.pageQueryCur.filter((x) => normUrl(x.page!) === url).sort((a, b) => b.impressions - a.impressions).slice(0, 25);
      const history = r ? await getHistory(r.id) : [];
      return { shopify: r ? { ...r, bodyHtml: (r.bodyHtml ?? "").slice(0, 12000) } : null, crawl, gsc: { current: cur, previous: prev, queries }, history };
    }
    case "get_queries_for_page": {
      const url = normUrl(input.url);
      return ctx.gsc.pageQueryCur
        .filter((x) => normUrl(x.page!) === url && x.impressions >= (input.min_impressions ?? 0))
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, input.limit ?? 50);
    }
    case "get_queries_without_home": {
      const home = normUrl(config.siteUrl + "/");
      const min = input.min_impressions ?? 50;
      const byQuery = new Map<string, gsc.GscRow[]>();
      for (const r of ctx.gsc.pageQueryCur) byQuery.set(r.query!, [...(byQuery.get(r.query!) ?? []), r]);
      const out: any[] = [];
      for (const [query, rows] of byQuery) {
        const top = rows.sort((a, b) => b.impressions - a.impressions)[0];
        if (top.impressions < min) continue;
        const res = ctx.byUrl.get(normUrl(top.page!));
        const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
        const titleMatch = res ? words.some((w) => res.title.toLowerCase().includes(w)) : false;
        if (normUrl(top.page!) === home || !titleMatch) out.push({ query, page: top.page, impressions: top.impressions, clicks: top.clicks, position: top.position, rankingPageTitle: res?.title ?? null });
      }
      return out.sort((a, b) => b.impressions - a.impressions).slice(0, input.limit ?? 40);
    }
    case "get_history":
      return getHistory(input.target_id);
    case "get_notes": {
      const kw = input.keyword ? `%${input.keyword}%` : "%";
      return q(`SELECT run_id, created_at, note FROM agent_notes WHERE note ILIKE $1 ORDER BY created_at DESC LIMIT $2`, [kw, input.limit ?? 50]);
    }
    case "add_note":
      await q(`INSERT INTO agent_notes (run_id, note) VALUES ($1,$2)`, [ctx.runId, input.note]);
      return { ok: true };
    case "propose_change":
      return propose(ctx, input);
    default:
      return { error: `unknown tool ${name}` };
  }
}

async function getHistory(targetId: string) {
  const proposals = await q(
    `SELECT id, created_at, change_type, status, after_value, review_note, applied_at FROM proposals WHERE target_id=$1 ORDER BY created_at DESC LIMIT 50`,
    [targetId],
  );
  const notes = await q(`SELECT run_id, created_at, note FROM agent_notes WHERE note ILIKE $1 ORDER BY created_at DESC LIMIT 20`, [`%${targetId}%`]);
  return { proposals: proposals.map((p) => ({ ...p, after_value: String(p.after_value).slice(0, 300) })), notes };
}

async function propose(ctx: Ctx, input: any) {
  if (ctx.proposalsMade >= config.agent.maxProposalsPerRun) return { accepted: false, reason: "proposal cap for this run reached; call finish" };

  const r = ctx.byId.get(input.target_id);
  if (!r && !["redirect", "theme_file"].includes(input.target_type)) return { accepted: false, reason: "unknown target_id; use search_resources to find the GID" };
  if (input.change_type === "alt_text" && !input.media_id) return { accepted: false, reason: "alt_text requires media_id" };
  if (input.change_type === "redirect" && !/^\/\S+\s*->\s*\/\S+$/.test(input.after_value)) return { accepted: false, reason: "redirect after_value must look like '/old -> /new'" };
  if (input.change_type === "seo_title" && input.after_value.length > 70) return { accepted: false, reason: `seo_title too long (${input.after_value.length}ch)` };
  if (input.change_type === "seo_description" && input.after_value.length > 165) return { accepted: false, reason: `seo_description too long (${input.after_value.length}ch)` };

  const draft = { target_type: input.target_type, target_id: input.change_type === "alt_text" ? input.media_id : input.target_id, change_type: input.change_type, after_value: input.after_value };
  const histRows = await q<{ change_type: string; after_value: string; status: string; created_at: string; applied_at: string | null }>(
    `SELECT change_type, after_value, status, created_at, applied_at FROM proposals WHERE target_id=$1 AND change_type=$2`,
    [draft.target_id, draft.change_type],
  );
  const history: HistoryRecord[] = histRows.map((h) => ({ change_type: h.change_type, after_value: h.after_value, status: h.status, at: new Date(h.applied_at ?? h.created_at) }));
  const img = r?.images?.find((i) => i.id === input.media_id);
  const verdict = evaluate(draft, { seoTitle: r?.seoTitle, seoDescription: r?.seoDescription, bodyHtml: r?.bodyHtml, title: r?.title, redirectPaths: ctx.redirects, existingAlt: img?.alt }, history, config.agent);
  if (!verdict.ok) return { accepted: false, reason: verdict.reason };

  const before =
    input.change_type === "seo_title" ? r?.seoTitle ?? "" :
    input.change_type === "seo_description" ? r?.seoDescription ?? "" :
    input.change_type === "body_html" ? r?.bodyHtml ?? "" :
    input.change_type === "alt_text" ? img?.alt ?? "" : null;

  const fp = fingerprint(draft);
  const row = await one<{ id: number }>(
    `INSERT INTO proposals (run_id, target_type, target_id, target_label, change_type, before_value, after_value, reasoning, expected_impact, category, risk, overrides_existing, fingerprint, apply_result)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [ctx.runId, input.target_type, draft.target_id, r ? `${r.title} (${r.url})` : input.target_id, input.change_type, before, input.after_value, input.reasoning, input.expected_impact, input.category, input.risk, verdict.overridesExisting, fp,
      JSON.stringify({ productId: r?.id ?? null, mediaId: input.media_id ?? null })],
  );
  ctx.proposalsMade++;
  return { accepted: true, id: row!.id, overrides_existing: verdict.overridesExisting };
}

// ---------- model loop ----------

async function agentLoop(ctx: Ctx, brief: string, log: (m: string) => void) {
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: brief }];
  let input = 0, output = 0;

  for (let turn = 0; turn < config.anthropic.maxToolTurns; turn++) {
    const res = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: 8000,
      system: systemPrompt(),
      tools,
      messages,
    });
    input += res.usage.input_tokens;
    output += res.usage.output_tokens;
    messages.push({ role: "assistant", content: res.content });

    const toolUses = res.content.filter((c): c is Anthropic.ToolUseBlock => c.type === "tool_use");
    if (!toolUses.length || res.stop_reason === "end_turn") {
      const text = res.content.filter((c): c is Anthropic.TextBlock => c.type === "text").map((c) => c.text).join("\n");
      await q(`UPDATE runs SET summary=$2 WHERE id=$1`, [ctx.runId, text || "(no summary)"]);
      break;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    let finished = false;
    for (const tu of toolUses) {
      if (tu.name === "finish") {
        await q(`UPDATE runs SET summary=$2 WHERE id=$1`, [ctx.runId, (tu.input as any).summary]);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: "ok" });
        finished = true;
        continue;
      }
      log(`tool ${tu.name} ${JSON.stringify(tu.input).slice(0, 120)}`);
      let out: any;
      try {
        out = await execTool(ctx, tu.name, tu.input);
      } catch (e: any) {
        out = { error: String(e?.message ?? e) };
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 60000) });
    }
    messages.push({ role: "user", content: results });
    if (finished) break;
  }
  log(`proposals: ${ctx.proposalsMade}, tokens in ${input} out ${output}`);
  return { input, output };
}
