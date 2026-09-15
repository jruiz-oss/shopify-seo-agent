import express from "express";
import { config } from "../config.js";
import { q, one, type Proposal } from "../db/index.js";
import { applyProposal, applyAllApproved, rollbackProposal } from "../apply/index.js";
import { runAgent } from "../agent/run.js";
import { layout, esc, diffHtml } from "./views.js";

let running = false;

export function startServer() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  // health check is public so Railway can probe it
  app.get("/health", (_req, res) => res.json({ ok: true, running }));

  // basic auth for everything else
  app.use((req, res, next) => {
    const h = req.headers.authorization ?? "";
    const [, b64] = h.split(" ");
    const [u, p] = Buffer.from(b64 ?? "", "base64").toString().split(":");
    if (u === config.dashboard.user && p === config.dashboard.password) return next();
    res.set("WWW-Authenticate", 'Basic realm="seo-agent"').status(401).send("auth required");
  });

  // ---- inbox: pending proposals ----
  app.get("/", async (req, res) => {
    const status = String(req.query.status ?? "pending");
    const rows = await q<Proposal & { run_started: string }>(
      `SELECT p.*, r.started_at AS run_started FROM proposals p JOIN runs r ON r.id=p.run_id WHERE p.status=$1 ORDER BY p.risk DESC, p.id DESC LIMIT 200`,
      [status],
    );
    const counts = await q<{ status: string; n: number }>(`SELECT status, count(*)::int n FROM proposals GROUP BY status`);
    const lastRun = await one(`SELECT * FROM runs ORDER BY id DESC LIMIT 1`);

    const nav = ["pending", "approved", "applied", "rejected", "failed", "rolled_back"]
      .map((s) => `<a class="${s === status ? "on" : ""}" href="/?status=${s}">${s} <span class="n">${counts.find((c) => c.status === s)?.n ?? 0}</span></a>`)
      .join("");

    const body = `
      <div class="bar">
        <div class="tabs">${nav}</div>
        <form method="post" action="/run" class="inline"><button ${running ? "disabled" : ""}>${running ? "Run in progress…" : "Run agent now"}</button></form>
      </div>
      ${lastRun ? `<p class="muted">Last run #${lastRun.id} ${esc(lastRun.status)} ${new Date(lastRun.started_at).toLocaleString()} ${lastRun.error ? `<span class="err">${esc(lastRun.error.slice(0, 200))}</span>` : ""}</p>` : ""}
      ${status === "pending" && rows.length ? `
        <form method="post" action="/bulk" class="bulk">
          <button name="action" value="approve_low">Approve all low-risk (${rows.filter((r) => r.risk === "low" && !r.overrides_existing).length})</button>
          <button name="action" value="approve_all" class="secondary">Approve all pending</button>
        </form>` : ""}
      ${status === "approved" && rows.length ? `<form method="post" action="/apply-all" class="bulk"><button>Apply all approved to Shopify (${rows.length})</button></form>` : ""}
      ${rows.length ? rows.map(card).join("") : `<p class="muted">Nothing ${esc(status)}.</p>`}
    `;
    res.send(layout("Proposals", body));
  });

  function card(p: Proposal) {
    const long = p.change_type === "body_html" || p.change_type === "jsonld_snippet";
    return `
    <article class="card risk-${p.risk}">
      <header>
        <span class="tag">${esc(p.change_type)}</span>
        <span class="tag cat">${esc(p.category)}</span>
        <span class="tag risk">${esc(p.risk)} risk</span>
        ${p.overrides_existing ? `<span class="tag warn">overrides existing</span>` : ""}
        <span class="muted">#${p.id} · run ${p.run_id}</span>
      </header>
      <h3>${esc(p.target_label ?? p.target_id)}</h3>
      <p class="impact">${esc(p.expected_impact ?? "")}</p>
      <details ${long ? "" : "open"}><summary>Change</summary>
        ${long ? diffHtml(p.before_value ?? "", p.after_value) : `
          <div class="kv"><span>Before</span><code>${esc(p.before_value || "(empty)")}</code></div>
          <div class="kv"><span>After</span><code>${esc(p.after_value)}</code> <small>${p.after_value.length}ch</small></div>`}
      </details>
      <details><summary>Reasoning</summary><p>${esc(p.reasoning).replace(/\n/g, "<br>")}</p></details>
      ${p.error ? `<p class="err">${esc(p.error)}</p>` : ""}
      ${p.review_note ? `<p class="muted">Note: ${esc(p.review_note)}</p>` : ""}
      <footer>
        ${p.status === "pending" ? `
          <form method="post" action="/p/${p.id}/approve" class="inline"><button>Approve</button></form>
          <form method="post" action="/p/${p.id}/approve" class="inline"><input type="hidden" name="apply" value="1"><button class="primary">Approve + apply now</button></form>
          <form method="post" action="/p/${p.id}/reject" class="inline"><input name="note" placeholder="why (agent remembers)"><button class="danger">Reject</button></form>` : ""}
        ${p.status === "approved" ? `<form method="post" action="/p/${p.id}/apply" class="inline"><button class="primary">Apply to Shopify</button></form>
          <form method="post" action="/p/${p.id}/reject" class="inline"><button class="danger">Un-approve</button></form>` : ""}
        ${p.status === "applied" ? `<span class="muted">applied ${new Date(p.applied_at!).toLocaleString()}</span> <form method="post" action="/p/${p.id}/rollback" class="inline"><button class="danger">Roll back</button></form>` : ""}
        ${p.status === "failed" ? `<form method="post" action="/p/${p.id}/retry" class="inline"><button>Retry</button></form>` : ""}
      </footer>
    </article>`;
  }

  app.post("/p/:id/approve", async (req, res) => {
    const id = Number(req.params.id);
    await q(`UPDATE proposals SET status='approved', reviewed_at=now() WHERE id=$1 AND status='pending'`, [id]);
    if (req.body.apply) {
      try { await applyProposal(id); } catch { /* status recorded as failed */ }
      return res.redirect("/?status=applied");
    }
    res.redirect("/");
  });
  app.post("/p/:id/reject", async (req, res) => {
    await q(`UPDATE proposals SET status='rejected', reviewed_at=now(), review_note=$2 WHERE id=$1 AND status IN ('pending','approved')`, [Number(req.params.id), req.body.note || null]);
    res.redirect("/");
  });
  app.post("/p/:id/apply", async (req, res) => {
    try { await applyProposal(Number(req.params.id)); } catch { /* recorded */ }
    res.redirect("/?status=applied");
  });
  app.post("/p/:id/retry", async (req, res) => {
    await q(`UPDATE proposals SET status='approved', error=NULL WHERE id=$1 AND status='failed'`, [Number(req.params.id)]);
    try { await applyProposal(Number(req.params.id)); } catch { /* recorded */ }
    res.redirect("/?status=applied");
  });
  app.post("/p/:id/rollback", async (req, res) => {
    try { await rollbackProposal(Number(req.params.id)); } catch (e: any) { return res.status(500).send(layout("Error", `<p class="err">${esc(e.message)}</p><a href="/?status=applied">back</a>`)); }
    res.redirect("/?status=rolled_back");
  });
  app.post("/bulk", async (req, res) => {
    if (req.body.action === "approve_low") await q(`UPDATE proposals SET status='approved', reviewed_at=now() WHERE status='pending' AND risk='low' AND overrides_existing=false`);
    if (req.body.action === "approve_all") await q(`UPDATE proposals SET status='approved', reviewed_at=now() WHERE status='pending'`);
    res.redirect("/?status=approved");
  });
  app.post("/apply-all", async (_req, res) => {
    await applyAllApproved();
    res.redirect("/?status=applied");
  });

  // ---- runs ----
  app.get("/runs", async (_req, res) => {
    const runs = await q(`SELECT r.*, (SELECT count(*)::int FROM proposals p WHERE p.run_id=r.id) n FROM runs r ORDER BY id DESC LIMIT 50`);
    const body = `<h2>Runs</h2>` + runs.map((r) => `
      <article class="card">
        <header><b>#${r.id}</b> <span class="tag">${esc(r.status)}</span> <span class="muted">${new Date(r.started_at).toLocaleString()} · ${r.trigger} · ${r.n} proposals · ${r.input_tokens + r.output_tokens} tokens</span></header>
        ${r.summary ? `<pre>${esc(r.summary)}</pre>` : ""}
        ${r.error ? `<pre class="err">${esc(r.error)}</pre>` : ""}
        <a href="/runs/${r.id}/notes">notes</a>
      </article>`).join("");
    res.send(layout("Runs", body));
  });
  app.get("/runs/:id/notes", async (req, res) => {
    const notes = await q(`SELECT * FROM agent_notes WHERE run_id=$1 ORDER BY id`, [Number(req.params.id)]);
    res.send(layout("Notes", `<h2>Agent notes, run ${req.params.id}</h2><ul>${notes.map((n) => `<li>${esc(n.note)}</li>`).join("") || "<li>none</li>"}</ul>`));
  });

  // ---- change log ----
  app.get("/log", async (_req, res) => {
    const rows = await q(`SELECT c.*, p.target_label FROM change_log c LEFT JOIN proposals p ON p.id=c.proposal_id ORDER BY c.id DESC LIMIT 300`);
    const body = `<h2>Change log</h2><table><tr><th>when</th><th>target</th><th>change</th><th>after</th><th></th></tr>` +
      rows.map((r) => `<tr><td>${new Date(r.applied_at).toLocaleDateString()}</td><td>${esc(r.target_label ?? r.target_id)}</td><td>${esc(r.change_type)}</td><td><code>${esc(String(r.after_value).slice(0, 120))}</code></td><td>${r.rolled_back_at ? "rolled back" : ""}</td></tr>`).join("") + `</table>`;
    res.send(layout("Change log", body));
  });

  app.post("/run", async (_req, res) => {
    if (!running) {
      running = true;
      runAgent("manual").catch(() => {}).finally(() => { running = false; });
    }
    res.redirect("/runs");
  });

  app.listen(config.port, () => console.log(`dashboard on :${config.port}`));
  return { isRunning: () => running, setRunning: (v: boolean) => (running = v) };
}
