(() => {
"use strict";

/* ═══════════════════════════════════════════════════════════════
   API LAYER
   ═══════════════════════════════════════════════════════════════ */
const API = {
  async requests() { const r = await fetch("/api/requests"); return r.json(); },
  async budgets() { const r = await fetch("/api/budgets"); return r.json(); },
  async runlog() { const r = await fetch("/api/runlog"); return r.json(); },
  async request(id) { const r = await fetch(`/requests/${id}`); return r.json(); },
  async submit(data) { const r = await fetch("/demo/request", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(data) }); return { status: r.status, data: await r.json() }; },
};

/* ═══════════════════════════════════════════════════════════════
   UTILITIES
   ═══════════════════════════════════════════════════════════════ */
const $ = (s, p) => (p || document).querySelector(s);
const $$ = (s, p) => [...(p || document).querySelectorAll(s)];
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

const INR = (n) => n != null ? `₹${Number(n).toLocaleString("en-IN")}` : "—";
const pct = (a, b) => b ? Math.round((a / b) * 100) : 0;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}
function fmtTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}
function fmtRelative(iso) {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return fmtDate(iso);
}
function fmtDay(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}

const STATUS_COLORS = { "Auto-Approved":"auto","Pending Approval":"pending","Approved":"approved","Rejected":"rejected","Needs Clarification":"clarification" };
const STATUS_BADGE = (s) => `<span class="badge badge-${STATUS_COLORS[s]||"normal"}">${s}</span>`;
const URGENCY_BADGE = (u) => u === "urgent" ? `<span class="badge badge-urgent">urgent</span>` : "";
const BADGE_DOT = (s) => `<span class="activity-dot ${STATUS_COLORS[s]||"received"}"></span>`;

/* ═══════════════════════════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════════════════════════ */
const S = {
  page: "dashboard",
  requests: [],
  budgets: [],
  runlog: [],
  search: "",
  filterStatus: "",
  filterCategory: "",
  filterDateFrom: "",
  filterDateTo: "",
  filterAmountMin: "",
  filterAmountMax: "",
  calendarDate: new Date(),
  calView: "month",
  budgetSort: "remaining",
  chartRange: "30D",
  reportsPeriod: "month",
  tab: "all",
};

/* ═══════════════════════════════════════════════════════════════
   CHART HELPERS — SVG-based, no library
   ═══════════════════════════════════════════════════════════════ */
function svgTag(w, h, vb, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb || `0 0 ${w} ${h}`}" width="${w}" height="${h}">${inner}</svg>`;
}

