import type Anthropic from "@anthropic-ai/sdk";

export const tools: Anthropic.Tool[] = [
  {
    name: "search_resources",
    description: "Find Shopify resources (products, collections, pages, articles) by keyword in title, handle, or URL. Returns id, type, title, url, current seo title/description lengths, and GSC clicks/impressions for the current window.",
    input_schema: {
      type: "object",
      properties: { keyword: { type: "string" }, target_type: { type: "string", enum: ["product", "collection", "page", "article"] }, limit: { type: "integer", default: 20 } },
      required: ["keyword"],
    },
  },
  {
    name: "get_resource",
    description: "Full detail for one resource by Shopify GID or URL: Shopify fields (title, seo title, seo description, body html, tags, product type, images with alt), live crawl data (title tag, meta description, h1/h2, schema types, word count, text sample), GSC current vs previous (clicks, impressions, ctr, position), top 25 queries, and this agent's change history for it.",
    input_schema: { type: "object", properties: { id_or_url: { type: "string" } }, required: ["id_or_url"] },
  },
  {
    name: "get_queries_for_page",
    description: "Top GSC queries for a page URL in the current window, sorted by impressions. Optional min_impressions filter.",
    input_schema: { type: "object", properties: { url: { type: "string" }, min_impressions: { type: "integer", default: 0 }, limit: { type: "integer", default: 50 } }, required: ["url"] },
  },
  {
    name: "get_queries_without_home",
    description: "Queries with meaningful impressions (>= min_impressions) where the ranking page is the homepage or a page whose title does not contain any query word. These are content gaps: candidates for new FAQ sections on the right collection/product or a dedicated page.",
    input_schema: { type: "object", properties: { min_impressions: { type: "integer", default: 50 }, limit: { type: "integer", default: 40 } } },
  },
  {
    name: "get_history",
    description: "All proposals and applied changes this agent has ever made for a target id (any status), plus agent notes mentioning it.",
    input_schema: { type: "object", properties: { target_id: { type: "string" } }, required: ["target_id"] },
  },
  {
    name: "get_notes",
    description: "Agent notes from previous runs (things skipped, open questions). Read before proposing anything on a target you have not checked.",
    input_schema: { type: "object", properties: { keyword: { type: "string" }, limit: { type: "integer", default: 50 } } },
  },
  {
    name: "propose_change",
    description: "Submit a change for human approval. Returns {accepted, id} or {accepted:false, reason}. If rejected, do NOT resubmit a cosmetic variant.",
    input_schema: {
      type: "object",
      properties: {
        target_type: { type: "string", enum: ["product", "collection", "page", "article", "redirect", "theme_file"] },
        target_id: { type: "string", description: "Shopify GID. For redirect use 'new'. For theme_file use the filename, e.g. snippets/seo-agent-jsonld.liquid" },
        change_type: { type: "string", enum: ["seo_title", "seo_description", "body_html", "alt_text", "redirect", "noindex", "jsonld_snippet"] },
        after_value: { type: "string", description: "New value. body_html: complete HTML. redirect: '/old/path -> /new/path'. noindex: 'true' or 'false'. alt_text: the alt text. jsonld_snippet: full liquid/JSON-LD file content." },
        media_id: { type: "string", description: "Required for alt_text: the MediaImage GID" },
        reasoning: { type: "string", description: "Evidence-based, numeric. Cite GSC rows and crawl facts." },
        expected_impact: { type: "string", description: "One line, e.g. 'Query X: 2.1k impr, pos 6.2, CTR 1.1% vs ~4% expected; title rewrite targets +40 clicks/mo'" },
        category: { type: "string", enum: ["seo", "aeo", "technical"] },
        risk: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["target_type", "target_id", "change_type", "after_value", "reasoning", "expected_impact", "category", "risk"],
    },
  },
  {
    name: "add_note",
    description: "Record a decision not to act, an open question for the owner, or context future runs need. Mention the target id or url so it is searchable.",
    input_schema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
  },
  {
    name: "finish",
    description: "End the run with a summary for the reviewer.",
    input_schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
  },
];
