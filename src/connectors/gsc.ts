import { google } from "googleapis";
import { config } from "../config.js";

export type GscRow = { page?: string; query?: string; clicks: number; impressions: number; ctr: number; position: number };

function client() {
  const creds = JSON.parse(config.gsc.serviceAccountJson);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
  });
  return google.searchconsole({ version: "v1", auth });
}

function iso(d: Date) {
  return d.toISOString().slice(0, 10);
}

// GSC data lags ~2-3 days. Use two trailing 28-day windows for trend comparison.
export function windows() {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 3);
  const curStart = new Date(end);
  curStart.setUTCDate(curStart.getUTCDate() - 27);
  const prevEnd = new Date(curStart);
  prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - 27);
  return {
    current: { start: iso(curStart), end: iso(end) },
    previous: { start: iso(prevStart), end: iso(prevEnd) },
  };
}

async function query(dimensions: string[], start: string, end: string, rowLimit = 5000, filters?: any[]): Promise<GscRow[]> {
  const sc = client();
  const out: GscRow[] = [];
  let startRow = 0;
  while (true) {
    const res = await sc.searchanalytics.query({
      siteUrl: config.gsc.property,
      requestBody: {
        startDate: start,
        endDate: end,
        dimensions,
        rowLimit: Math.min(rowLimit, 25000),
        startRow,
        type: "web",
        dimensionFilterGroups: filters ? [{ filters }] : undefined,
      },
    });
    const rows = res.data.rows ?? [];
    for (const r of rows) {
      const keys = r.keys ?? [];
      const row: GscRow = {
        clicks: r.clicks ?? 0,
        impressions: r.impressions ?? 0,
        ctr: r.ctr ?? 0,
        position: r.position ?? 0,
      };
      dimensions.forEach((d, i) => {
        if (d === "page") row.page = keys[i];
        if (d === "query") row.query = keys[i];
      });
      out.push(row);
    }
    if (rows.length < 25000 || out.length >= rowLimit) break;
    startRow += rows.length;
  }
  return out;
}

export async function pullAll() {
  const w = windows();
  const [pagesCur, pagesPrev, queriesCur, queriesPrev, pageQueryCur] = await Promise.all([
    query(["page"], w.current.start, w.current.end),
    query(["page"], w.previous.start, w.previous.end),
    query(["query"], w.current.start, w.current.end),
    query(["query"], w.previous.start, w.previous.end),
    query(["page", "query"], w.current.start, w.current.end, 20000),
  ]);
  return { windows: w, pagesCur, pagesPrev, queriesCur, queriesPrev, pageQueryCur };
}

export async function queriesForPage(page: string, start: string, end: string): Promise<GscRow[]> {
  return query(["query"], start, end, 200, [{ dimension: "page", operator: "equals", expression: page }]);
}
