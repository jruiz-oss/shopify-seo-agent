import * as cheerio from "cheerio";

export type CrawlData = {
  url: string;
  status: number;
  finalUrl: string;
  title: string | null;
  titleLength: number;
  metaDescription: string | null;
  metaDescriptionLength: number;
  canonical: string | null;
  robotsMeta: string | null;
  h1: string[];
  h2: string[];
  wordCount: number;
  jsonLdTypes: string[];
  hasFaqSchema: boolean;
  hasProductSchema: boolean;
  hasBreadcrumbSchema: boolean;
  hasOrgSchema: boolean;
  faqLikeHeadings: string[]; // headings phrased as questions
  imagesTotal: number;
  imagesMissingAlt: number;
  internalLinks: number;
  ogTitle: string | null;
  ogDescription: string | null;
  textSample: string; // first ~1500 chars of main text for the agent
};

export async function crawl(url: string): Promise<CrawlData> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SEOAgent/1.0; +internal)" },
    redirect: "follow",
  });
  const html = await res.text();
  const $ = cheerio.load(html);

  const jsonLdTypes: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const j = JSON.parse($(el).text());
      const items = Array.isArray(j) ? j : j["@graph"] ? j["@graph"] : [j];
      for (const it of items) {
        const t = it?.["@type"];
        if (Array.isArray(t)) jsonLdTypes.push(...t);
        else if (t) jsonLdTypes.push(String(t));
      }
    } catch {
      /* ignore malformed */
    }
  });

  $("script, style, noscript, svg").remove();
  const mainText = ($("main").text() || $("body").text()).replace(/\s+/g, " ").trim();
  const words = mainText.split(" ").filter(Boolean).length;

  const h1 = $("h1").map((_, e) => $(e).text().trim()).get();
  const h2 = $("h2, h3").map((_, e) => $(e).text().trim()).get();
  const faqLike = h2.filter((h) => /\?$/.test(h) || /^(how|what|why|when|which|can|does|is|are|should)\b/i.test(h));

  const imgs = $("img");
  const missingAlt = imgs.filter((_, e) => !($(e).attr("alt") ?? "").trim()).length;

  const origin = new URL(url).origin;
  const internal = $("a[href]").filter((_, e) => {
    const h = $(e).attr("href") ?? "";
    return h.startsWith("/") || h.startsWith(origin);
  }).length;

  const title = $("title").first().text().trim() || null;
  const md = $('meta[name="description"]').attr("content")?.trim() || null;

  return {
    url,
    status: res.status,
    finalUrl: res.url,
    title,
    titleLength: title?.length ?? 0,
    metaDescription: md,
    metaDescriptionLength: md?.length ?? 0,
    canonical: $('link[rel="canonical"]').attr("href") ?? null,
    robotsMeta: $('meta[name="robots"]').attr("content") ?? null,
    h1,
    h2: h2.slice(0, 30),
    wordCount: words,
    jsonLdTypes: [...new Set(jsonLdTypes)],
    hasFaqSchema: jsonLdTypes.includes("FAQPage"),
    hasProductSchema: jsonLdTypes.includes("Product"),
    hasBreadcrumbSchema: jsonLdTypes.includes("BreadcrumbList"),
    hasOrgSchema: jsonLdTypes.includes("Organization") || jsonLdTypes.includes("OnlineStore"),
    faqLikeHeadings: faqLike.slice(0, 15),
    imagesTotal: imgs.length,
    imagesMissingAlt: missingAlt,
    internalLinks: internal,
    ogTitle: $('meta[property="og:title"]').attr("content") ?? null,
    ogDescription: $('meta[property="og:description"]').attr("content") ?? null,
    textSample: mainText.slice(0, 1500),
  };
}

export async function crawlMany(urls: string[], concurrency = 4): Promise<CrawlData[]> {
  const out: CrawlData[] = [];
  const queue = [...new Set(urls)];
  async function worker() {
    while (queue.length) {
      const u = queue.shift()!;
      try {
        out.push(await crawl(u));
      } catch (e: any) {
        out.push({ url: u, status: 0, finalUrl: u, title: null, titleLength: 0, metaDescription: null, metaDescriptionLength: 0, canonical: null, robotsMeta: null, h1: [], h2: [], wordCount: 0, jsonLdTypes: [], hasFaqSchema: false, hasProductSchema: false, hasBreadcrumbSchema: false, hasOrgSchema: false, faqLikeHeadings: [], imagesTotal: 0, imagesMissingAlt: 0, internalLinks: 0, ogTitle: null, ogDescription: null, textSample: `CRAWL ERROR: ${e?.message ?? e}` });
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}
