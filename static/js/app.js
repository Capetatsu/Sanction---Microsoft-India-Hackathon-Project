(() => {
"use strict";

const API = {
  async requests() { const r = await fetch("/api/requests"); return r.json(); },
  async budgets() { const r = await fetch("/api/budgets"); return r.json(); },
  async request(id) { const r = await fetch(`/requests/${id}`); return r.json(); },
  async submit(data) { const r = await fetch("/demo/request", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(data) }); return { status: r.status, data: await r.json() }; },
};

const $ = (s, p) => (p || document).querySelector(s);
const $$ = (s, p) => [...(p || document).querySelectorAll(s)];
const h = (tag, cls, html) => { const el = document.createElement(tag); if (cls) el.className = cls; if (html) el.innerHTML = html; return el; };

const state = { page: "dashboard", requests: [], budgets: [], search: "", tab: "all", calendarDate: new Date(), filterStatus: "", filterCategory: "" };

function fmtAmount(n) { return n != null ? `₹${Number(n).toLocaleString("en-IN")}` : "—"; }
function fmtDate(iso) { if (!iso) return "—"; const d = new Date(iso); return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }
function fmtTime(iso) { if (!iso) return ""; const d = new Date(iso); return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }); }
function fmtRelative(iso) { if (!iso) return ""; const s = Math.floor((Date.now() - new Date(iso)) / 1000); if (s < 60) return "just now"; if (s < 3600) return `${Math.floor(s/60)}m ago`; if (s < 86400) return `${Math.floor(s/3600)}h ago`; return fmtDate(iso); }
function statusBadge(s) { const m = {"Auto-Approved":"auto","Pending Approval":"pending","Needs Clarification":"clarification","Approved":"approved","Rejected":"rejected"}; return `<span class="badge badge-${m[s]||"normal"}">${s}</span>`; }
function urgencyBadge(u) { return `<span class="badge badge-${u==="urgent"?"urgent":"normal"}">${u||"normal"}</span>`; }

function sidebar() {
  $$(".nav-item").forEach(a => {
    a.classList.toggle("active", a.dataset.page === state.page);
  });
}

async function loadData() {
  try {
    const [reqs, buds] = await Promise.all([API.requests(), API.budgets()]);
    state.requests = reqs;
    state.budgets = buds;
  } catch(e) { console.error("loadData:", e); }
}

