import { config } from "../config.js";

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Simple line-level diff for long HTML fields. */
export function diffHtml(before: string, after: string): string {
  const a = before.split(/\n|(?<=>)(?=<)/).map((s) => s.trim()).filter(Boolean);
  const b = after.split(/\n|(?<=>)(?=<)/).map((s) => s.trim()).filter(Boolean);
  const setA = new Set(a), setB = new Set(b);
  const out: string[] = [];
  for (const line of a) if (!setB.has(line)) out.push(`<div class="del">- ${esc(line)}</div>`);
  for (const line of b) out.push(setA.has(line) ? `<div class="same">${esc(line)}</div>` : `<div class="add">+ ${esc(line)}</div>`);
  return `<div class="diff">${out.join("")}</div>`;
}

export function layout(title: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · SEO agent</title>
<style>
:root{--bg:#0f1115;--card:#171a21;--fg:#e6e8ec;--muted:#8b93a3;--line:#262b36;--acc:#5b8def;--ok:#2fbf71;--warn:#e0a52c;--bad:#e2554f;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
body{margin:0;background:var(--bg);color:var(--fg);font-size:14px}
.top{display:flex;gap:18px;align-items:center;padding:12px 20px;border-bottom:1px solid var(--line);background:#12151b}
.top a{color:var(--fg);text-decoration:none;opacity:.8}.top a:hover{opacity:1}.top b{color:var(--acc)}
main{max-width:1100px;margin:0 auto;padding:16px 20px}
.bar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.tabs a{display:inline-block;padding:6px 10px;margin-right:4px;border-radius:6px;color:var(--muted);text-decoration:none}
.tabs a.on{background:var(--card);color:var(--fg)}.tabs .n{opacity:.6;margin-left:4px}
.card{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--line);border-radius:8px;padding:14px 16px;margin:12px 0}
.card.risk-medium{border-left-color:var(--warn)}.card.risk-high{border-left-color:var(--bad)}.card.risk-low{border-left-color:var(--ok)}
.card header{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px}
.card h3{margin:4px 0 6px;font-size:15px;font-weight:600}
.tag{font-size:11px;padding:2px 7px;border-radius:999px;background:#222836;color:var(--fg)}
.tag.cat{background:#1f2f4a}.tag.risk{background:#2a2a33}.tag.warn{background:#4a3a14;color:#f3c35a}
.impact{color:#b9c3d6;margin:0 0 8px}
.kv{display:grid;grid-template-columns:60px 1fr;gap:8px;margin:4px 0}.kv span{color:var(--muted)}
code,pre{background:#0c0e12;border:1px solid var(--line);border-radius:4px;padding:2px 6px;white-space:pre-wrap;word-break:break-word;font-size:12.5px}
pre{padding:10px;margin:8px 0}
details{margin:6px 0}summary{cursor:pointer;color:var(--muted)}
.diff{background:#0c0e12;border:1px solid var(--line);border-radius:4px;padding:8px;font:12px ui-monospace,Menlo,monospace;max-height:420px;overflow:auto}
.diff .add{color:#7ee2a0}.diff .del{color:#ff8a80}.diff .same{color:#6f7787}
footer{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}
form.inline{display:inline-flex;gap:6px;margin:0}.bulk{margin:10px 0;display:flex;gap:8px}
button{background:#232936;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px 12px;cursor:pointer}
button.primary{background:var(--acc);border-color:var(--acc);color:#fff}button.danger{border-color:#5a2a28;color:#ff9a94}button.secondary{opacity:.8}
button:disabled{opacity:.5;cursor:default}
input{background:#0c0e12;border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:6px 8px;min-width:220px}
.muted{color:var(--muted)}.err{color:#ff9a94}
table{width:100%;border-collapse:collapse}td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--muted);font-weight:500}
</style></head><body>
<nav class="top"><b>SEO agent</b> <span class="muted">${esc(config.brandName || config.siteUrl)}</span> <a href="/">Proposals</a> <a href="/runs">Runs</a> <a href="/log">Change log</a></nav>
<main>${body}</main></body></html>`;
}
