// ─────────────────────────────────────────────────────────────────────────────
// Space Missions Dashboard — Frontend Application
// Fetches mission data from the backend API on load.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────

let ALL_MISSIONS     = [];   // full dataset from API
let filteredMissions = [];   // current filter result

// ── Boot: fetch data ──────────────────────────────────────────────────────────

async function init() {
  try {
    const res  = await fetch('/api/missions');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ALL_MISSIONS     = await res.json();
    filteredMissions = ALL_MISSIONS;

    populateCompanyDropdown();
    updateHeaderKPIs(ALL_MISSIONS);
    updateSubtitle(ALL_MISSIONS);
    document.getElementById('filterCount').textContent =
      ALL_MISSIONS.length.toLocaleString() + ' records';
    document.getElementById('chatInitMsg').textContent =
      `Session started · ${ALL_MISSIONS.length.toLocaleString()} missions loaded`;

    refreshOverviewCharts();
    renderTable();

    document.getElementById('sa-date').textContent = '↑';
    document.getElementById('th-date').classList.add('sorted');

    document.getElementById('loadingOverlay').style.display = 'none';
  } catch (err) {
    document.getElementById('loadingOverlay').innerHTML =
      `<p style="color:var(--failure)">Failed to load data: ${err.message}</p>
       <p style="font-size:11px;color:var(--text-muted)">Make sure the backend server is running.</p>`;
  }
}

window.addEventListener('load', init);

// ── Header KPIs (live — update with filtered data) ────────────────────────────

function updateHeaderKPIs(missions) {
  const total     = missions.length;
  const successes = missions.filter(m => m.missionStatus === 'Success').length;
  const rate      = total > 0 ? ((successes / total) * 100).toFixed(1) + '%' : '—';
  const orgs      = new Set(missions.map(m => m.company)).size;
  const rockets   = new Set(missions.map(m => m.rocket)).size;

  document.getElementById('kpiMissions').textContent = total.toLocaleString();
  document.getElementById('kpiSuccess').textContent  = rate;
  document.getElementById('kpiOrgs').textContent     = orgs;
  document.getElementById('kpiRockets').textContent  = rockets;
}

function updateSubtitle(missions) {
  const dates = missions.map(m => m.date).filter(Boolean).sort();
  const start = dates[0] ? dates[0].slice(0, 4) : '?';
  const end   = dates[dates.length - 1] ? dates[dates.length - 1].slice(0, 4) : '?';
  const orgs  = new Set(missions.map(m => m.company)).size;
  document.getElementById('headerSub').textContent =
    `${start} – ${end} · ${missions.length.toLocaleString()} LAUNCHES · ${orgs} ORGANIZATIONS`;
}

// ── Company dropdown (built from data) ────────────────────────────────────────

function populateCompanyDropdown() {
  const companies = [...new Set(ALL_MISSIONS.map(m => m.company))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const sel = document.getElementById('fCompany');
  companies.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    sel.appendChild(opt);
  });
}

// ── Filtering ─────────────────────────────────────────────────────────────────

function getFilterValues() {
  return {
    company:      document.getElementById('fCompany').value,
    status:       document.getElementById('fStatus').value,
    rocketStatus: document.getElementById('fRocketStatus').value,
    yearFrom:     parseInt(document.getElementById('fDateFrom').value) || null,
    yearTo:       parseInt(document.getElementById('fDateTo').value)   || null,
  };
}

function applyFilters() {
  const f = getFilterValues();
  filteredMissions = ALL_MISSIONS.filter(m => {
    if (f.company      && m.company      !== f.company)      return false;
    if (f.status       && m.missionStatus !== f.status)       return false;
    if (f.rocketStatus && m.rocketStatus  !== f.rocketStatus) return false;
    if (f.yearFrom     && m.year          <  f.yearFrom)      return false;
    if (f.yearTo       && m.year          >  f.yearTo)        return false;
    return true;
  });

  document.getElementById('filterCount').textContent =
    filteredMissions.length.toLocaleString() + ' records';
  updateHeaderKPIs(filteredMissions);

  tableSearchQuery = '';
  if (document.getElementById('tableSearch'))
    document.getElementById('tableSearch').value = '';
  currentPage = 1;
  renderTable();
  refreshOverviewCharts();
}

