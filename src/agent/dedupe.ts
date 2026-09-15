import { createHash } from "node:crypto";

export type ProposalDraft = {
  target_type: string;
  target_id: string;
  change_type: string;
  after_value: string;
  before_value?: string | null;
};

export type HistoryRecord = {
  change_type: string;
  after_value: string;
  status: string; // applied | rejected | pending | approved | rolled_back
  at: Date;
};

export type LiveState = {
  seoTitle?: string | null;
  seoDescription?: string | null;
  bodyHtml?: string | null;
  title?: string;
  redirectPaths?: Set<string>;
  existingAlt?: string | null;
};

export type DedupeVerdict = { ok: true; overridesExisting: boolean } | { ok: false; reason: string };

export function fingerprint(p: ProposalDraft): string {
  return createHash("sha256")
    .update(`${p.target_type}|${p.target_id}|${p.change_type}|${normalize(p.after_value)}`)
    .digest("hex");
}

export function normalize(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Decide whether a proposal is genuinely new work.
 * - live: what Shopify has right now (the "record of previous work" for an existing store)
 * - history: this agent's own proposals/changes for the same target
 */
export function evaluate(
  p: ProposalDraft,
  live: LiveState,
  history: HistoryRecord[],
  opts: { cooldownDays: number; rejectionMemoryDays: number; now?: Date },
): DedupeVerdict {
  const now = opts.now ?? new Date();
  const days = (d: Date) => (now.getTime() - d.getTime()) / 86_400_000;
  const after = normalize(p.after_value);

  if (!after) return { ok: false, reason: "empty after_value" };

  // 1. Already live: the site already says exactly this.
  const liveValue = liveValueFor(p.change_type, live);
  if (liveValue !== undefined && normalize(liveValue) === after) {
    return { ok: false, reason: "value already live on Shopify" };
  }
  if (p.change_type === "redirect" && live.redirectPaths?.has(redirectPath(p.after_value))) {
    return { ok: false, reason: "redirect for this path already exists" };
  }

  // 2. History: same target + change_type
  for (const h of history.filter((h) => h.change_type === p.change_type)) {
    const same = normalize(h.after_value) === after;
    if (h.status === "pending" || h.status === "approved") {
      return { ok: false, reason: `a ${h.status} proposal already exists for this field` };
    }
    if (h.status === "rejected" && same && days(h.at) <= opts.rejectionMemoryDays) {
      return { ok: false, reason: `identical proposal rejected ${Math.round(days(h.at))}d ago` };
    }
    if (h.status === "applied" && days(h.at) <= opts.cooldownDays) {
      return { ok: false, reason: `field changed ${Math.round(days(h.at))}d ago, still in ${opts.cooldownDays}d cooldown` };
    }
    if (h.status === "applied" && same) {
      return { ok: false, reason: "this exact value was applied before and later changed; do not flip-flop" };
    }
  }

  // 3. Override detection: existing hand-set value that looks intentional.
  const overridesExisting = looksIntentional(p.change_type, live);
  return { ok: true, overridesExisting };
}

function liveValueFor(changeType: string, live: LiveState): string | null | undefined {
  switch (changeType) {
    case "seo_title":
      return live.seoTitle ?? "";
    case "seo_description":
      return live.seoDescription ?? "";
    case "body_html":
      return live.bodyHtml ?? "";
    case "alt_text":
      return live.existingAlt ?? "";
    default:
      return undefined;
  }
}

function redirectPath(afterValue: string): string {
  // after_value for redirects is "path -> target"
  return afterValue.split("->")[0].trim();
}

/** Heuristic: was this field already deliberately optimized by a human/tool? */
export function looksIntentional(changeType: string, live: LiveState): boolean {
  if (changeType === "seo_title") {
    const t = live.seoTitle ?? "";
    // Shopify defaults seo title to the resource title; anything different was set on purpose
    return !!t && normalize(t) !== normalize(live.title) && t.length >= 20;
  }
  if (changeType === "seo_description") {
    const d = live.seoDescription ?? "";
    return d.length >= 70 && d.length <= 170;
  }
  if (changeType === "alt_text") {
    return !!(live.existingAlt ?? "").trim();
  }
  return false;
}
