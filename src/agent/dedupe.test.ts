import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, fingerprint, looksIntentional } from "./dedupe.js";

const opts = { cooldownDays: 45, rejectionMemoryDays: 90, now: new Date("2026-09-15") };
const daysAgo = (n: number) => new Date(opts.now.getTime() - n * 86_400_000);

test("blocks value already live", () => {
  const v = evaluate(
    { target_type: "product", target_id: "1", change_type: "seo_title", after_value: "Blue Widget | Brand" },
    { seoTitle: "blue widget | brand", title: "Blue Widget" },
    [],
    opts,
  );
  assert.equal(v.ok, false);
});

test("blocks during cooldown after an applied change", () => {
  const v = evaluate(
    { target_type: "product", target_id: "1", change_type: "seo_title", after_value: "New" },
    { seoTitle: "Old", title: "Old" },
    [{ change_type: "seo_title", after_value: "Old", status: "applied", at: daysAgo(10) }],
    opts,
  );
  assert.equal(v.ok, false);
  assert.match((v as any).reason, /cooldown/);
});

test("allows after cooldown", () => {
  const v = evaluate(
    { target_type: "product", target_id: "1", change_type: "seo_title", after_value: "New" },
    { seoTitle: "Old", title: "Old" },
    [{ change_type: "seo_title", after_value: "Old", status: "applied", at: daysAgo(60) }],
    opts,
  );
  assert.equal(v.ok, true);
});

test("remembers rejections", () => {
  const v = evaluate(
    { target_type: "page", target_id: "2", change_type: "seo_description", after_value: "Try this" },
    { seoDescription: "" },
    [{ change_type: "seo_description", after_value: "try this", status: "rejected", at: daysAgo(30) }],
    opts,
  );
  assert.equal(v.ok, false);
});

test("blocks when a pending proposal exists for the field", () => {
  const v = evaluate(
    { target_type: "page", target_id: "2", change_type: "seo_description", after_value: "Another" },
    { seoDescription: "" },
    [{ change_type: "seo_description", after_value: "x", status: "pending", at: daysAgo(1) }],
    opts,
  );
  assert.equal(v.ok, false);
});

test("flags override of a hand-set seo title", () => {
  const v = evaluate(
    { target_type: "product", target_id: "1", change_type: "seo_title", after_value: "Brand New Title Here" },
    { seoTitle: "Handcrafted Blue Widget for Cyclists | Brand", title: "Blue Widget" },
    [],
    opts,
  );
  assert.deepEqual(v, { ok: true, overridesExisting: true });
});

test("default seo title is not intentional", () => {
  assert.equal(looksIntentional("seo_title", { seoTitle: "Blue Widget", title: "Blue Widget" }), false);
});

test("redirect dedupe by path", () => {
  const v = evaluate(
    { target_type: "redirect", target_id: "new", change_type: "redirect", after_value: "/old-page -> /pages/new" },
    { redirectPaths: new Set(["/old-page"]) },
    [],
    opts,
  );
  assert.equal(v.ok, false);
});

test("fingerprint stable under whitespace/case", () => {
  const a = fingerprint({ target_type: "p", target_id: "1", change_type: "seo_title", after_value: "Hello  World" });
  const b = fingerprint({ target_type: "p", target_id: "1", change_type: "seo_title", after_value: "hello world" });
  assert.equal(a, b);
});