function renderDashboard() {
  const now = new Date();
  const greet = now.getHours() < 12 ? "Good morning" : now.getHours() < 18 ? "Good afternoon" : "Good evening";
  const pending = state.requests.filter(r => r.decision?.status === "Pending Approval");
  const approved = state.requests.filter(r => r.decision?.status === "Auto-Approved" || r.decision?.status === "Approved");
  const total = state.requests.length;
  const totalBudget = state.budgets.reduce((s,b) => s + (b.cap||0), 0);
  const totalSpent = state.budgets.reduce((s,b) => s + (b.spent||0), 0);
  const recent = [...state.requests].sort((a,b) => new Date(b.incoming?.received_at||0) - new Date(a.incoming?.received_at||0)).slice(0,8);

  let html = `
    <div class="fade-in">
      <div class="mb-24">
        <h2 style="font-size:22px;font-weight:600">${greet}, Mayank</h2>
        <p class="text-muted" style="font-size:14px">Here's what needs your attention today — ${now.toLocaleDateString("en-IN",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}</p>
      </div>
      <div class="kpi-grid">
        <div class="card card-warning"><div class="card-title">Pending Approvals</div><div class="card-value">${pending.length}</div><div class="card-subtitle">awaiting human review</div></div>
        <div class="card card-success"><div class="card-title">Auto-Approved</div><div class="card-value">${approved.length}</div><div class="card-subtitle">processed automatically</div></div>
        <div class="card card-accent"><div class="card-title">Total Requests</div><div class="card-value">${total}</div><div class="card-subtitle">all time</div></div>
        <div class="card"><div class="card-title">Budget Remaining</div><div class="card-value">${fmtAmount(totalBudget - totalSpent)}</div><div class="card-subtitle">across ${state.budgets.length} categories</div></div>
      </div>
      <div class="grid-2 mb-24">
        <div class="section">
          <div class="section-header"><span class="section-title">Needs Your Attention</span><span class="section-subtitle">${pending.length} pending</span></div>
          ${pending.length === 0 ? `<div class="card"><div class="empty-state"><div class="empty-icon">✓</div><div class="empty-title">All clear</div><div class="empty-text">No pending approvals right now</div></div></div>` :
          pending.map(r => `
            <div class="card mb-8" style="cursor:pointer" onclick="window.openRequest('${r.request_id}')">
              <div class="flex items-center justify-between mb-8">
                <span style="font-weight:600;font-size:14px">${r.request_id}</span>
                ${urgencyBadge(r.extracted?.urgency)}
              </div>
              <div class="flex items-center justify-between mb-8">
                <span style="font-size:20px;font-weight:700">${fmtAmount(r.extracted?.amount)}</span>
                <span class="text-muted" style="font-size:12px">${r.extracted?.category||""}</span>
              </div>
              <div class="flex items-center justify-between">
                <span class="text-muted" style="font-size:12px">${r.extracted?.vendor||"Unknown vendor"}</span>
                <span class="text-muted" style="font-size:11px">${fmtRelative(r.incoming?.received_at)}</span>
              </div>
              ${r.decision?.risk_reasons?.length ? `<div class="mt-8" style="font-size:11px;color:var(--warning)">⚠ ${r.decision.risk_reasons[0]}</div>` : ""}
            </div>
          `).join("")}
        </div>
        <div class="section">
          <div class="section-header"><span class="section-title">Budget Overview</span></div>
          ${state.budgets.filter(b => b.cap > 0).map(b => {
            const pct = b.cap ? Math.min((b.spent / b.cap) * 100, 100) : 0;
            const cls = pct > 90 ? "progress-danger" : pct > 70 ? "progress-warn" : "progress-fill";
            return `
              <div class="card mb-8">
                <div class="flex items-center justify-between mb-8">
                  <span style="font-weight:500">${b.category}</span>
                  <span class="text-muted" style="font-size:12px">${fmtAmount(b.spent)} / ${fmtAmount(b.cap)}</span>
                </div>
                <div class="progress"><div class="progress-bar ${cls}" style="width:${pct}%"></div></div>
              </div>`;
          }).join("")}
          <div class="section-header mt-24"><span class="section-title">Recent Activity</span></div>
          <div class="card">
            <div class="activity-list">
              ${recent.map(r => {
                const s = r.decision?.status;
                const dot = s==="Auto-Approved"?"auto":s==="Pending Approval"?"pending":s==="Approved"?"approved":s==="Rejected"?"rejected":s==="Needs Clarification"?"received":"received";
                return `
                  <div class="activity-item" style="cursor:pointer" onclick="window.openRequest('${r.request_id}')">
                    <div class="activity-dot ${dot}"></div>
                    <div class="activity-info">
                      <div class="activity-title">${r.extracted?.vendor||"Unknown"} — ${fmtAmount(r.extracted?.amount)}</div>
                      <div class="activity-sub">${r.request_id} · ${s}</div>
                    </div>
                    <div class="activity-time">${fmtRelative(r.incoming?.received_at)}</div>
                  </div>`;
              }).join("")}
              ${recent.length === 0 ? '<div class="text-muted" style="padding:20px;text-align:center;font-size:13px">No activity yet</div>' : ""}
            </div>
          </div>
        </div>
      </div>
      <div class="flex justify-between items-center">
        <div></div>
        <button class="btn btn-primary" onclick="window.showNewRequest()">+ New Expense Request</button>
      </div>
    </div>`;
  return html;
}