function resetFilters() {
  document.getElementById('fCompany').value      = '';
  document.getElementById('fStatus').value       = '';
  document.getElementById('fRocketStatus').value = '';
  document.getElementById('fDateFrom').value     = '';
  document.getElementById('fDateTo').value       = '';
  filteredMissions = ALL_MISSIONS;

  document.getElementById('filterCount').textContent =
    ALL_MISSIONS.length.toLocaleString() + ' records';
  updateHeaderKPIs(ALL_MISSIONS);

  tableSearchQuery = '';
  if (document.getElementById('tableSearch'))
    document.getElementById('tableSearch').value = '';
  currentPage = 1;
  renderTable();
  refreshOverviewCharts();
}

// ── Table ─────────────────────────────────────────────────────────────────────

let currentPage      = 1;
const PAGE_SIZE      = 50;
let sortKey          = 'date';
let sortDir          = 1;
let tableSearchQuery = '';

const TABLE_COLS = ['company','mission','date','rocket','rocketStatus','missionStatus','price'];

function tableSearchFilter(q) {
  tableSearchQuery = q.toLowerCase();
  currentPage = 1;
  renderTable();
}

function sortTable(key) {
  if (sortKey === key) sortDir *= -1;
  else { sortKey = key; sortDir = 1; }
  TABLE_COLS.forEach(k => {
    document.getElementById('sa-' + k).textContent = '';
    document.getElementById('th-' + k).classList.remove('sorted');
  });
  document.getElementById('sa-' + key).textContent = sortDir === 1 ? '↑' : '↓';
  document.getElementById('th-' + key).classList.add('sorted');
  currentPage = 1;
  renderTable();
}

function changePage(delta) {
  currentPage += delta;
  renderTable();
}

function renderTable() {
  let rows = filteredMissions;

  if (tableSearchQuery) {
    rows = rows.filter(m =>
      (m.mission  || '').toLowerCase().includes(tableSearchQuery) ||
      (m.company  || '').toLowerCase().includes(tableSearchQuery) ||
      (m.rocket   || '').toLowerCase().includes(tableSearchQuery) ||
      (m.location || '').toLowerCase().includes(tableSearchQuery)
    );
  }

  rows = [...rows].sort((a, b) => {
    let va = a[sortKey], vb = b[sortKey];
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sortDir;
    return String(va).localeCompare(String(vb)) * sortDir;
  });

  const total  = rows.length;
  const pages  = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (currentPage > pages) currentPage = pages;

  const start    = (currentPage - 1) * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  const statusBadge = s => {
    const map = { 'Success':'success','Failure':'failure','Partial Failure':'partial','Prelaunch Failure':'prelaunch' };
    return `<span class="badge badge-${map[s] || 'failure'}">${s}</span>`;
  };
  const rsBadge = s =>
    `<span class="badge badge-${s === 'Active' ? 'active' : 'retired'}">${s || '—'}</span>`;
  const esc = s => String(s || '—').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  document.getElementById('tableBody').innerHTML = pageRows.map(m => `
    <tr>
      <td title="${esc(m.company)}">${esc(m.company)}</td>
      <td title="${esc(m.mission)}">${esc(m.mission)}</td>
      <td>${esc(m.date)}</td>
      <td title="${esc(m.rocket)}">${esc(m.rocket)}</td>
      <td>${rsBadge(m.rocketStatus)}</td>
      <td>${statusBadge(m.missionStatus)}</td>
      <td>${m.price != null ? '$' + Number(m.price).toFixed(1) + 'M' : '—'}</td>
    </tr>
  `).join('');

  document.getElementById('tableCount').textContent =
    total > 0
      ? `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, total)} of ${total.toLocaleString()}`
      : 'No results';
  document.getElementById('pageInfo').textContent = `Page ${currentPage} of ${pages}`;
  document.getElementById('prevBtn').disabled = currentPage <= 1;
  document.getElementById('nextBtn').disabled = currentPage >= pages;
}

// ── Charts ────────────────────────────────────────────────────────────────────

