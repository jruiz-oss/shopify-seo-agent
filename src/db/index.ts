import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "../config.js";

const { Pool } = pg;
export const pool = new Pool({
  connectionString: config.databaseUrl,
  // Railway private networking (postgres.railway.internal) has no SSL. Opt in with sslmode=require or PGSSL=true.
  ssl: config.databaseUrl.includes("sslmode=require") || process.env.PGSSL === "true"
    ? { rejectUnauthorized: false }
    : undefined,
});

export async function migrate() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  await pool.query(sql);
}

export async function q<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const r = await pool.query(text, params);
  return r.rows as T[];
}
export async function one<T = any>(text: string, params: any[] = []): Promise<T | undefined> {
  return (await q<T>(text, params))[0];
}

export type Proposal = {
  id: number;
  run_id: number;
  created_at: string;
  target_type: string;
  target_id: string;
  target_label: string | null;
  change_type: string;
  before_value: string | null;
  after_value: string;
  reasoning: string;
  expected_impact: string | null;
  category: string;
  risk: string;
  overrides_existing: boolean;
  fingerprint: string;
  status: string;
  reviewed_at: string | null;
  review_note: string | null;
  applied_at: string | null;
  apply_result: any;
  error: string | null;
};