function renderRequests() {
  let filtered = [...state.requests];
  if (state.search) { const q = state.search.toLowerCase(); filtered = filtered.filter(r => r.request_id.toLowerCase().includes(q) || (r.extracted?.vendor||"").toLowerCase().includes(q) || (r.incoming?.requester_name||"").toLowerCase().includes(q)); }
  if (state.filterStatus) filtered = filtered.filter(r => r.decision?.status === state.filterStatus);
  if (state.filterCategory) filtered = filtered.filter(r => r.extracted?.category === state.filterCategory);
  const tabs = ["all","Pending Approval","Auto-Approved","Approved","Rejected","Needs Clarification"];
  const counts = {}; tabs.forEach(t => counts[t] = t === "all" ? state.requests.length : state.requests.filter(r => r.decision?.status === t).length);

  return `
    <div class="fade-in">
      <div class="tabs">
        ${tabs.map(t => `<div class="tab ${state.tab===t?"active":""}" onclick="window.setTab('${t}')">${t==="all"?"All":t} <span class="text-muted">(${counts[t]||0})</span></div>`).join("")}
      </div>
      <div class="filters">
        <div class="filter-group">
          <span class="filter-label">Category:</span>
          <select class="filter" onchange="window.setFilterCategory(this.value)">
            <option value="">All</option>
            ${["Decorations","Printing","Equipment","Food","Travel","Other"].map(c => `<option value="${c}" ${state.filterCategory===c?"selected":""}>${c}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>ID</th><th>Requester</th><th>Vendor</th><th>Amount</th><th>Category</th><th>Status</th><th>Urgency</th><th>Date</th><th></th></tr></thead>
            <tbody>
              ${filtered.length === 0 ? `<tr><td colspan="9"><div class="empty-state"><div class="empty-title">No requests found</div><div class="empty-text">Try adjusting your filters</div></div></td></tr>` :
              filtered.map(r => `
                <tr style="cursor:pointer" onclick="window.openRequest('${r.request_id}')">
                  <td style="font-weight:500">${r.request_id}</td>
                  <td>${r.incoming?.requester_name||"—"}</td>
                  <td>${r.extracted?.vendor||"—"}</td>
                  <td style="font-weight:600">${fmtAmount(r.extracted?.amount)}</td>
                  <td>${r.extracted?.category||"—"}</td>
                  <td>${statusBadge(r.decision?.status)}</td>
                  <td>${urgencyBadge(r.extracted?.urgency)}</td>
                  <td class="text-muted">${fmtDate(r.incoming?.received_at)}</td>
                  <td><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();window.openRequest('${r.request_id}')">View</button></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function renderCalendar() {
  const d = state.calendarDate;
  const year = d.getFullYear(), month = d.getMonth();
  const first = new Date(year, month, 1), last = new Date(year, month+1, 0);
  const startDay = (first.getDay() + 6) % 7;
  const today = new Date();
  const daysInMonth = last.getDate();
  const monthName = d.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const requestsByDate = {};
  state.requests.forEach(r => {
    const dt = r.incoming?.received_at;
    if (dt) { const key = new Date(dt).toISOString().slice(0,10); if (!requestsByDate[key]) requestsByDate[key] = []; requestsByDate[key].push(r); }
  });

  let cells = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d => `<div class="cal-header">${d}</div>`).join("");
  const prevMonth = new Date(year, month, 0);
  for (let i = startDay - 1; i >= 0; i--) {
    const day = prevMonth.getDate() - i;
    cells += `<div class="cal-day other-month"><div class="cal-date">${day}</div></div>`;
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${year}-${String(month+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
    const isToday = today.getFullYear() === year && today.getMonth() === month && today.getDate() === day;
    const reqs = requestsByDate[key] || [];
    cells += `<div class="cal-day ${isToday?"today":""}">
      <div class="cal-date">${day}</div>
      ${reqs.slice(0,3).map(r => {
        const s = r.decision?.status;
        const cls = s==="Auto-Approved"?"auto":s==="Pending Approval"?"pending":"approved";
        return `<div class="cal-event ${cls}" onclick="window.openRequest('${r.request_id}')" title="${r.extracted?.vendor||""} ${fmtAmount(r.extracted?.amount)}">${r.extracted?.vendor||r.request_id} ${fmtAmount(r.extracted?.amount)}</div>`;
      }).join("")}
      ${reqs.length > 3 ? `<div class="text-muted" style="font-size:10px">+${reqs.length-3} more</div>` : ""}
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
        <button class="btn btn-ghost" onclick="window.calNav(-1)">← Prev</button>
        <div class="cal-month">${monthName}</div>
        <button class="btn btn-ghost" onclick="window.calNav(1)">Next →</button>
      </div>
      <div class="cal-grid">${cells}</div>
    </div>`;
}

function renderHistory() {
  const completed = state.requests.filter(r => ["Auto-Approved","Approved","Rejected","Needs Clarification"].includes(r.decision?.status));
  const sorted = [...completed].sort((a,b) => new Date(b.incoming?.received_at||0) - new Date(a.incoming?.received_at||0));

  return `
    <div class="fade-in">
      <div class="card">
        <div class="table-wrap">
          <table>
            <thead><tr><th>ID</th><th>Requester</th><th>Vendor</th><th>Amount</th><th>Category</th><th>Status</th><th>Date</th><th>Decided By</th></tr></thead>
            <tbody>
              ${sorted.length === 0 ? `<tr><td colspan="8"><div class="empty-state"><div class="empty-title">No history yet</div><div class="empty-text">Completed requests will appear here</div></div></td></tr>` :
              sorted.map(r => `
                <tr style="cursor:pointer" onclick="window.openRequest('${r.request_id}')">
                  <td style="font-weight:500">${r.request_id}</td>
                  <td>${r.incoming?.requester_name||"—"}</td>
                  <td>${r.extracted?.vendor||"—"}</td>
                  <td style="font-weight:600">${fmtAmount(r.extracted?.amount)}</td>
                  <td>${r.extracted?.category||"—"}</td>
                  <td>${statusBadge(r.decision?.status)}</td>
                  <td class="text-muted">${fmtDate(r.incoming?.received_at)}</td>
                  <td class="text-muted">${r.decided_by||"—"}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

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
        <div class="help-text">
          <div class="flex gap-8 items-center mb-8">${statusBadge("Auto-Approved")} <span>Within policy limits — no human needed</span></div>
          <div class="flex gap-8 items-center mb-8">${statusBadge("Pending Approval")} <span>Exceeds a policy threshold — human reviews in Notion</span></div>
          <div class="flex gap-8 items-center mb-8">${statusBadge("Approved")} <span>Human approved in Notion — PDF emailed</span></div>
          <div class="flex gap-8 items-center mb-8">${statusBadge("Rejected")} <span>Human rejected in Notion — no action taken</span></div>
          <div class="flex gap-8 items-center mb-8">${statusBadge("Needs Clarification")} <span>Missing key info (vendor, amount, category) — cannot proceed</span></div>
        </div>
      </div>
      <div class="help-section">
        <div class="help-title">Budget categories</div>
        <div class="help-text">Decorations · Printing · Equipment · Food · Travel · Other — each with configurable caps in the Notion Budgets database.</div>
      </div>
    </div>`;
}

function render() {
  const c = $("#content");
  switch(state.page) {
    case "dashboard": c.innerHTML = renderDashboard(); break;
    case "requests": c.innerHTML = renderRequests(); break;
    case "calendar": c.innerHTML = renderCalendar(); break;
    case "history": c.innerHTML = renderHistory(); break;
    case "help": c.innerHTML = renderHelp(); break;
    default: c.innerHTML = renderDashboard();
  }
  sidebar();
}

function openDrawer(rid) {
  const r = state.requests.find(x => x.request_id === rid);
  if (!r) return;
  const drawer = $("#drawer");
  const title = $("#drawer-title");
  const content = $("#drawer-content");
  title.textContent = r.request_id;
  content.innerHTML = `
    <div class="detail-row"><div class="detail-label">Requester</div><div class="detail-value">${r.incoming?.requester_name||"—"}</div></div>
    <div class="detail-row"><div class="detail-label">Contact</div><div class="detail-value">${r.incoming?.requester_contact||"—"}</div></div>
    <div class="detail-row"><div class="detail-label">Raw Text</div><div class="detail-value" style="white-space:normal;text-align:left;max-width:320px">${r.incoming?.raw_text||"—"}</div></div>
    <div class="detail-row"><div class="detail-label">Vendor</div><div class="detail-value">${r.extracted?.vendor||"—"}</div></div>
    <div class="detail-row"><div class="detail-label">Amount</div><div class="detail-value" style="font-weight:700;font-size:16px">${fmtAmount(r.extracted?.amount)}</div></div>
    <div class="detail-row"><div class="detail-label">Category</div><div class="detail-value">${r.extracted?.category||"—"}</div></div>
    <div class="detail-row"><div class="detail-label">Purpose</div><div class="detail-value" style="white-space:normal;text-align:left;max-width:320px">${r.extracted?.purpose||"—"}</div></div>
    <div class="detail-row"><div class="detail-label">Urgency</div><div class="detail-value">${urgencyBadge(r.extracted?.urgency)}</div></div>
    <div class="detail-row"><div class="detail-label">AI Summary</div><div class="detail-value" style="white-space:normal;text-align:left;max-width:320px;font-size:12px;color:var(--text-muted)">${r.extracted?.ai_summary||"—"}</div></div>
    <div class="detail-row"><div class="detail-label">Status</div><div class="detail-value">${statusBadge(r.decision?.status)}</div></div>
    <div class="detail-row"><div class="detail-label">Risk Reasons</div><div class="detail-value" style="white-space:normal;text-align:left;max-width:320px;font-size:12px;color:var(--warning)">${r.decision?.risk_reasons?.join("; ")||"None"}</div></div>
    ${r.decision?.duplicate_of ? `<div class="detail-row"><div class="detail-label">Duplicate Of</div><div class="detail-value">${r.decision.duplicate_of}</div></div>` : ""}
    <div class="detail-row"><div class="detail-label">Received</div><div class="detail-value">${fmtDate(r.incoming?.received_at)} ${fmtTime(r.incoming?.received_at)}</div></div>
    <div class="detail-row"><div class="detail-label">Decided By</div><div class="detail-value">${r.decided_by||"—"}</div></div>
    <div class="detail-row"><div class="detail-label">Decided At</div><div class="detail-value">${r.decided_at ? fmtDate(r.decided_at)+" "+fmtTime(r.decided_at) : "—"}</div></div>
    <div class="mt-16" style="font-size:11px;color:var(--text-muted)">Human approval for risky requests happens in Notion. This drawer is read-only.</div>`;
  drawer.classList.remove("hidden");
}

function showNewRequest() {
  const modal = $("#modal");
  modal.innerHTML = `
    <div class="modal-header">
      <div class="modal-title">New Expense Request</div>
      <button class="modal-close" onclick="window.hideModal()">&times;</button>
    </div>
    <form id="new-request-form">
      <div class="form-group"><label class="form-label">Your Name</label><input class="form-input" id="req-name" required></div>
      <div class="form-group"><label class="form-label">Contact Email</label><input class="form-input" id="req-contact" type="email" required></div>
      <div class="form-group"><label class="form-label">Expense Details</label><textarea class="form-input" id="req-text" placeholder="Describe what you need, how much, and from whom..." required></textarea></div>
      <div id="req-result" style="display:none;padding:12px;border-radius:var(--radius-md);margin-top:12px;font-size:13px"></div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" onclick="window.hideModal()">Cancel</button>
        <button type="submit" class="btn btn-primary" id="req-submit">Submit Request</button>
      </div>
    </form>`;
  $("#modal-overlay").classList.remove("hidden");
  $("#new-request-form").onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("#req-submit");
    const result = $("#req-result");
    btn.disabled = true; btn.textContent = "Submitting...";
    const payload = { idempotency_key: "dash-" + crypto.randomUUID(), requester_name: $("#req-name").value.trim(), requester_contact: $("#req-contact").value.trim(), raw_text: $("#req-text").value.trim() };
    const { status, data } = await API.submit(payload);
    result.style.display = "block";
    if (status === 200) {
      result.style.background = "var(--success-bg)"; result.style.color = "var(--success)";
      result.textContent = `${data.status} — ${data.request_id}${data.risk_reasons?.length ? " — " + data.risk_reasons.join("; ") : ""}`;
      await loadData();
    } else {
      result.style.background = "var(--error-bg)"; result.style.color = "var(--error)";
      result.textContent = data.detail || "Request failed";
    }
    btn.disabled = false; btn.textContent = "Submit Request";
  };
}

function hideModal() { $("#modal-overlay").classList.add("hidden"); }

window.openRequest = openDrawer;
window.showNewRequest = showNewRequest;
window.hideModal = hideModal;
window.setTab = (t) => { state.tab = t; state.filterStatus = t === "all" ? "" : t; render(); };
window.setFilterCategory = (v) => { state.filterCategory = v; render(); };
window.calNav = (dir) => { state.calendarDate = new Date(state.calendarDate.getFullYear(), state.calendarDate.getMonth() + dir, 1); render(); };

function navigate(page) { state.page = page; render(); }

function init() {
  window.addEventListener("hashchange", () => { const p = location.hash.slice(1) || "dashboard"; navigate(p); });
  $("#drawer-close").addEventListener("click", () => $("#drawer").classList.add("hidden"));
  $("#modal-overlay").addEventListener("click", (e) => { if (e.target === e.currentTarget) hideModal(); });
  $("#global-search").addEventListener("input", (e) => { state.search = e.target.value; if (state.page === "requests") render(); });
  loadData().then(() => { navigate(location.hash.slice(1) || "dashboard"); });
  setInterval(loadData, 30000);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