Chart.defaults.color      = 'rgba(200,215,255,0.45)';
Chart.defaults.font.family = "'JetBrains Mono', monospace";
Chart.defaults.font.size   = 10;

const PALETTE = ['#00dcff','#3d7fff','#a259ff','#00e5a0','#ffb347','#ff4d6d','#7c3aed','#06b6d4','#f43f5e','#8b5cf6'];
const GL       = { color: 'rgba(0,220,255,0.06)', lineWidth: 1 };
const BASE_SCALES = {
  x: { grid: GL, border: { display: false } },
  y: { grid: GL, border: { display: false } },
};

let charts = {};
function mkChart(id, cfg) {
  if (charts[id]) charts[id].destroy();
  const c = document.getElementById(id);
  if (!c) return;
  charts[id] = new Chart(c.getContext('2d'), cfg);
}

function getFilteredAggregates() {
  const ms = filteredMissions;
  const byYear = {}, byYearSuccess = {}, byYearFail = {};
  const byStatus = {}, byCompany = {}, byRocket = {}, byLoc = {};

  for (const m of ms) {
    if (m.year) {
      byYear[m.year]        = (byYear[m.year]        || 0) + 1;
      if (m.missionStatus === 'Success')
        byYearSuccess[m.year] = (byYearSuccess[m.year] || 0) + 1;
      if (m.missionStatus === 'Failure')
        byYearFail[m.year]    = (byYearFail[m.year]    || 0) + 1;
    }
    byStatus[m.missionStatus] = (byStatus[m.missionStatus] || 0) + 1;
    byCompany[m.company]      = (byCompany[m.company]      || 0) + 1;
    byRocket[m.rocket]        = (byRocket[m.rocket]        || 0) + 1;
    const region = (m.location || '').split(',').slice(-1)[0].trim() || 'Unknown';
    byLoc[region]             = (byLoc[region]             || 0) + 1;
  }

  const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);

  const byDecade = {}, byDecadeSuc = {};
  for (const m of ms) {
    if (!m.year) continue;
    const dec = Math.floor(m.year / 10) * 10;
    byDecade[dec]    = (byDecade[dec]    || 0) + 1;
    if (m.missionStatus === 'Success')
      byDecadeSuc[dec] = (byDecadeSuc[dec] || 0) + 1;
  }
  const decades      = Object.keys(byDecade).map(Number).sort((a, b) => a - b);
  const decadeRates  = decades.map(d =>
    byDecade[d] ? Math.round((byDecadeSuc[d] || 0) / byDecade[d] * 1000) / 10 : 0
  );

  const topCompanies = Object.entries(byCompany).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topRockets   = Object.entries(byRocket).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topLocs      = Object.entries(byLoc).sort((a, b) => b[1] - a[1]).slice(0, 8);

  return { years, byYear, byYearSuccess, byYearFail, byStatus, topCompanies, topRockets, topLocs, decades, decadeRates };
}

