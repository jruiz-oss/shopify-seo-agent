import { q, one, type Proposal } from "../db/index.js";
import * as shopify from "../connectors/shopify.js";

/** Apply an approved proposal to Shopify. Records to change_log. */
export async function applyProposal(id: number): Promise<void> {
  const p = await one<Proposal>(`SELECT * FROM proposals WHERE id=$1`, [id]);
  if (!p) throw new Error("proposal not found");
  if (p.status !== "approved") throw new Error(`proposal ${id} is ${p.status}, not approved`);

  try {
    const result: any = {};
    switch (p.change_type) {
      case "seo_title":
        await shopify.updateSeo(p.target_type, p.target_id, "title", p.after_value);
        break;
      case "seo_description":
        await shopify.updateSeo(p.target_type, p.target_id, "description", p.after_value);
        break;
      case "body_html":
        await shopify.updateBody(p.target_type, p.target_id, p.after_value);
        break;
      case "alt_text": {
        const productId = p.apply_result?.productId;
        if (!productId) throw new Error("alt_text proposal missing productId");
        await shopify.updateMediaAlt(productId, p.target_id, p.after_value);
        break;
      }
      case "redirect": {
        const [path, target] = p.after_value.split("->").map((s) => s.trim());
        result.redirectId = await shopify.createRedirect(path, target);
        break;
      }
      case "noindex":
        await shopify.setNoindex(p.target_type, p.target_id, p.after_value === "true");
        break;
      case "jsonld_snippet": {
        const themeId = await shopify.getMainThemeId();
        const before = await shopify.readThemeFile(themeId, p.target_id);
        result.themeId = themeId;
        result.previousContent = before;
        await shopify.upsertThemeFile(themeId, p.target_id, p.after_value);
        break;
      }
      default:
        throw new Error(`unsupported change_type ${p.change_type}`);
    }

    await q(`UPDATE proposals SET status='applied', applied_at=now(), apply_result = COALESCE(apply_result,'{}'::jsonb) || $2::jsonb, error=NULL WHERE id=$1`, [id, JSON.stringify(result)]);
    await q(
      `INSERT INTO change_log (proposal_id, target_type, target_id, change_type, before_value, after_value) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, p.target_type, p.target_id, p.change_type, p.before_value, p.after_value],
    );
  } catch (e: any) {
    await q(`UPDATE proposals SET status='failed', error=$2 WHERE id=$1`, [id, String(e?.message ?? e)]);
    throw e;
  }
}

/** Revert an applied proposal using the stored before_value. */
export async function rollbackProposal(id: number): Promise<void> {
  const p = await one<Proposal>(`SELECT * FROM proposals WHERE id=$1`, [id]);
  if (!p || p.status !== "applied") throw new Error("only applied proposals can be rolled back");

  switch (p.change_type) {
    case "seo_title":
      await shopify.updateSeo(p.target_type, p.target_id, "title", p.before_value ?? "");
      break;
    case "seo_description":
      await shopify.updateSeo(p.target_type, p.target_id, "description", p.before_value ?? "");
      break;
    case "body_html":
      await shopify.updateBody(p.target_type, p.target_id, p.before_value ?? "");
      break;
    case "alt_text":
      await shopify.updateMediaAlt(p.apply_result.productId, p.target_id, p.before_value ?? "");
      break;
    case "redirect":
      if (p.apply_result?.redirectId) await shopify.deleteRedirect(p.apply_result.redirectId);
      break;
    case "noindex":
      await shopify.setNoindex(p.target_type, p.target_id, p.after_value !== "true");
      break;
    case "jsonld_snippet":
      if (p.apply_result?.previousContent != null) await shopify.upsertThemeFile(p.apply_result.themeId, p.target_id, p.apply_result.previousContent);
      else await shopify.upsertThemeFile(p.apply_result.themeId, p.target_id, "{%- comment -%}rolled back by seo-agent{%- endcomment -%}");
      break;
  }
  await q(`UPDATE proposals SET status='rolled_back' WHERE id=$1`, [id]);
  await q(`UPDATE change_log SET rolled_back_at=now() WHERE proposal_id=$1`, [id]);
}

export async function applyAllApproved(): Promise<{ applied: number[]; failed: { id: number; error: string }[] }> {
  const rows = await q<{ id: number }>(`SELECT id FROM proposals WHERE status='approved' ORDER BY id`);
  const applied: number[] = [];
  const failed: { id: number; error: string }[] = [];
  for (const { id } of rows) {
    try {
      await applyProposal(id);
      applied.push(id);
    } catch (e: any) {
      failed.push({ id, error: String(e?.message ?? e) });
    }
  }
  return { applied, failed };
}
