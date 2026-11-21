// Self-contained HTML report (inline CSS/JS, no external files, opens offline, attachable to tickets).
import fs from 'node:fs';
import path from 'node:path';
import { dumps, parseJson } from '../util/json.js';
import { roundHalfEven } from '../util/py.js';
import { buildReportData } from './model.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' };
/** HTML escape (same characters as Jinja2's autoescape). */
export const e = (v) => (v === null || v === undefined ? 'None' : String(v)).replace(/[&<>"']/g, (ch) => ESC[ch]);
const eo = (v) => (v === null || v === undefined ? '' : e(v)); // escape, empty for missing values

function prettyBody(text) {
  if (!text) return '';
  try {
    return dumps(parseJson(text, { rawNumbers: true }), { indent: 2 });
  } catch {
    return text;
  }
}

const statusLabel = (s) => s.replace(/_/g, ' ');

const CSS = `:root{
  --bg:#f7f7f5;--panel:#ffffff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e3e2dd;--code:#f1f0ec;
  --pass:#2f7d4f;--fail:#b3261e;--warn:#9a6700;--known:#6b6b66;--skip:#8a8a84;--err:#7a2e8a;--accent:#2d5b9a;
  --pass-bg:#e6f2ea;--fail-bg:#fbe9e7;--warn-bg:#fdf3dc;--known-bg:#eeeeeb;--skip-bg:#f0f0ee;--err-bg:#f3e8f6;
}
@media (prefers-color-scheme: dark){:root{
  --bg:#161615;--panel:#1f1f1d;--ink:#e9e8e4;--muted:#a3a29c;--line:#34342f;--code:#2a2a27;
  --pass:#6cc28e;--fail:#ff8a80;--warn:#e8b54a;--known:#a3a29c;--skip:#8f8e88;--err:#d39be0;--accent:#8fb5ef;
  --pass-bg:#1d3326;--fail-bg:#3d1f1c;--warn-bg:#3a2f15;--known-bg:#2a2a27;--skip-bg:#252523;--err-bg:#33213a;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:17px;margin:32px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
h3{font-size:14px;margin:16px 0 6px}
.muted{color:var(--muted)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:4px 24px;margin-top:12px}
.meta div{overflow-wrap:anywhere}
.meta b{font-weight:600;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.03em;display:block}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-top:16px}
.tile{border-radius:8px;padding:10px 12px;border:1px solid var(--line);background:var(--panel)}
.tile .n{font-size:24px;font-weight:650;font-variant-numeric:tabular-nums}
.tile .l{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}
.s-PASS{color:var(--pass)}.s-FAIL,.s-BASELINE_FAILED{color:var(--fail)}.s-WARN{color:var(--warn)}.s-KNOWN{color:var(--known)}.s-SKIPPED{color:var(--skip)}.s-ERROR{color:var(--err)}
.badge{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:650;letter-spacing:.02em;white-space:nowrap}
.b-PASS{background:var(--pass-bg);color:var(--pass)}.b-FAIL,.b-BASELINE_FAILED{background:var(--fail-bg);color:var(--fail)}
.b-WARN{background:var(--warn-bg);color:var(--warn)}.b-KNOWN{background:var(--known-bg);color:var(--known)}
.b-SKIPPED{background:var(--skip-bg);color:var(--skip)}.b-ERROR{background:var(--err-bg);color:var(--err)}
.banner{border-radius:8px;padding:12px 14px;margin-top:16px;border:1px solid var(--line)}
.banner.bad{background:var(--fail-bg);color:var(--fail)}
.banner.ok{background:var(--pass-bg);color:var(--pass)}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:12px;background:var(--panel);position:sticky;top:0}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:none}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
pre{background:var(--code);padding:10px;border-radius:6px;overflow:auto;max-height:360px;white-space:pre-wrap;word-break:break-word;margin:6px 0}
details.case{border:1px solid var(--line);border-radius:8px;background:var(--panel);margin:6px 0}
details.case>summary{cursor:pointer;padding:8px 12px;list-style:none;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
details.case>summary::-webkit-details-marker{display:none}
details.case[open]>summary{border-bottom:1px solid var(--line)}
.case-body{padding:10px 14px}
.kv{display:grid;grid-template-columns:140px 1fr;gap:2px 12px}
.kv dt{color:var(--muted)}.kv dd{margin:0;overflow-wrap:anywhere}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media (max-width:760px){.cols{grid-template-columns:1fr}.kv{grid-template-columns:1fr}}
.tabs button,.btn{font:inherit;font-size:12px;padding:3px 10px;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:6px;cursor:pointer}
.tabs button[aria-selected=true]{background:var(--ink);color:var(--panel)}
.btn:hover,.tabs button:hover{border-color:var(--muted)}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 10px}
.filters input,.filters select{font:inherit;font-size:13px;padding:4px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--ink)}
.filters input{flex:1;min-width:180px}
.empty{color:var(--muted);font-style:italic}
nav.toc{display:flex;gap:14px;flex-wrap:wrap;margin-top:14px;font-size:13px}
nav.toc a{color:var(--accent);text-decoration:none}`;

const SCRIPT = `(function(){
  document.addEventListener('click', function(e){
    var tab = e.target.closest('.tabs [data-tab]');
    if (tab){
      var body = tab.closest('.case-body');
      body.querySelectorAll('.tabs [data-tab]').forEach(function(b){ b.setAttribute('aria-selected', b===tab ? 'true':'false'); });
      body.querySelectorAll('pre[data-pane="bash"],pre[data-pane="ps"]').forEach(function(p){ p.hidden = p.dataset.pane !== tab.dataset.tab; });
      return;
    }
    var btn = e.target.closest('.copy');
    if (btn){
      var body = btn.closest('.case-body'), text;
      if (btn.dataset.copy === 'ticket'){ text = body.querySelector('pre[data-pane="ticket"]').textContent; }
      else { var sel = body.querySelector('.tabs [aria-selected="true"]').dataset.tab; text = body.querySelector('pre[data-pane="'+sel+'"]').textContent; }
      var done = function(){ var o = btn.textContent; btn.textContent = 'Copied'; setTimeout(function(){ btn.textContent = o; }, 1200); };
      if (navigator.clipboard && window.isSecureContext !== false){ navigator.clipboard.writeText(text).then(done, function(){ fallback(text); done(); }); }
      else { fallback(text); done(); }
    }
  });
  function fallback(text){ var t=document.createElement('textarea'); t.value=text; document.body.appendChild(t); t.select(); try{document.execCommand('copy');}catch(e){} document.body.removeChild(t); }
  var q=document.getElementById('q'), fs=document.getElementById('fs'), ft=document.getElementById('ft'), shown=document.getElementById('shown');
  var rows=[].slice.call(document.querySelectorAll('#all > details.case'));
  function apply(){
    var text=q.value.trim().toLowerCase(), s=fs.value, t=ft.value, n=0;
    rows.forEach(function(r){ var ok=(!s||r.dataset.status===s)&&(!t||r.dataset.tech===t)&&(!text||r.dataset.text.indexOf(text)>=0); r.hidden=!ok; if(ok)n++; });
    shown.textContent = n + ' of ' + rows.length + ' shown';
  }
  [q,fs,ft].forEach(function(el){ el.addEventListener('input', apply); });
  apply();
})();`;

function caseDetail(r, tickets) {
  const c = r.case;
  const text = `${r.operation.operation_id} ${c.field || ''} ${c.rule_id} ${r.reason} ${c.id}`.toLowerCase();
  const out = [];
  out.push(`<details class="case" data-status="${e(r.status)}" data-op="${e(r.operation.operation_id)}" data-tech="${e(c.technique)}" data-text="${e(text)}">`);
  out.push(`  <summary>
    <span class="badge b-${e(r.status)}">${e(r.status)}</span>
    <code>${e(r.operation.method)} ${e(r.operation.path)}</code>
    <span>${e(c.title)}</span>
    <span class="muted">${e(r.reason)}</span>
  </summary>`);
  out.push('  <div class="case-body">\n    <dl class="kv">');
  out.push(`      <dt>Case</dt><dd><code>${e(c.id)}</code> · level ${e(c.level)}</dd>`);
  out.push(`      <dt>Operation</dt><dd><code>${e(r.operation.operation_id)}</code>${r.operation.summary ? ` — ${e(r.operation.summary)}` : ''}</dd>`);
  out.push(`      <dt>Technique</dt><dd>${e(c.technique)} · rule <code>${e(c.rule_id)}</code></dd>`);
  if (c.field) out.push(`      <dt>Field</dt><dd><code>${e(c.field)}</code>${c.value !== null && c.value !== undefined ? ` = <code>${e(c.value)}</code>` : ''}</dd>`);
  out.push(`      <dt>Expected</dt><dd>${e(c.expect)}${c.expect_codes && c.expect_codes.length ? ' ' + e(c.expect_codes.join(', ')) : ''}</dd>`);
  let actual = 'not sent';
  if (r.response) {
    actual = (r.response.status !== null ? e(r.response.status) : 'no response') + (r.response.content_type ? ` · ${e(r.response.content_type)}` : '') + ` · ${roundHalfEven(r.response.elapsed_ms)} ms`;
  }
  out.push(`      <dt>Actual</dt><dd>${actual}</dd>`);
  out.push(`      <dt>Verdict</dt><dd>${e(r.reason)}</dd>`);
  if (r.known_issue) out.push(`      <dt>Known issue</dt><dd><code>${e(r.known_issue)}</code></dd>`);
  for (const f of r.findings) out.push(`      <dt>Finding</dt><dd>${e(f.category)}: ${e(f.message)}</dd>`);
  out.push('    </dl>');
  if (r.request) {
    const reqHeaders = Object.entries(r.request.headers).map(([k, v]) => `${e(k)}: ${e(v)}\n`).join('');
    const reqBody = r.request.body !== null && r.request.body !== undefined ? '\n' + e(prettyBody(r.request.body)) : '';
    let respText;
    if (r.response.status !== null) {
      respText = `HTTP ${e(r.response.status)}\n` + Object.entries(r.response.headers).map(([k, v]) => `${e(k)}: ${e(v)}\n`).join('') + '\n' + e(prettyBody(r.response.body));
    } else {
      respText = e(r.response.error);
    }
    out.push(`    <div class="cols">
      <div>
        <h3>Request (credential masked)</h3>
        <pre>${e(r.request.method)} ${e(r.request.url)}
${reqHeaders}${reqBody}</pre>
      </div>
      <div>
        <h3>Response</h3>
        <pre>${respText}</pre>
      </div>
    </div>
    <h3>Reproduce</h3>
    <div class="tabs" role="tablist">
      <button role="tab" aria-selected="true" data-tab="bash">bash / zsh</button>
      <button role="tab" aria-selected="false" data-tab="ps">PowerShell</button>
      <button class="btn copy" data-copy="curl">Copy curl</button>
      ${c.id in tickets ? '<button class="btn copy" data-copy="ticket">Copy for ticket</button>' : ''}
    </div>
    <pre data-pane="bash">${eo(r.curl_bash)}</pre>
    <pre data-pane="ps" hidden>${eo(r.curl_ps)}</pre>
    ${c.id in tickets ? `<pre data-pane="ticket" hidden>${e(tickets[c.id])}</pre>` : ''}`);
  }
  out.push('  </div>\n</details>');
  return out.join('\n');
}

function matrixRows(entries, statuses, firstCell) {
  return entries.map(([label, c]) => `<tr><td>${firstCell(label)}</td>${statuses.map((s) => `<td class="num ${c[s] ? 's-' + s : ''}">${c[s] || ''}</td>`).join('')}</tr>`).join('\n');
}

export function renderHtmlString(d) {
  const { meta, health, statuses, counts, tickets } = d;
  const filt = meta.filters || {};
  const anyFilter = ['tags', 'paths', 'methods', 'operations'].some((k) => filt[k] && filt[k].length);
  const hdr = statuses.map((s) => `<th class="num">${e(statusLabel(s))}</th>`).join('');
  const detailList = (list) => list.map((r) => caseDetail(r, tickets)).join('\n');
  const html = [];
  html.push(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>API Test Report · ${e(meta.target)} · ${e(meta.run_id)}</title>
<style>
${CSS}
</style>
</head>
<body>
<main>
<header>
  <h1>API test report — ${e(meta.target)}</h1>
  <div class="muted">${e(meta.spec_title)} · spec ${e(meta.spec_version)} · run <code>${e(meta.run_id)}</code></div>
  <div class="panel meta">
    <div><b>Base URL</b>${e(meta.base_url)}</div>
    <div><b>Spec</b>${e(meta.spec_source)}<br><span class="muted">sha256 ${e(String(meta.spec_sha256).slice(0, 16))}…</span></div>
    <div><b>Level / profile</b>${e(meta.level)} / ${e(meta.profile)} · seed ${e(meta.seed)}</div>
    <div><b>Credential</b>${e(meta.credential)}</div>
    <div><b>Started / finished</b>${e(meta.started)}<br>${meta.finished ? e(meta.finished) : '—'}</div>
    <div><b>Requests sent</b>${e(meta.requests_sent)} (incl. setup/teardown)</div>`);
  if (anyFilter) html.push(`    <div><b>Filters</b>${Object.entries(filt).filter(([, v]) => v && v.length).map(([k, v]) => `${e(k)}: ${e(v.join(', '))} `).join('')}</div>`);
  html.push('  </div>');
  if (health.aborted) html.push(`  <div class="banner bad"><b>Run aborted:</b> ${e(health.abort_reason)}</div>`);
  if (health.credential_expired) html.push(`  <div class="banner bad"><b>Credential expired</b> during the run. Operations that need it were stopped; resume with <code>apitest run --resume ${e(meta.run_id)}</code> and a new credential.</div>`);
  html.push('  <div class="tiles">');
  for (const s of statuses) html.push(`    <div class="tile"><div class="n s-${s}">${counts[s]}</div><div class="l">${e(statusLabel(s))}</div></div>`);
  html.push(`  </div>
  <nav class="toc">
    <a href="#defects">1. Defects (${d.defects.length})</a>
    <a href="#auth">2. Auth findings (${d.auth.length})</a>
    <a href="#docs">3. Documentation (${d.doc_findings.length})</a>
    <a href="#cleanup">4. Cleanup problems (${d.cleanup.length})</a>
    <a href="#health">5. Environment health</a>
    <a href="#summary">Summary tables</a>
    <a href="#cases">All cases (${d.total})</a>
  </nav>
</header>

<h2 id="defects">1. Defects</h2>`);
  html.push(d.defects.length ? detailList(d.defects) : '<p class="empty">No defects.</p>');
  if (d.warnings.length) html.push(`<h3>Warnings (${d.warnings.length})</h3>`, detailList(d.warnings));

  html.push('\n<h2 id="auth">2. Auth findings</h2>');
  html.push(d.auth.length ? detailList(d.auth) : '<p class="empty">No auth findings.</p>');
  const noCred = Object.entries(d.no_credential);
  if (noCred.length) {
    html.push('<h3>Skipped because no credential was given</h3>\n<div class="tablewrap"><table><tr><th>Operation</th><th class="num">Cases skipped</th></tr>');
    html.push(noCred.map(([op, n]) => `<tr><td><code>${e(op)}</code></td><td class="num">${n}</td></tr>`).join(''));
    html.push('</table></div>');
  }

  html.push('\n<h2 id="docs">3. Documentation findings</h2>');
  if (d.doc_findings.length) {
    html.push('<div class="tablewrap"><table>\n<tr><th>Kind</th><th>Finding</th><th>Operations</th></tr>');
    for (const f of d.doc_findings) {
      const ops = f.operations || [];
      const opsCell = ops.length ? `<code>${e(ops.slice(0, 8).join(', '))}</code>${ops.length > 8 ? ` … +${ops.length - 8}` : ''}` : '';
      html.push(`<tr><td>${e(f.kind)}</td><td>${e(f.message)}</td><td>${opsCell}</td></tr>`);
    }
    html.push('</table></div>');
  } else html.push('<p class="empty">No documentation findings.</p>');

  html.push(`\n<h2 id="cleanup">4. Cleanup problems</h2>\n<p class="muted">${e(d.created_resources)} resource(s) created by this run.</p>`);
  if (d.cleanup.length) {
    for (const c of d.cleanup) {
      html.push(`  <div class="panel" style="margin:6px 0"><b>${e(c.kind)} ${e(c.resource_id)}</b>: ${e(c.message)}
  ${c.curl_bash ? `<pre>${e(c.curl_bash)}</pre>` : ''}</div>`);
    }
  } else html.push('<p class="empty">Everything this run created was deleted and verified gone.</p>');

  html.push(`\n<h2 id="health">5. Environment health</h2>
<div class="panel"><dl class="kv">
  <dt>Baselines</dt><dd>${e(health.baselines_ok ?? 0)} ok of ${e(health.baselines_run ?? 0)} run</dd>
  <dt>Server errors</dt><dd>${e(health.server_errors ?? 0)}</dd>
  <dt>Timeouts</dt><dd>${e(health.timeouts ?? 0)}</dd>
  <dt>Network errors</dt><dd>${e(health.network_errors ?? 0)}</dd>
  <dt>Aborted</dt><dd>${health.aborted ? 'yes — ' + e(health.abort_reason) : 'no'}</dd>
  <dt>Credential</dt><dd>${health.credential_expired ? 'expired during run' : 'ok'}</dd>
  ${(health.notes || []).map((n) => `<dt>Note</dt><dd>${e(n)}</dd>`).join('')}
</dl></div>

<h2 id="summary">Summary</h2>
<h3>By tag</h3>
<div class="tablewrap"><table>
<tr><th>Tag</th>${hdr}</tr>
${matrixRows(Object.entries(d.matrix_tag), statuses, e)}
</table></div>
<h3>By technique</h3>
<div class="tablewrap"><table>
<tr><th>Technique</th>${hdr}</tr>
${matrixRows(Object.entries(d.matrix_tech), statuses, e)}
</table></div>
<h3>By operation</h3>
<div class="tablewrap"><table>
<tr><th>Operation</th>${hdr}</tr>
${d.matrix_op.map((row) => `<tr><td><code>${e(row.op.method)} ${e(row.op.path)}</code><br><span class="muted">${e(row.op.operation_id)}</span></td>${statuses.map((s) => `<td class="num ${row[s] ? 's-' + s : ''}">${row[s] || ''}</td>`).join('')}</tr>`).join('\n')}
</table></div>

<h2 id="cases">All cases</h2>
<div class="filters">
  <input id="q" type="search" placeholder="Filter by operation, field, rule, case id, reason…">
  <select id="fs"><option value="">all statuses</option>${statuses.map((s) => `<option>${s}</option>`).join('')}</select>
  <select id="ft"><option value="">all techniques</option>${Object.keys(d.matrix_tech).map((t) => `<option>${e(t)}</option>`).join('')}</select>
  <span id="shown" class="muted"></span>
</div>
<div id="all">
${detailList(d.results)}
</div>
</main>
<script>
${SCRIPT}
</script>
</body>
</html>`);
  return html.join('\n');
}

export function renderHtml(runDir, out = null, data = null) {
  const d = data || buildReportData(runDir);
  const file = out || path.join(runDir, 'report.html');
  fs.writeFileSync(file, renderHtmlString(d), 'utf8');
  return file;
}