function refreshOverviewCharts() {
  const agg = getFilteredAggregates();
  const n   = filteredMissions.length;

  document.getElementById('chartYearSub').textContent =
    agg.years.length
      ? `${agg.years[0]}–${agg.years[agg.years.length - 1]} · ${n.toLocaleString()} missions`
      : `${n.toLocaleString()} missions`;

  mkChart('cYear', {
    type: 'line',
    data: {
      labels: agg.years,
      datasets: [
        { label:'Total',   data:agg.years.map(y=>agg.byYear[y]||0),        borderColor:'#00dcff', backgroundColor:'rgba(0,220,255,0.07)', fill:true, tension:0.35, pointRadius:0, borderWidth:2 },
        { label:'Success', data:agg.years.map(y=>agg.byYearSuccess[y]||0), borderColor:'#00e5a0', backgroundColor:'rgba(0,229,160,0.04)', fill:true, tension:0.35, pointRadius:0, borderWidth:1.5 },
        { label:'Failure', data:agg.years.map(y=>agg.byYearFail[y]||0),    borderColor:'#ff4d6d', backgroundColor:'rgba(255,77,109,0.04)', fill:true, tension:0.35, pointRadius:0, borderWidth:1.5 },
      ],
    },
    options: { responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ position:'top', labels:{ boxWidth:8, padding:10 }}, tooltip:{ mode:'index', intersect:false }},
      scales:{ ...BASE_SCALES, x:{ ...BASE_SCALES.x, ticks:{ maxTicksLimit:12 }}},
      interaction:{ mode:'nearest', axis:'x', intersect:false },
    },
  });

  const statusMap  = { 'Success':'#00e5a0','Failure':'#ff4d6d','Partial Failure':'#ffb347','Prelaunch Failure':'#a259ff' };
  const statusKeys = ['Success','Failure','Partial Failure','Prelaunch Failure'];
  mkChart('cStatus', {
    type: 'doughnut',
    data: { labels: statusKeys, datasets: [{ data:statusKeys.map(k=>agg.byStatus[k]||0), backgroundColor:statusKeys.map(k=>statusMap[k]), borderWidth:0, hoverOffset:4 }]},
    options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ position:'bottom', labels:{ boxWidth:8, padding:8 }}}, cutout:'65%' },
  });

  mkChart('cDecade', {
    type: 'bar',
    data: { labels:agg.decades.map(d=>d+'s'), datasets:[{ label:'Success Rate %', data:agg.decadeRates, backgroundColor:agg.decadeRates.map(r=>r>=90?'rgba(0,229,160,0.7)':r>=80?'rgba(255,179,71,0.7)':'rgba(255,77,109,0.7)'), borderRadius:4 }]},
    options: { responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ display:false }, tooltip:{ callbacks:{ label: ctx => ctx.parsed.y+'%' }}},
      scales:{ ...BASE_SCALES, y:{ ...BASE_SCALES.y, max:100, ticks:{ callback: v => v+'%' }}},
    },
  });

  mkChart('cCompany', {
    type: 'bar',
    data: { labels:agg.topCompanies.map(([c])=>c.length>14?c.slice(0,14)+'…':c), datasets:[{ label:'Missions', data:agg.topCompanies.map(([,n])=>n), backgroundColor:PALETTE, borderRadius:3 }]},
    options: { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ display:false }}, scales:{ ...BASE_SCALES, x:{ ...BASE_SCALES.x, ticks:{ maxRotation:30 }}}},
  });

  mkChart('cLocation', {
    type: 'bar',
    data: { labels:agg.topLocs.map(([l])=>l.length>16?l.slice(0,16)+'…':l), datasets:[{ label:'Launches', data:agg.topLocs.map(([,n])=>n), backgroundColor:'rgba(0,229,160,0.65)', borderRadius:3 }]},
    options: { responsive:true, maintainAspectRatio:false, indexAxis:'y', plugins:{ legend:{ display:false }}, scales:{ ...BASE_SCALES }},
  });

  mkChart('cRockets', {
    type: 'bar',
    data: { labels:agg.topRockets.map(([r])=>r.length>18?r.slice(0,18)+'…':r), datasets:[{ label:'Uses', data:agg.topRockets.map(([,n])=>n), backgroundColor:'rgba(61,127,255,0.65)', borderRadius:3 }]},
    options: { responsive:true, maintainAspectRatio:false, indexAxis:'y', plugins:{ legend:{ display:false }}, scales:{ ...BASE_SCALES }},
  });
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

const TAB_IDS = ['overview','table','ai','functions'];

function switchTab(id) {
  TAB_IDS.forEach((t, i) => {
    document.getElementById('tab-' + t).classList.toggle('active', t === id);
    document.querySelectorAll('.tab')[i].classList.toggle('active', t === id);
  });
  if (id === 'table')    setTimeout(renderTable, 10);
  if (id === 'overview') setTimeout(refreshOverviewCharts, 10);
}

// ── Functions API Tab — calls backend endpoints ───────────────────────────────