function lineChart(data, { w = 600, h = 200, pad = 30, colors = {}, showArea = true, showDots = true, gridLines = 4 } = {}) {
  if (!data || data.length === 0) {
    return `<div class="empty-state" style="padding:32px"><div class="empty-icon">📊</div><div class="empty-title">No data yet</div><div class="empty-text">Request data will appear here as requests come in.</div></div>`;
  }
  const series = data.series || [];
  const labels = data.labels || [];
  if (!series.length || !labels.length) {
    return `<div class="empty-state" style="padding:32px"><div class="empty-icon">📊</div><div class="empty-title">No data yet</div></div>`;
  }
  const allVals = series.flatMap(s => s.values);
  const maxVal = Math.max(...allVals, 1);
  const minVal = 0;
  const range = maxVal - minVal || 1;
  const pw = (w - pad * 2) / Math.max(labels.length - 1, 1);
  const ph = h - pad * 2;

  let gridSvg = "";
  for (let i = 0; i <= gridLines; i++) {
    const y = pad + (ph / gridLines) * i;
    const val = Math.round(maxVal - (range / gridLines) * i);
    gridSvg += `<line x1="${pad}" y1="${y}" x2="${w-pad}" y2="${y}" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>`;
    gridSvg += `<text x="${pad-6}" y="${y+4}" text-anchor="end" fill="#4B5563" font-size="10" font-family="Inter,sans-serif">${val}</text>`;
  }
  let labelSvg = "";
  const step = Math.max(1, Math.floor(labels.length / 6));
  for (let i = 0; i < labels.length; i += step) {
    const x = pad + i * pw;
    labelSvg += `<text x="${x}" y="${h-6}" text-anchor="middle" fill="#4B5563" font-size="10" font-family="Inter,sans-serif">${labels[i]}</text>`;
  }

  let pathsSvg = "";
  const defaultColors = ["#6366F1","#22C55E","#F59E0B","#EF4444","#3B82F6","#A855F7"];
  series.forEach((s, si) => {
    const color = s.color || colors[s.name] || defaultColors[si % defaultColors.length];
    const pts = s.values.map((v, i) => {
      const x = pad + i * pw;
      const y = pad + ph - ((v - minVal) / range) * ph;
      return `${x},${y}`;
    });
    const pathD = "M" + pts.join(" L");
    if (showArea) {
      const first = pts[0].split(",")[0];
      const last = pts[pts.length-1].split(",")[0];
      pathsSvg += `<path d="${pathD} L${last},${pad+ph} L${first},${pad+ph} Z" fill="${color}" fill-opacity="0.08"/>`;
    }
    pathsSvg += `<path d="${pathD}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    if (showDots) {
      pts.forEach(p => {
        const [x, y] = p.split(",");
        pathsSvg += `<circle cx="${x}" cy="${y}" r="3" fill="${color}" stroke="#12161C" stroke-width="2"/>`;
      });
    }
  });

  return `<div class="chart-container"><svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">${gridSvg}${labelSvg}${pathsSvg}</svg></div>`;
}

function barChart(data, { w = 400, h = 200, pad = 30, color = "#6366F1", horizontal = false } = {}) {
  if (!data || !data.length) {
    return `<div class="empty-state" style="padding:32px"><div class="empty-icon">📊</div><div class="empty-title">No data</div></div>`;
  }
  const maxVal = Math.max(...data.map(d => d.value), 1);
  if (horizontal) {
    const barH = 24;
    const gap = 8;
    const totalH = data.length * (barH + gap);
    const labelW = 80;
    const chartW = w - labelW - pad;
    let svg = "";
    data.forEach((d, i) => {
      const y = i * (barH + gap);
      const bw = (d.value / maxVal) * chartW;
      svg += `<text x="${labelW-6}" y="${y+barH/2+4}" text-anchor="end" fill="#A0A8B6" font-size="11" font-family="Inter,sans-serif">${d.label}</text>`;
      svg += `<rect x="${labelW}" y="${y}" width="${chartW}" height="${barH}" rx="4" fill="rgba(255,255,255,0.03)"/>`;
      svg += `<rect x="${labelW}" y="${y}" width="${Math.max(bw,2)}" height="${barH}" rx="4" fill="${d.color||color}" opacity="0.85"/>`;
      svg += `<text x="${labelW+bw+8}" y="${y+barH/2+4}" fill="#A0A8B6" font-size="11" font-family="Inter,sans-serif">${d.display||d.value}</text>`;
    });
    return `<svg viewBox="0 0 ${w} ${totalH}" style="width:100%;height:auto">${svg}</svg>`;
  }
  const barW = Math.min(40, (w - pad*2) / data.length - 6);
  const chartH = h - pad * 2;
  let svg = "";
  svg += `<line x1="${pad}" y1="${pad}" x2="${w-pad}" y2="${pad}" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>`;
  data.forEach((d, i) => {
    const x = pad + i * ((w - pad*2) / data.length) + ((w - pad*2) / data.length - barW) / 2;
    const bh = (d.value / maxVal) * chartH;
    const y = pad + chartH - bh;
    svg += `<rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="3" fill="${d.color||color}" opacity="0.85"/>`;
    svg += `<text x="${x+barW/2}" y="${h-8}" text-anchor="middle" fill="#4B5563" font-size="9" font-family="Inter,sans-serif">${d.label}</text>`;
    if (d.value > 0) svg += `<text x="${x+barW/2}" y="${y-6}" text-anchor="middle" fill="#A0A8B6" font-size="9" font-family="Inter,sans-serif">${d.display||d.value}</text>`;
  });
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto">${svg}</svg>`;
}

function donutChart(data, { size = 180, thickness = 22 } = {}) {
  if (!data || !data.length) {
    return `<div class="empty-state" style="padding:24px"><div class="empty-icon">📊</div><div class="empty-title">No data</div></div>`;
  }
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const r = (size - thickness) / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;
  const cx = size / 2, cy = size / 2;
  let svg = "";
  data.forEach(d => {
    const dash = (d.value / total) * circ;
    svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${d.color}" stroke-width="${thickness}" stroke-dasharray="${dash} ${circ - dash}" stroke-dashoffset="${-offset}" stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})"/>`;
    offset += dash;
  });
  svg += `<text x="${cx}" y="${cy-4}" text-anchor="middle" fill="#F0F2F5" font-size="20" font-weight="700" font-family="Inter,sans-serif">${total}</text>`;
  svg += `<text x="${cx}" y="${cy+14}" text-anchor="middle" fill="#6B7280" font-size="10" font-family="Inter,sans-serif">total</text>`;
  return `<div style="display:flex;align-items:center;gap:20px"><svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${svg}</svg><div class="chart-legend flex flex-col gap-4">${data.map(d => `<div class="chart-legend-item"><span class="chart-legend-dot" style="background:${d.color}"></span>${d.label} <span style="color:var(--text);font-weight:600;margin-left:4px">${d.value}</span></div>`).join("")}</div></div>`;
}

/* ═══════════════════════════════════════════════════════════════
   DATA HELPERS
   ═══════════════════════════════════════════════════════════════ */
function getFilteredRequests() {
  let list = [...S.requests];
  if (S.search) {
    const q = S.search.toLowerCase();
    list = list.filter(r => r.request_id.toLowerCase().includes(q) || (r.extracted?.vendor||"").toLowerCase().includes(q) || (r.incoming?.requester_name||"").toLowerCase().includes(q));
  }
  if (S.filterStatus) list = list.filter(r => r.decision?.status === S.filterStatus);
  if (S.filterCategory) list = list.filter(r => r.extracted?.category === S.filterCategory);
  if (S.filterDateFrom) list = list.filter(r => r.incoming?.received_at >= S.filterDateFrom);
  if (S.filterDateTo) list = list.filter(r => r.incoming?.received_at <= S.filterDateTo + "T23:59:59");
  if (S.filterAmountMin) list = list.filter(r => (r.extracted?.amount||0) >= +S.filterAmountMin);
  if (S.filterAmountMax) list = list.filter(r => (r.extracted?.amount||0) <= +S.filterAmountMax);
  return list;
}

function statusCounts() {
  const c = { total: S.requests.length, pending: 0, auto: 0, approved: 0, rejected: 0, clarification: 0, urgent: 0 };
  S.requests.forEach(r => {
    const s = r.decision?.status;
    if (s === "Pending Approval") c.pending++;
    else if (s === "Auto-Approved") c.auto++;
    else if (s === "Approved") c.approved++;
    else if (s === "Rejected") c.rejected++;
    else if (s === "Needs Clarification") c.clarification++;
    if (r.extracted?.urgency === "urgent") c.urgent++;
  });
  return c;
}

function timeSeriesData(days) {
  const now = new Date();
  const labels = [];
  const approved = [], pending = [], rejected = [], clarification = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    labels.push(d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }));
    let ap = 0, pe = 0, re = 0, cl = 0;
    S.requests.forEach(r => {
      const rd = r.incoming?.received_at?.slice(0, 10);
      if (rd === key) {
        const s = r.decision?.status;
        if (s === "Auto-Approved" || s === "Approved") ap++;
        else if (s === "Pending Approval") pe++;
        else if (s === "Rejected") re++;
        else cl++;
      }
    });
    approved.push(ap); pending.push(pe); rejected.push(re); clarification.push(cl);
  }
  return {
    labels,
    series: [
      { name: "Approved", values: approved, color: "#22C55E" },
      { name: "Pending", values: pending, color: "#F59E0B" },
      { name: "Rejected", values: rejected, color: "#EF4444" },
      { name: "Clarification", values: clarification, color: "#3B82F6" },
    ]
  };
}

function budgetData() {
  const sortFns = {
    remaining: (a, b) => (b.cap - b.spent) - (a.cap - a.spent),
    spent: (a, b) => b.spent - a.spent,
    pct: (a, b) => pct(b.spent, b.cap) - pct(a.spent, a.cap),
    name: (a, b) => a.category.localeCompare(b.category),
  };
  return [...S.budgets].sort(sortFns[S.budgetSort] || sortFns.remaining);
}

function flowCounts() {
  const f = { received: S.requests.length, auto: 0, pending: 0, approved: 0, rejected: 0, sent: 0 };
  S.requests.forEach(r => {
    const s = r.decision?.status;
    if (s === "Auto-Approved") f.auto++;
    else if (s === "Pending Approval") f.pending++;
    else if (s === "Approved") { f.approved++; f.sent++; }
    else if (s === "Rejected") f.rejected++;
    else if (s === "Needs Clarification") f.clarification = (f.clarification||0) + 1;
  });
  return f;
}

/* ═══════════════════════════════════════════════════════════════
   PAGE: DASHBOARD
   ═══════════════════════════════════════════════════════════════ */
function renderDashboard() {
  const now = new Date();
  const greet = now.getHours() < 12 ? "Good morning" : now.getHours() < 18 ? "Good afternoon" : "Good evening";
  const sc = statusCounts();
  const totalBudget = S.budgets.reduce((s, b) => s + (b.cap||0), 0);
  const totalSpent = S.budgets.reduce((s, b) => s + (b.spent||0), 0);
  const recent = [...S.requests].sort((a, b) => new Date(b.incoming?.received_at||0) - new Date(a.incoming?.received_at||0)).slice(0, 8);
  const pending = S.requests.filter(r => r.decision?.status === "Pending Approval").slice(0, 5);
  const ts = timeSeriesData(+S.chartRange.replace("D",""));
  const flow = flowCounts();
  const budgetSortOptions = [["remaining","Highest remaining"],["spent","Highest spending"],["pct","Closest to limit"],["name","A–Z"]];

  return `
  <div class="fade-in">
    <!-- GREETING -->
    <div class="mb-20">
      <h2 style="font-size:22px;font-weight:700;letter-spacing:-0.5px">${greet}, Mayank</h2>
      <p class="text-muted" style="font-size:13px;margin-top:2px">Here's what needs your attention — ${now.toLocaleDateString("en-IN",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}</p>
    </div>

    <!-- KPI ROW -->
    <div class="kpi-grid mb-20">
      <div class="card card-padded kpi-card card-warning">
        <div class="kpi-icon kpi-pending"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg></div>
        <div class="card-value" style="color:var(--warning)">${sc.pending}</div>
        <div class="card-label">Pending Approval</div>
        <div class="card-comparison">${sc.urgent} urgent</div>
      </div>
      <div class="card card-padded kpi-card card-success">
        <div class="kpi-icon kpi-approved"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div>
        <div class="card-value" style="color:var(--success)">${sc.auto + sc.approved}</div>
        <div class="card-label">Auto-Approved</div>
        <div class="card-comparison">${sc.approved} human-approved</div>
      </div>
      <div class="card card-padded kpi-card card-accent">
        <div class="kpi-icon kpi-total"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/></svg></div>
        <div class="card-value">${sc.total}</div>
        <div class="card-label">Total Requests</div>
        <div class="card-comparison">${sc.clarification} need clarification</div>
      </div>
      <div class="card card-padded kpi-card">
        <div class="kpi-icon kpi-budget"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></div>
        <div class="card-value">${INR(totalBudget - totalSpent)}</div>
        <div class="card-label">Budget Remaining</div>
        <div class="card-comparison">across ${S.budgets.length} categories</div>
      </div>
    </div>

    <!-- EXPENSE ACTIVITY CHART -->
    <div class="card mb-20">
      <div class="card-header">
        <div>
          <div class="card-title">Expense Activity</div>
          <div class="card-subtitle">Requests over time</div>
        </div>
        <div class="chart-controls">
          ${["7D","30D","90D"].map(d => `<div class="chart-control ${S.chartRange===d?"active":""}" onclick="window.setChartRange('${d}')">${d}</div>`).join("")}
        </div>
      </div>
      <div class="card-body">
        ${lineChart(ts, { h: 180, pad: 35 })}
        <div class="chart-legend" style="margin-top:8px">
          ${ts.series.map(s => `<div class="chart-legend-item"><span class="chart-legend-dot" style="background:${s.color}"></span>${s.name}</div>`).join("")}
        </div>
      </div>
    </div>

    <div class="grid-2 mb-20">
      <!-- REQUEST FLOW -->
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Request Flow</div>
            <div class="card-subtitle">How requests move through the system</div>
          </div>
        </div>
        <div class="card-body">
          <div class="flow-diagram">
            <div class="flow-node">
              <div class="flow-icon" style="border-color:var(--info);color:var(--info)">📥</div>
              <div class="flow-count">${flow.received}</div>
              <div class="flow-label">Received</div>
            </div>
            <div class="flow-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg></div>
            <div class="flow-node">
              <div class="flow-icon" style="border-color:var(--accent);color:var(--accent)">🤖</div>
              <div class="flow-count">${flow.received}</div>
              <div class="flow-label">AI Processed</div>
            </div>
            <div class="flow-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg></div>
            <div class="flow-node">
              <div class="flow-icon" style="border-color:var(--success);color:var(--success)">✓</div>
              <div class="flow-count">${flow.auto + flow.approved}</div>
              <div class="flow-label">Approved</div>
            </div>
            <div class="flow-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg></div>
            <div class="flow-node">
              <div class="flow-icon" style="border-color:var(--success);color:var(--success)">📄</div>
              <div class="flow-count">${flow.sent}</div>
              <div class="flow-label">Authorized</div>
            </div>
          </div>
        </div>
      </div>

      <!-- STATUS DISTRIBUTION -->
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Status Distribution</div>
            <div class="card-subtitle">All requests by decision</div>
          </div>
        </div>
        <div class="card-body" style="display:flex;justify-content:center">
          ${donutChart([
            { label: "Pending", value: sc.pending, color: "#F59E0B" },
            { label: "Auto-Approved", value: sc.auto, color: "#6366F1" },
            { label: "Human-Approved", value: sc.approved, color: "#22C55E" },
            { label: "Rejected", value: sc.rejected, color: "#EF4444" },
            { label: "Needs Clarification", value: sc.clarification, color: "#3B82F6" },
          ].filter(d => d.value > 0))}
        </div>
      </div>
    </div>

    <div class="grid-2 mb-20">
      <!-- BUDGET OVERVIEW -->
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Budget Overview</div>
            <div class="card-subtitle">Spending across categories</div>
          </div>
          <div class="flex gap-4">
            ${budgetSortOptions.map(([k, v]) => `<div class="chart-control ${S.budgetSort===k?"active":""}" onclick="window.setBudgetSort('${k}')" title="${v}">${k==="remaining"?"Rem":k==="spent"?"Spent":k==="pct"?"%":"A–Z"}</div>`).join("")}
          </div>
        </div>
        <div class="card-body" style="padding:0">
          ${budgetData().map(b => {
            const p = pct(b.spent, b.cap);
            const cls = p > 90 ? "progress-danger" : p > 70 ? "progress-warn" : "progress-fill";
            const rem = b.cap - b.spent;
            return `
            <div class="budget-row">
              <div class="budget-row-header">
                <span class="budget-cat">${b.category}</span>
                <div class="budget-amounts">
                  <span class="budget-spent">${INR(b.spent)}</span>
                  <span class="budget-cap">of ${INR(b.cap)}</span>
                </div>
              </div>
              <div class="budget-bar-row">
                <div class="progress"><div class="progress-bar ${cls}" style="width:${p}%"></div></div>
                <span class="budget-pct">${p}%</span>
              </div>
            </div>`;
          }).join("")}
        </div>
      </div>

      <!-- NEEDS ATTENTION -->
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Needs Your Attention</div>
            <div class="card-subtitle">${pending.length} pending review</div>
          </div>
          ${pending.length > 0 ? `<a href="#requests" class="btn btn-ghost btn-sm" style="font-size:11px">View All</a>` : ""}
        </div>
        <div class="card-body" style="padding:0">
          ${pending.length === 0 ? `
            <div class="empty-state" style="padding:40px">
              <div class="empty-icon" style="background:var(--success-bg);color:var(--success)">✓</div>
              <div class="empty-title">All clear</div>
              <div class="empty-text">No pending approvals right now.</div>
            </div>` :
          pending.map(r => `
            <div class="budget-row" style="cursor:pointer" onclick="window.openRequest('${r.request_id}')">
              <div class="flex items-center justify-between mb-4">
                <div class="flex items-center gap-8">
                  <span style="font-weight:600;font-size:12px;color:var(--text)">${r.request_id}</span>
                  ${URGENCY_BADGE(r.extracted?.urgency)}
                </div>
                <span style="font-size:18px;font-weight:700;color:var(--text)">${INR(r.extracted?.amount)}</span>
              </div>
              <div class="flex items-center justify-between">
                <div>
                  <span style="font-size:12px;color:var(--text-secondary)">${r.extracted?.vendor||"Unknown vendor"}</span>
                  <span style="font-size:11px;color:var(--text-muted);margin-left:6px">· ${r.extracted?.category||""}</span>
                </div>
                <span style="font-size:10px;color:var(--text-dim)">${fmtRelative(r.incoming?.received_at)}</span>
              </div>
              ${r.decision?.risk_reasons?.length ? `<div style="font-size:10px;color:var(--warning);margin-top:4px">⚠ ${r.decision.risk_reasons[0]}</div>` : ""}
            </div>`).join("")}
        </div>
      </div>
    </div>

    <!-- RECENT ACTIVITY -->
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">Recent Activity</div>
          <div class="card-subtitle">Latest request events</div>
        </div>
      </div>
      <div class="card-body" style="padding:0">
        <div class="activity-list">
          ${recent.length === 0 ? `<div class="empty-state" style="padding:32px"><div class="empty-title">No activity yet</div><div class="empty-text">Requests will appear here as they come in.</div></div>` :
          recent.map(r => {
            const s = r.decision?.status;
            const dot = STATUS_COLORS[s] || "received";
            return `
            <div class="activity-item" style="cursor:pointer;padding:10px 20px" onclick="window.openRequest('${r.request_id}')">
              <span class="activity-dot ${dot}"></span>
              <div class="activity-info">
                <div class="activity-title">${r.extracted?.vendor||"Unknown"} — ${INR(r.extracted?.amount)}</div>
                <div class="activity-sub">${r.request_id} · ${r.incoming?.requester_name||""} · ${s}</div>
              </div>
              <div class="activity-time">${fmtRelative(r.incoming?.received_at)}</div>
            </div>`;
          }).join("")}
        </div>
      </div>
    </div>
  </div>`;
}

/* ═══════════════════════════════════════════════════════════════
   PAGE: REQUESTS
   ═══════════════════════════════════════════════════════════════ */
function renderRequests() {
  const filtered = getFilteredRequests();
  const sc = statusCounts();
  const tabs = [
    ["all", "All", sc.total],
    ["Pending Approval", "Pending", sc.pending],
    ["Auto-Approved", "Auto-Approved", sc.auto],
    ["Approved", "Approved", sc.approved],
    ["Rejected", "Rejected", sc.rejected],
    ["Needs Clarification", "Clarification", sc.clarification],
  ];
  const cats = ["Decorations","Printing","Equipment","Food","Travel","Other"];

  const mobileCards = filtered.length === 0
    ? `<div class="empty-state"><div class="empty-title">No requests found</div><div class="empty-text">Try adjusting your filters or submit a new request.</div></div>`
    : filtered.map(r => `
      <div class="mobile-req-card" onclick="window.openRequest('${r.request_id}')">
        <div class="mobile-req-top">
          <span class="mobile-req-id">${r.request_id}</span>
          <span class="mobile-req-amount">${INR(r.extracted?.amount)}</span>
        </div>
        <div class="mobile-req-row">
          <span class="mobile-req-vendor">${r.extracted?.vendor||"—"} · ${r.extracted?.category||""}</span>
          ${STATUS_BADGE(r.decision?.status)}
        </div>
        <div class="mobile-req-row" style="margin-top:4px">
          <span>${r.incoming?.requester_name||"—"}</span>
          <span>${fmtDate(r.incoming?.received_at)}</span>
        </div>
        ${r.decision?.risk_reasons?.length ? `<div class="mobile-req-risk">⚠ ${r.decision.risk_reasons[0]}</div>` : ""}
      </div>`).join("");

  return `
  <div class="fade-in">
    <div class="tabs-scroll">
      ${tabs.map(([k, l, c]) => `<div class="tab ${S.filterStatus===k||(k==="all"&&!S.filterStatus)?"active":""}" onclick="window.setRequestTab('${k==="all"?"":k}')">${l}<span class="tab-count">${c}</span></div>`).join("")}
    </div>
    <div class="filters-scroll">
      <div class="filter-pill ${S.filterCategory?"active":""}" onclick="this.querySelector('select').click()">
        <span>Category</span>
        <select onchange="window.setFilter('category',this.value)" style="background:none;border:none;color:inherit;font-size:inherit;padding:0;width:auto;min-height:auto">
          <option value="">All</option>
          ${cats.map(c => `<option value="${c}" ${S.filterCategory===c?"selected":""}>${c}</option>`).join("")}
        </select>
      </div>
      <div class="filter-pill">
        <span>From</span>
        <input type="date" value="${S.filterDateFrom}" onchange="window.setFilter('dateFrom',this.value)" style="background:none;border:none;color:inherit;font-size:11px;padding:0;width:90px;min-height:auto">
      </div>
      <div class="filter-pill">
        <span>To</span>
        <input type="date" value="${S.filterDateTo}" onchange="window.setFilter('dateTo',this.value)" style="background:none;border:none;color:inherit;font-size:11px;padding:0;width:90px;min-height:auto">
      </div>
      <div class="filter-pill">
        <span>Min ₹</span>
        <input type="number" value="${S.filterAmountMin}" onchange="window.setFilter('amountMin',this.value)" placeholder="0" style="background:none;border:none;color:inherit;font-size:11px;padding:0;width:50px;min-height:auto">
      </div>
      <div class="filter-pill">
        <span>Max ₹</span>
        <input type="number" value="${S.filterAmountMax}" onchange="window.setFilter('amountMax',this.value)" placeholder="∞" style="background:none;border:none;color:inherit;font-size:11px;padding:0;width:50px;min-height:auto">
      </div>
      ${(S.filterStatus||S.filterCategory||S.filterDateFrom||S.filterDateTo||S.filterAmountMin||S.filterAmountMax) ? `<div class="filter-pill" onclick="window.clearFilters()" style="color:var(--error);border-color:var(--error-border)">Clear</div>` : ""}
    </div>
    <!-- Desktop table -->
    <div class="card desktop-table">
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Request</th><th>Requester</th><th>Vendor</th><th>Amount</th><th>Category</th><th>Status</th><th>Urgency</th><th>Date</th><th></th>
          </tr></thead>
          <tbody>
            ${filtered.length === 0 ? `<tr><td colspan="9"><div class="empty-state"><div class="empty-title">No requests found</div><div class="empty-text">Try adjusting your filters or submit a new request.</div></div></td></tr>` :
            filtered.map(r => `
              <tr class="clickable" onclick="window.openRequest('${r.request_id}')">
                <td><span style="font-weight:600;color:var(--text)">${r.request_id}</span></td>
                <td>${r.incoming?.requester_name||"—"}</td>
                <td>${r.extracted?.vendor||"—"}</td>
                <td style="font-weight:600;color:var(--text)">${INR(r.extracted?.amount)}</td>
                <td>${r.extracted?.category||"—"}</td>
                <td>${STATUS_BADGE(r.decision?.status)}</td>
                <td>${URGENCY_BADGE(r.extracted?.urgency)}</td>
                <td class="text-muted">${fmtDate(r.incoming?.received_at)}</td>
                <td><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();window.openRequest('${r.request_id}')">View</button></td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>
    <!-- Mobile cards -->
    <div class="mobile-cards" style="display:none">
      ${mobileCards}
    </div>
  </div>`;
}

/* ═══════════════════════════════════════════════════════════════
   PAGE: CALENDAR
   ═══════════════════════════════════════════════════════════════ */
function renderCalendar() {
  const d = S.calendarDate;
  const year = d.getFullYear(), month = d.getMonth();
  const first = new Date(year, month, 1), last = new Date(year, month+1, 0);
  const startDay = (first.getDay() + 6) % 7;
  const today = new Date();
  const daysInMonth = last.getDate();
  const monthName = d.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const reqsByDate = {};
  S.requests.forEach(r => {
    const dt = r.incoming?.received_at;
    if (dt) { const key = dt.slice(0, 10); if (!reqsByDate[key]) reqsByDate[key] = []; reqsByDate[key].push(r); }
  });

  let cells = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d => `<div class="cal-header">${d}</div>`).join("");
  const prevMonth = new Date(year, month, 0);
  for (let i = startDay - 1; i >= 0; i--) {
    cells += `<div class="cal-day other-month"><div class="cal-date">${prevMonth.getDate() - i}</div></div>`;
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${year}-${String(month+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
    const isToday = today.getFullYear() === year && today.getMonth() === month && today.getDate() === day;
    const reqs = reqsByDate[key] || [];
    cells += `<div class="cal-day ${isToday?"today":""}">
      <div class="cal-date">${day}</div>
      ${reqs.slice(0,3).map(r => {
        const s = r.decision?.status;
        const cls = STATUS_COLORS[s] || "received";
        return `<div class="cal-event ${cls}" onclick="window.openRequest('${r.request_id}')" title="${r.extracted?.vendor||""} ${INR(r.extracted?.amount)}">${r.extracted?.vendor||r.request_id} ${INR(r.extracted?.amount)}</div>`;
      }).join("")}
      ${reqs.length > 3 ? `<div class="text-muted" style="font-size:9px;margin-top:2px">+${reqs.length-3} more</div>` : ""}
    </div>`;
  }
  const totalCells = startDay + daysInMonth;
  const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  for (let i = 1; i <= remaining; i++) {
    cells += `<div class="cal-day other-month"><div class="cal-date">${i}</div></div>`;
  }

  return `
  <div class="fade-in">
    <div class="cal-nav">
      <div class="flex items-center gap-12">
        <button class="btn btn-ghost btn-sm" onclick="window.calNav(-1)">← Prev</button>
        <div class="cal-month">${monthName}</div>
        <button class="btn btn-ghost btn-sm" onclick="window.calNav(1)">Next →</button>
      </div>
      <div class="cal-controls">
        <div class="cal-view-btn active">Month</div>
      </div>
    </div>
    <div class="cal-grid">${cells}</div>
  </div>`;
}

/* ═══════════════════════════════════════════════════════════════
   PAGE: BUDGET
   ═══════════════════════════════════════════════════════════════ */
function renderBudget() {
  const totalBudget = S.budgets.reduce((s, b) => s + (b.cap||0), 0);
  const totalSpent = S.budgets.reduce((s, b) => s + (b.spent||0), 0);
  const totalRemaining = totalBudget - totalSpent;
  const overallPct = pct(totalSpent, totalBudget);
  const data = budgetData();

  return `
  <div class="fade-in">
    <div class="card mb-20">
      <div class="card-padded">
        <div class="flex items-center justify-between mb-16">
          <div>
            <div style="font-size:13px;color:var(--text-muted);font-weight:500;margin-bottom:2px">Budget Overview — Fest 2026</div>
            <div class="flex items-center gap-16" style="margin-top:6px">
              <div><span style="font-size:28px;font-weight:700;color:var(--text)">${INR(totalBudget)}</span><span class="card-label" style="margin-left:4px">allocated</span></div>
              <div><span style="font-size:28px;font-weight:700;color:var(--warning)">${INR(totalSpent)}</span><span class="card-label" style="margin-left:4px">spent</span></div>
              <div><span style="font-size:28px;font-weight:700;color:var(--success)">${INR(totalRemaining)}</span><span class="card-label" style="margin-left:4px">remaining</span></div>
            </div>
          </div>
          <div style="text-align:right">
            <div style="font-size:32px;font-weight:700;color:var(--text)">${100 - overallPct}%</div>
            <div class="card-label">remaining</div>
          </div>
        </div>
        <div class="progress" style="height:8px"><div class="progress-bar ${overallPct > 90 ? "progress-danger" : overallPct > 70 ? "progress-warn" : "progress-fill"}" style="width:${overallPct}%"></div></div>
      </div>
    </div>

    <div class="flex items-center justify-between mb-16">
      <div class="section-title">Categories</div>
      <div class="flex gap-4">
        ${[["remaining","Highest remaining"],["spent","Highest spending"],["pct","Closest to limit"],["name","A–Z"]].map(([k,v]) => `<div class="chart-control ${S.budgetSort===k?"active":""}" onclick="window.setBudgetSort('${k}')">${v}</div>`).join("")}
      </div>
    </div>

    <div class="card">
      ${data.map(b => {
        const p = pct(b.spent, b.cap);
        const cls = p > 90 ? "progress-danger" : p > 70 ? "progress-warn" : "progress-fill";
        const rem = b.cap - b.spent;
        return `
        <div class="budget-row">
          <div class="budget-row-header">
            <span class="budget-cat">${b.category}</span>
            <div class="budget-amounts">
              <span class="budget-spent">${INR(b.spent)} spent</span>
              <span class="budget-cap">of ${INR(b.cap)}</span>
              <span class="budget-remaining ${rem < 0 ? "over" : ""}">${INR(rem)} remaining</span>
            </div>
          </div>
          <div class="budget-bar-row">
            <div class="progress"><div class="progress-bar ${cls}" style="width:${p}%"></div></div>
            <span class="budget-pct">${p}%</span>
          </div>
        </div>`;
      }).join("")}
    </div>
  </div>`;
}

/* ═══════════════════════════════════════════════════════════════
   PAGE: HISTORY
   ═══════════════════════════════════════════════════════════════ */
function renderHistory() {
  const completed = S.requests.filter(r => ["Auto-Approved","Approved","Rejected","Needs Clarification"].includes(r.decision?.status));
  const sorted = [...completed].sort((a, b) => new Date(b.incoming?.received_at||0) - new Date(a.incoming?.received_at||0));

  return `
  <div class="fade-in">
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">Request History</div>
          <div class="card-subtitle">${sorted.length} completed requests</div>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Request</th><th>Requester</th><th>Vendor</th><th>Amount</th><th>Category</th><th>Status</th><th>Date</th><th>Decided By</th>
          </tr></thead>
          <tbody>
            ${sorted.length === 0 ? `<tr><td colspan="8"><div class="empty-state"><div class="empty-title">No history yet</div><div class="empty-text">Completed requests will appear here.</div></div></td></tr>` :
            sorted.map(r => `
              <tr class="clickable" onclick="window.openRequest('${r.request_id}')">
                <td><span style="font-weight:600;color:var(--text)">${r.request_id}</span></td>
                <td>${r.incoming?.requester_name||"—"}</td>
                <td>${r.extracted?.vendor||"—"}</td>
                <td style="font-weight:600;color:var(--text)">${INR(r.extracted?.amount)}</td>
                <td>${r.extracted?.category||"—"}</td>
                <td>${STATUS_BADGE(r.decision?.status)}</td>
                <td class="text-muted">${fmtDate(r.incoming?.received_at)}</td>
                <td class="text-muted">${r.decided_by||"—"}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>
  </div>`;
}

/* ═══════════════════════════════════════════════════════════════
   PAGE: REPORTS
   ═══════════════════════════════════════════════════════════════ */
function renderReports() {
  const sc = statusCounts();
  const cats = {};
  S.requests.forEach(r => {
    const c = r.extracted?.category || "Other";
    if (!cats[c]) cats[c] = { count: 0, total: 0 };
    cats[c].count++;
    cats[c].total += r.extracted?.amount || 0;
  });
  const catData = Object.entries(cats).map(([k, v]) => ({ label: k, value: v.count, display: `${v.count}`, color: undefined })).sort((a, b) => b.value - a.value);
  const catColors = ["#6366F1","#22C55E","#F59E0B","#EF4444","#3B82F6","#A855F7"];
  catData.forEach((d, i) => d.color = catColors[i % catColors.length]);

  const riskReasons = {};
  S.requests.forEach(r => {
    (r.decision?.risk_reasons || []).forEach(reason => {
      const key = reason.length > 40 ? reason.slice(0, 40) + "…" : reason;
      riskReasons[key] = (riskReasons[key] || 0) + 1;
    });
  });
  const riskData = Object.entries(riskReasons).map(([k, v]) => ({ label: k, value: v, display: `${v}` })).sort((a, b) => b.value - a.value).slice(0, 6);

  const avgAmount = S.requests.length ? Math.round(S.requests.reduce((s, r) => s + (r.extracted?.amount || 0), 0) / S.requests.length) : 0;
  const autoRate = S.requests.length ? Math.round(((sc.auto + sc.approved) / S.requests.length) * 100) : 0;
  const humanRate = S.requests.length ? Math.round((sc.pending / S.requests.length) * 100) : 0;

  const periods = [["week","This Week"],["month","This Month"],["quarter","This Quarter"]];
  const periodDays = { week: 7, month: 30, quarter: 90 };
  const pd = periodDays[S.reportsPeriod] || 30;

  const catSpendData = Object.entries(cats).map(([k, v]) => ({ label: k, value: v.total, display: INR(v.total) })).sort((a, b) => b.value - a.value);

  return `
  <div class="fade-in">
    <div class="flex items-center justify-between mb-20">
      <div>
        <div style="font-size:16px;font-weight:600;letter-spacing:-0.3px">Reports</div>
        <div class="text-muted" style="font-size:12px;margin-top:2px">Analytics and insights from your request data</div>
      </div>
      <div class="period-selector">
        ${periods.map(([k, v]) => `<div class="period-btn ${S.reportsPeriod===k?"active":""}" onclick="window.setReportsPeriod('${k}')">${v}</div>`).join("")}
      </div>
    </div>

    <!-- SUMMARY CARDS -->
    <div class="grid-3 mb-20">
      <div class="card card-padded">
        <div class="card-label" style="margin-bottom:8px">Total Requests (${pd}d)</div>
        <div class="card-value">${sc.total}</div>
        <div class="card-comparison">Avg amount: ${INR(avgAmount)}</div>
      </div>
      <div class="card card-padded">
        <div class="card-label" style="margin-bottom:8px">Auto-Approval Rate</div>
        <div class="card-value" style="color:var(--success)">${autoRate}%</div>
        <div class="card-comparison">Human-reviewed: ${humanRate}%</div>
      </div>
      <div class="card card-padded">
        <div class="card-label" style="margin-bottom:8px">Total Spent</div>
        <div class="card-value">${INR(S.budgets.reduce((s,b)=>s+b.spent,0))}</div>
        <div class="card-comparison">of ${INR(S.budgets.reduce((s,b)=>s+b.cap,0))} allocated</div>
      </div>
    </div>

    <div class="grid-2 mb-20">
      <!-- REQUESTS BY CATEGORY -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">Requests by Category</div>
        </div>
        <div class="card-body">
          ${catData.length ? barChart(catData, { w: 500, h: 180, pad: 30, horizontal: true }) : `<div class="empty-state"><div class="empty-title">No data</div></div>`}
        </div>
      </div>

      <!-- STATUS DISTRIBUTION -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">Status Distribution</div>
        </div>
        <div class="card-body" style="display:flex;justify-content:center">
          ${donutChart([
            { label: "Pending", value: sc.pending, color: "#F59E0B" },
            { label: "Auto-Approved", value: sc.auto, color: "#6366F1" },
            { label: "Human-Approved", value: sc.approved, color: "#22C55E" },
            { label: "Rejected", value: sc.rejected, color: "#EF4444" },
            { label: "Clarification", value: sc.clarification, color: "#3B82F6" },
          ].filter(d => d.value > 0))}
        </div>
      </div>
    </div>

    <div class="grid-2 mb-20">
      <!-- SPENDING BY CATEGORY -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">Spending by Category</div>
        </div>
        <div class="card-body">
          ${catSpendData.length ? barChart(catSpendData.map(d => ({...d, color: catColors[catSpendData.indexOf(d) % catColors.length]})), { w: 500, h: 180, pad: 30, horizontal: true }) : `<div class="empty-state"><div class="empty-title">No data</div></div>`}
        </div>
      </div>

      <!-- RISK REASONS -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">Risk Reasons Distribution</div>
        </div>
        <div class="card-body">
          ${riskData.length ? barChart(riskData.map(d => ({...d, color: "#F59E0B"})), { w: 500, h: 180, pad: 30, horizontal: true }) : `<div class="empty-state"><div class="empty-title">No risk reasons yet</div></div>`}
        </div>
      </div>
    </div>

    <!-- ACTIVITY OVER TIME -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">Request Volume Over Time</div>
        <div class="card-subtitle">Last ${pd} days</div>
      </div>
      <div class="card-body">
        ${lineChart(timeSeriesData(pd), { h: 180, pad: 35 })}
        <div class="chart-legend" style="margin-top:8px">
          <div class="chart-legend-item"><span class="chart-legend-dot" style="background:#22C55E"></span>Approved</div>
          <div class="chart-legend-item"><span class="chart-legend-dot" style="background:#F59E0B"></span>Pending</div>
          <div class="chart-legend-item"><span class="chart-legend-dot" style="background:#EF4444"></span>Rejected</div>
          <div class="chart-legend-item"><span class="chart-legend-dot" style="background:#3B82F6"></span>Clarification</div>
        </div>
      </div>
    </div>
  </div>`;
}

/* ═══════════════════════════════════════════════════════════════
   PAGE: HELP
   ═══════════════════════════════════════════════════════════════ */
function renderHelp() {
  return `
  <div class="fade-in" style="max-width:720px">
    <div class="help-section">
      <div class="help-title">What is Sanction?</div>
      <div class="help-text">Sanction is an AI-powered expense approval operations system for college clubs and committees. It understands natural-language requests, applies deterministic policy rules, and automates the safe ones — so a treasurer only needs to review the risky ones.</div>
    </div>

    <div class="help-section">
      <div class="help-title">How it works</div>
      <div class="workflow">
        <div class="workflow-step active"><div class="workflow-dot">1</div><div class="workflow-info"><h4>Request</h4><p>Someone submits a natural-language expense request via the form or webhook</p></div></div>
        <div class="workflow-step active"><div class="workflow-dot">2</div><div class="workflow-info"><h4>AI understands it</h4><p>LLM extracts vendor, amount, category, and purpose into structured fields</p></div></div>
        <div class="workflow-step active"><div class="workflow-dot">3</div><div class="workflow-info"><h4>Policy checks it</h4><p>Deterministic engine evaluates budget, duplicates, thresholds — not the AI</p></div></div>
        <div class="workflow-step active"><div class="workflow-dot">4</div><div class="workflow-info"><h4>Decision</h4><p>Safe → Auto-approved instantly. Risky → Pending human approval in Notion.</p></div></div>
        <div class="workflow-step active"><div class="workflow-dot">5</div><div class="workflow-info"><h4>Action</h4><p>Authorization PDF generated, emailed to accounts, logged in Notion Run Log</p></div></div>
      </div>
    </div>

    <div class="help-section">
      <div class="help-title">Status meanings</div>
      <div class="flex flex-col gap-8">
        <div class="faq-item">
          <div class="faq-q">${STATUS_BADGE("Auto-Approved")}</div>
          <div class="faq-a">Within policy limits — no human needed. The request was safe enough to approve automatically.</div>
        </div>
        <div class="faq-item">
          <div class="faq-q">${STATUS_BADGE("Pending Approval")}</div>
          <div class="faq-a">Exceeds a policy threshold — requires human review. Approval is completed in Notion.</div>
        </div>
        <div class="faq-item">
          <div class="faq-q">${STATUS_BADGE("Approved")}</div>
          <div class="faq-a">Human approved in Notion — authorization PDF has been generated and emailed.</div>
        </div>
        <div class="faq-item">
          <div class="faq-q">${STATUS_BADGE("Rejected")}</div>
          <div class="faq-a">Human rejected in Notion — no action taken. The request will not be processed further.</div>
        </div>
        <div class="faq-item">
          <div class="faq-q">${STATUS_BADGE("Needs Clarification")}</div>
          <div class="faq-a">Missing key info (vendor, amount, category) — cannot proceed without this information.</div>
        </div>
      </div>
    </div>

    <div class="help-section">
      <div class="help-title">Frequently asked questions</div>
      <div class="flex flex-col gap-8">
        <div class="faq-item">
          <div class="faq-q">Why doesn't AI approve requests directly?</div>
          <div class="faq-a">Sanction uses AI only for understanding text. All approval decisions come from deterministic policy rules and human judgment. This ensures consistency and auditability.</div>
        </div>
        <div class="faq-item">
          <div class="faq-q">Why is Notion used?</div>
          <div class="faq-a">Notion serves as the human approval interface. Treasurers review risky requests in a familiar tool, and Sanction automatically resumes when a decision is made.</div>
        </div>
        <div class="faq-item">
          <div class="faq-q">What happens when an API fails?</div>
          <div class="faq-a">Each step fails independently. A Groq extraction failure logs an error and falls back gracefully. A Notion failure is logged but doesn't lose the request data.</div>
        </div>
        <div class="faq-item">
          <div class="faq-q">Budget categories</div>
          <div class="faq-a">Decorations · Printing · Equipment · Food · Travel · Other — each with configurable caps in the Notion Budgets database.</div>
        </div>
      </div>
    </div>
  </div>`;
}

/* ═══════════════════════════════════════════════════════════════
   RENDER ENGINE
   ═══════════════════════════════════════════════════════════════ */
const PAGE_META = {
  dashboard: { title: "Dashboard", subtitle: "Your expense operations at a glance" },
  requests: { title: "Requests", subtitle: "View and filter all expense requests" },
  calendar: { title: "Calendar", subtitle: "Request dates and deadlines" },
  budget: { title: "Budget", subtitle: "Category allocations and spending" },
  history: { title: "History", subtitle: "Completed and resolved requests" },
  reports: { title: "Reports", subtitle: "Analytics and insights" },
  help: { title: "Help", subtitle: "How Sanction works" },
};

function render() {
  const c = $("#content");
  const meta = PAGE_META[S.page] || PAGE_META.dashboard;
  $("#page-title").textContent = meta.title;
  $("#page-subtitle").textContent = meta.subtitle;

  switch (S.page) {
    case "dashboard": c.innerHTML = renderDashboard(); break;
    case "requests": c.innerHTML = renderRequests(); break;
    case "calendar": c.innerHTML = renderCalendar(); break;
    case "budget": c.innerHTML = renderBudget(); break;
    case "history": c.innerHTML = renderHistory(); break;
    case "reports": c.innerHTML = renderReports(); break;
    case "help": c.innerHTML = renderHelp(); break;
    default: c.innerHTML = renderDashboard();
  }

  $$(".nav-item").forEach(a => a.classList.toggle("active", a.dataset.page === S.page));
}

/* ═══════════════════════════════════════════════════════════════
   DRAWER
   ═══════════════════════════════════════════════════════════════ */
function openDrawer(rid) {
  const r = S.requests.find(x => x.request_id === rid);
  if (!r) return;
  const drawer = $("#drawer");
  const title = $("#drawer-title");
  const content = $("#drawer-content");
  title.innerHTML = `<span>${r.request_id}</span> ${STATUS_BADGE(r.decision?.status)}`;
  content.innerHTML = `
    <div class="drawer-section">
      <div class="drawer-section-title">Request</div>
      <div class="detail-row"><div class="detail-label">Requester</div><div class="detail-value">${r.incoming?.requester_name||"—"}</div></div>
      <div class="detail-row"><div class="detail-label">Contact</div><div class="detail-value">${r.incoming?.requester_contact||"—"}</div></div>
      <div class="detail-row"><div class="detail-label">Received</div><div class="detail-value">${fmtDateTime(r.incoming?.received_at)}</div></div>
      <div class="detail-row"><div class="detail-label">Original Text</div><div class="detail-value" style="white-space:normal;text-align:left;max-width:320px;font-size:12px;line-height:1.5">${r.incoming?.raw_text||"—"}</div></div>
    </div>
    <div class="drawer-section">
      <div class="drawer-section-title">AI Summary</div>
      <div style="font-size:12px;color:var(--text-secondary);line-height:1.6">${r.extracted?.ai_summary||"—"}</div>
    </div>
    <div class="drawer-section">
      <div class="drawer-section-title">Financial Details</div>
      <div class="detail-row"><div class="detail-label">Vendor</div><div class="detail-value">${r.extracted?.vendor||"—"}</div></div>
      <div class="detail-row"><div class="detail-label">Amount</div><div class="detail-value" style="font-weight:700;font-size:16px;color:var(--text)">${INR(r.extracted?.amount)}</div></div>
      <div class="detail-row"><div class="detail-label">Category</div><div class="detail-value">${r.extracted?.category||"—"}</div></div>
      <div class="detail-row"><div class="detail-label">Purpose</div><div class="detail-value" style="white-space:normal;text-align:left;max-width:320px">${r.extracted?.purpose||"—"}</div></div>
      <div class="detail-row"><div class="detail-label">Urgency</div><div class="detail-value">${URGENCY_BADGE(r.extracted?.urgency) || "Normal"}</div></div>
    </div>
    <div class="drawer-section">
      <div class="drawer-section-title">Risk Analysis</div>
      <div class="detail-row"><div class="detail-label">Risk Reasons</div><div class="detail-value" style="white-space:normal;text-align:left;max-width:320px;font-size:12px;color:var(--warning);line-height:1.5">${r.decision?.risk_reasons?.length ? r.decision.risk_reasons.join("; ") : "None — within policy"}</div></div>
      ${r.decision?.duplicate_of ? `<div class="detail-row"><div class="detail-label">Duplicate Of</div><div class="detail-value" style="color:var(--warning)">${r.decision.duplicate_of}</div></div>` : ""}
    </div>
    <div class="drawer-section">
      <div class="drawer-section-title">Timeline</div>
      <div class="detail-row"><div class="detail-label">Received</div><div class="detail-value">${fmtDateTime(r.incoming?.received_at)}</div></div>
      <div class="detail-row"><div class="detail-label">AI Processed</div><div class="detail-value">${fmtDateTime(r.incoming?.received_at)}</div></div>
      <div class="detail-row"><div class="detail-label">Decision</div><div class="detail-value">${r.decided_at ? fmtDateTime(r.decided_at) : "—"}</div></div>
      <div class="detail-row"><div class="detail-label">Decided By</div><div class="detail-value">${r.decided_by||"—"}</div></div>
    </div>
    ${r.decision?.status === "Pending Approval" ? `
    <div class="drawer-section" style="background:var(--warning-bg);border:1px solid var(--warning-border);border-radius:var(--radius-md);padding:14px 16px">
      <div style="font-size:13px;font-weight:600;color:var(--warning);margin-bottom:4px">⚠ Human approval required</div>
      <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">This request exceeds policy thresholds. Approval is completed in Notion.</div>
      <a href="https://www.notion.so" target="_blank" class="drawer-notion-btn">Open in Notion</a>
    </div>` : ""}`;
  drawer.classList.add("open");
}

/* ═══════════════════════════════════════════════════════════════
   MODAL — NEW REQUEST
   ═══════════════════════════════════════════════════════════════ */
function showNewRequest() {
  const modal = $("#modal");
  modal.innerHTML = `
    <div class="modal-header">
      <div class="modal-title">New Expense Request</div>
      <button class="modal-close" onclick="window.hideModal()">&times;</button>
    </div>
    <form id="new-request-form">
      <div class="form-group">
        <label class="form-label">Your Name</label>
        <input class="form-input" id="req-name" placeholder="e.g. Mayank" required>
      </div>
      <div class="form-group">
        <label class="form-label">Contact Email</label>
        <input class="form-input" id="req-contact" type="email" placeholder="e.g. mayank@college.edu" required>
      </div>
      <div class="form-group">
        <label class="form-label">Expense Request</label>
        <textarea class="form-input" id="req-text" placeholder="Tell Sanction what you need...&#10;&#10;e.g. I need ₹2,000 from Campus Prints for printing posters for the cultural fest tomorrow." required></textarea>
      </div>
      <div id="req-result" style="display:none"></div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" onclick="window.hideModal()">Cancel</button>
        <button type="submit" class="btn btn-primary btn-lg" id="req-submit">Submit Request</button>
      </div>
    </form>`;
  const overlay = $("#modal-overlay");
  overlay.classList.remove("hidden");
  requestAnimationFrame(() => overlay.classList.add("visible"));

  $("#new-request-form").onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("#req-submit");
    const result = $("#req-result");
    btn.disabled = true;
    btn.textContent = "Processing...";

    const payload = {
      idempotency_key: "dash-" + crypto.randomUUID(),
      requester_name: $("#req-name").value.trim(),
      requester_contact: $("#req-contact").value.trim(),
      raw_text: $("#req-text").value.trim(),
    };

    const { status, data } = await API.submit(payload);
    result.style.display = "block";

    if (status === 200) {
      const s = data.status;
      if (s === "Auto-Approved") {
        result.className = "form-result result-success";
        result.innerHTML = `
          <div style="font-size:15px;font-weight:700;margin-bottom:6px">✓ Automatically approved</div>
          <div style="font-size:20px;font-weight:700;margin-bottom:4px">${INR(data.amount || "—" )}</div>
          <div style="font-size:13px;opacity:0.8">${data.request_id} · Within policy and budget.</div>`;
      } else if (s === "Pending Approval") {
        result.className = "form-result result-warning";
        result.innerHTML = `
          <div style="font-size:15px;font-weight:700;margin-bottom:6px">⚠ Human approval required</div>
          <div style="font-size:13px;margin-bottom:4px">${data.request_id}</div>
          <div style="font-size:12px;opacity:0.8">${(data.risk_reasons||[]).join("; ")}</div>
          <div style="font-size:12px;margin-top:6px;opacity:0.8">Approve this request in Notion.</div>`;
      } else if (s === "Needs Clarification") {
        result.className = "form-result result-info";
        result.innerHTML = `
          <div style="font-size:15px;font-weight:700;margin-bottom:6px">? More information needed</div>
          <div style="font-size:13px;margin-bottom:4px">${data.request_id}</div>
          <div style="font-size:12px;opacity:0.8">${(data.risk_reasons||[]).join("; ")}</div>`;
      } else {
        result.className = "form-result result-info";
        result.innerHTML = `<div style="font-size:13px">${s} — ${data.request_id}</div>`;
      }
      await loadData();
      render();
    } else {
      result.className = "form-result result-error";
      result.innerHTML = `<div style="font-size:15px;font-weight:700;margin-bottom:4px">Something went wrong</div><div style="font-size:12px">${data.detail || "Request failed. Please try again."}</div>`;
    }
    btn.disabled = false;
    btn.textContent = "Submit Request";
  };
}

function hideModal() {
  const overlay = $("#modal-overlay");
  overlay.classList.remove("visible");
  setTimeout(() => overlay.classList.add("hidden"), 200);
}

/* ═══════════════════════════════════════════════════════════════
   GLOBAL HANDLERS
   ═══════════════════════════════════════════════════════════════ */
window.openRequest = openDrawer;
window.showNewRequest = showNewRequest;
window.hideModal = hideModal;
window.setRequestTab = (s) => { S.filterStatus = s; render(); };
window.setFilter = (k, v) => { S["filter" + k.charAt(0).toUpperCase() + k.slice(1)] = v; render(); };
window.clearFilters = () => { S.filterStatus = ""; S.filterCategory = ""; S.filterDateFrom = ""; S.filterDateTo = ""; S.filterAmountMin = ""; S.filterAmountMax = ""; render(); };
window.setChartRange = (r) => { S.chartRange = r; render(); };
window.setBudgetSort = (k) => { S.budgetSort = k; render(); };
window.setReportsPeriod = (p) => { S.reportsPeriod = p; render(); };
window.calNav = (dir) => { S.calendarDate = new Date(S.calendarDate.getFullYear(), S.calendarDate.getMonth() + dir, 1); render(); };

/* ═══════════════════════════════════════════════════════════════
   MOBILE SIDEBAR
   ═══════════════════════════════════════════════════════════════ */
function toggleSidebar() {
  const sidebar = $("#sidebar");
  const overlay = $("#sidebar-overlay");
  const isOpen = sidebar.classList.contains("open");
  if (isOpen) {
    sidebar.classList.remove("open");
    overlay.classList.remove("open");
  } else {
    sidebar.classList.add("open");
    overlay.classList.add("open");
  }
}
function closeSidebar() {
  const sidebar = $("#sidebar");
  const overlay = $("#sidebar-overlay");
  sidebar.classList.remove("open");
  overlay.classList.remove("open");
}
window.toggleSidebar = toggleSidebar;
window.closeSidebar = closeSidebar;

/* ═══════════════════════════════════════════════════════════════
   NAVIGATION
   ═══════════════════════════════════════════════════════════════ */
function navigate(page) {
  S.page = page;
  closeSidebar();
  render();
}

/* ═══════════════════════════════════════════════════════════════
   DATA LOADING
   ═══════════════════════════════════════════════════════════════ */
async function loadData() {
  try {
    const [reqs, buds] = await Promise.all([API.requests(), API.budgets()]);
    S.requests = reqs;
    S.budgets = buds;
  } catch (e) {
    console.error("loadData:", e);
  }
}

/* ═══════════════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════════════ */
function init() {
  // Header date
  const now = new Date();
  const hd = $("#header-date");
  if (hd) hd.textContent = now.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

  // Hash routing
  window.addEventListener("hashchange", () => navigate(location.hash.slice(1) || "dashboard"));

  // Drawer close
  const dc = $("#drawer-close");
  if (dc) dc.addEventListener("click", () => $("#drawer").classList.remove("open"));

  // Modal overlay click
  const mo = $("#modal-overlay");
  if (mo) mo.addEventListener("click", (e) => { if (e.target === e.currentTarget) hideModal(); });

  // Search
  const gs = $("#global-search");
  if (gs) gs.addEventListener("input", (e) => { S.search = e.target.value; if (S.page === "requests") render(); });

  // Close sidebar on nav click (mobile)
  $$(".nav-item").forEach(a => a.addEventListener("click", () => closeSidebar()));

  // Close sidebar on escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeSidebar();
      const drawer = $("#drawer");
      if (drawer && drawer.classList.contains("open")) drawer.classList.remove("open");
    }
  });

  // Load data and render
  loadData().then(() => navigate(location.hash.slice(1) || "dashboard"));

  // Auto-refresh
  setInterval(loadData, 30000);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