async function callApi(n) {
  const outEl = document.getElementById('f' + n + '-out');
  outEl.textContent = 'Loading…';
  outEl.className   = 'fn-result empty';

  try {
    let url;
    switch (n) {
      case 1: url = `/api/mission-count?company=${encodeURIComponent(document.getElementById('f1-in').value)}`; break;
      case 2: url = `/api/success-rate?company=${encodeURIComponent(document.getElementById('f2-in').value)}`; break;
      case 3: url = `/api/missions-by-date?start=${encodeURIComponent(document.getElementById('f3-start').value)}&end=${encodeURIComponent(document.getElementById('f3-end').value)}`; break;
      case 4: url = `/api/top-companies?n=${encodeURIComponent(document.getElementById('f4-in').value)}`; break;
      case 5: url = `/api/mission-status-count`; break;
      case 6: url = `/api/missions-by-year?year=${encodeURIComponent(document.getElementById('f6-in').value)}`; break;
      case 7: url = `/api/most-used-rocket`; break;
      case 8: url = `/api/average-missions-per-year?start=${encodeURIComponent(document.getElementById('f8-start').value)}&end=${encodeURIComponent(document.getElementById('f8-end').value)}`; break;
    }

    const res  = await fetch(url);
    const data = await res.json();

    outEl.textContent = typeof data.result === 'object'
      ? JSON.stringify(data.result, null, 2)
      : String(data.result);
    outEl.className = 'fn-result';
  } catch (e) {
    outEl.textContent = 'Error: ' + e.message;
    outEl.className   = 'fn-result';
    outEl.style.color = 'var(--failure)';
  }
}

// ── AI Chat ───────────────────────────────────────────────────────────────────

function buildSystemPrompt() {
  // Build a compact aggregated context from live data so AI answers are accurate
  const byCompany = {};
  const byYear    = {};
  const byStatus  = {};
  const byDecade  = {};

  for (const m of ALL_MISSIONS) {
    byCompany[m.company] = (byCompany[m.company] || { total:0, success:0 });
    byCompany[m.company].total++;
    if (m.missionStatus === 'Success') byCompany[m.company].success++;
    if (m.year) byYear[m.year] = (byYear[m.year] || 0) + 1;
    byStatus[m.missionStatus] = (byStatus[m.missionStatus] || 0) + 1;
    if (m.year) {
      const d = Math.floor(m.year / 10) * 10;
      byDecade[d] = (byDecade[d] || { total:0, success:0 });
      byDecade[d].total++;
      if (m.missionStatus === 'Success') byDecade[d].success++;
    }
  }

  const topCompanies = Object.entries(byCompany)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 20)
    .map(([c, v]) => ({ Company: c, total: v.total, success: v.success }));

  const context = {
    total_missions: ALL_MISSIONS.length,
    total_companies: Object.keys(byCompany).length,
    mission_status: byStatus,
    by_year: Object.entries(byYear).map(([y, t]) => ({ Year: +y, total: t })),
    by_company: topCompanies,
    by_decade: Object.entries(byDecade).map(([d, v]) => ({ Decade: +d, total: v.total, success: v.success })),
  };

  return `You are an expert analyst for a space missions dataset. Aggregated data:
${JSON.stringify(context)}
This covers ${ALL_MISSIONS.length} launches from 1957 to 2022 across ${Object.keys(byCompany).length} organizations.

RULES:
1. Only answer questions about this space missions dataset.
2. Provide clear, insightful analysis.
3. Always include 1-2 chart specs.

Respond ONLY with JSON (no markdown fences):
{
  "answer": "Explanation with **bold** and *italics*.",
  "charts": [
    { "title": "string", "type": "bar|line|doughnut|pie", "labels": [...], "datasets": [{ "label":"", "data":[...] }], "stacked": false }
  ]
}`;
}

let isThinking   = false;
const chatHistory = [];

function autoResize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 90) + 'px'; }
function handleKey(e)   { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }
function sendSug(el)    { document.getElementById('chatInput').value = el.textContent; sendMessage(); }

function addMsg(role, html) {
  const c = document.getElementById('chatMsgs');
  const d = document.createElement('div');
  if (role === 'user')     { d.className = 'msg msg-user'; d.innerHTML = `<div class="bubble">${html}</div>`; }
  else if (role === 'ai')  { d.className = 'msg msg-ai';   d.innerHTML = `<div class="ai-av">✦</div><div class="bubble">${html}</div>`; }
  else if (role === 'thinking') { d.id = 'thinkingMsg'; d.className = 'msg msg-ai'; d.innerHTML = `<div class="ai-av">✦</div><div class="bubble"><div class="thinking-dots"><span></span><span></span><span></span></div></div>`; }
  c.appendChild(d);
  c.scrollTop = 99999;
  return d;
}

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function mdToHtml(s) { return s.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\*(.*?)\*/g,'<em>$1</em>').replace(/\n/g,'<br>'); }

let aiChartInstances = {};
function renderAICharts(chartSpecs) {
  const viz = document.getElementById('aiViz');
  const def = document.getElementById('aiDefaultMsg');
  Object.values(aiChartInstances).forEach(c => c.destroy());
  aiChartInstances = {};
  if (!chartSpecs || !chartSpecs.length) return;
  if (def) def.style.display = 'none';
  viz.querySelectorAll('.ai-chart-card').forEach(e => e.remove());

  chartSpecs.forEach((spec, idx) => {
    const card   = document.createElement('div'); card.className   = 'ai-chart-card';
    const title  = document.createElement('div'); title.className  = 'ai-chart-title'; title.textContent = spec.title || 'Chart';
    const wrap   = document.createElement('div'); wrap.className   = 'ai-chart-wrap';
    const canvas = document.createElement('canvas');
    const cid    = 'aic_' + idx + '_' + Date.now();
    canvas.id = cid;
    wrap.appendChild(canvas); card.appendChild(title); card.appendChild(wrap); viz.appendChild(card);

    setTimeout(() => {
      const ds = (spec.datasets || []).map((d, i) => ({
        ...d,
        backgroundColor: d.backgroundColor || (spec.type === 'line' ? PALETTE[i % PALETTE.length] + '20' : PALETTE[i % PALETTE.length]),
        borderColor:     d.borderColor     || PALETTE[i % PALETTE.length],
        borderRadius: 3, tension: 0.35, pointRadius: spec.type === 'line' ? 0 : undefined,
        borderWidth: spec.type === 'line' ? 2 : 1, fill: spec.type === 'line',
      }));
      aiChartInstances[cid] = new Chart(document.getElementById(cid).getContext('2d'), {
        type: spec.type || 'bar',
        data: { labels: spec.labels, datasets: ds },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend:{ position:'top', labels:{ boxWidth:8, padding:8 }}, tooltip:{ mode:'index', intersect:false }},
          scales: (spec.type === 'doughnut' || spec.type === 'pie') ? undefined : {
            ...BASE_SCALES,
            x: { ...BASE_SCALES.x, stacked: spec.stacked || false },
            y: { ...BASE_SCALES.y, stacked: spec.stacked || false },
          },
          cutout: spec.type === 'doughnut' ? '65%' : undefined,
        },
      });
    }, 50 * (idx + 1));
  });
}

async function sendMessage() {
  if (isThinking) return;
  const input = document.getElementById('chatInput');
  const q = input.value.trim();
  if (!q) return;

  isThinking = true;
  input.value = '';
  input.style.height = 'auto';
  document.getElementById('sendBtn').disabled = true;
  document.getElementById('suggestions').style.display = 'none';

  addMsg('user', escHtml(q));
  const thinking = addMsg('thinking');
  chatHistory.push({ role: 'user', content: q });

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system: buildSystemPrompt(), messages: chatHistory }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(`HTTP ${res.status}: ${errData?.error?.message || res.statusText}`);
    }
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);

    const raw     = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const cleaned = raw.replace(/^```json\s*/, '').replace(/```\s*$/, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (e) {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
      else throw new Error('Unexpected response format');
    }

    thinking.remove();
    addMsg('ai', mdToHtml(parsed.answer || 'Here is what I found.'));
    chatHistory.push({ role: 'assistant', content: raw });
    if (parsed.charts && parsed.charts.length) renderAICharts(parsed.charts);
  } catch (e) {
    thinking.remove();
    addMsg('ai', `<div style="color:var(--failure);font-family:var(--font-mono);font-size:11px;">Error: ${escHtml(e.message)}</div>`);
  }

  isThinking = false;
  document.getElementById('sendBtn').disabled = false;
}
