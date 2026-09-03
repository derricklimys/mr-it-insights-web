// Sales tab: the web counterpart to the phone app's "Latest Day" and "Range"
// screens - ranked product sales (by revenue or quantity), filterable by
// product group, net-of-refunds toggle, CSV export, tap a row for the full
// transaction list. Same SQL shape as AroniumDbReader.getTopProducts() on
// Android, ported here since it's the one report that never made it to web -
// the web "Reports" tab is a different thing (margin/cost-trend from
// invoices, not day-to-day sales).

const Sales = {
  loaded: false,
  groups: [],
  lastDataDate: null,

  // Shared across Latest Day and Range, same as Android's FilterState -
  // picking "just MEMORY" in one place should carry over to the other.
  filter: { groupId: null, rankBy: "revenue", netOfRefunds: true },
  rangePreset: "7",
  customStart: null,
  customEnd: null,

  async ensureLoaded() {
    if (this.loaded) return;
    await Reports.ensureLoaded();
    this.groups = Reports.query("SELECT Id, Name FROM ProductGroup ORDER BY Name");
    const row = Reports.query("SELECT date(MAX(Date)) as d FROM Document")[0];
    this.lastDataDate = row ? row.d : null;
    this.loaded = true;
  },

  orderColumn() {
    const { rankBy, netOfRefunds } = this.filter;
    if (netOfRefunds) return rankBy === "revenue" ? "NetRevenue" : "NetQty";
    return rankBy === "revenue" ? "GrossRevenue" : "GrossQty";
  },

  topProducts(startDate, endDate) {
    const groupId = this.filter.groupId;
    const groupClause = groupId ? "AND p.ProductGroupId = ?" : "";
    const sql = `
      WITH sales AS (
        SELECT p.Id AS ProductId, p.Name AS ProductName, p.ProductGroupId AS GroupId, pg.Name AS GroupName,
               (SELECT GROUP_CONCAT(b.Value, ', ') FROM Barcode b WHERE b.ProductId = p.Id) AS Barcodes,
               SUM(di.Quantity) AS Qty, SUM(di.Total) AS Revenue
        FROM DocumentItem di
        JOIN Document d ON d.Id = di.DocumentId
        JOIN Product p ON p.Id = di.ProductId
        LEFT JOIN ProductGroup pg ON pg.Id = p.ProductGroupId
        WHERE d.DocumentTypeId = 2 AND date(d.Date) BETWEEN date(?) AND date(?) ${groupClause}
        GROUP BY p.Id
      ),
      refunds AS (
        SELECT p.Id AS ProductId, SUM(di.Quantity) AS Qty, SUM(di.Total) AS Revenue
        FROM DocumentItem di
        JOIN Document d ON d.Id = di.DocumentId
        JOIN Product p ON p.Id = di.ProductId
        WHERE d.DocumentTypeId = 4 AND date(d.Date) BETWEEN date(?) AND date(?) ${groupClause}
        GROUP BY p.Id
      )
      SELECT s.ProductId, s.ProductName, s.GroupId, s.GroupName, s.Barcodes,
             s.Qty AS GrossQty, s.Revenue AS GrossRevenue,
             s.Qty - COALESCE(r.Qty, 0) AS NetQty,
             s.Revenue - COALESCE(r.Revenue, 0) AS NetRevenue
      FROM sales s
      LEFT JOIN refunds r ON r.ProductId = s.ProductId
      ORDER BY ${this.orderColumn()} DESC
    `;
    const params = [startDate, endDate];
    if (groupId) params.push(groupId);
    params.push(startDate, endDate);
    if (groupId) params.push(groupId);
    return Reports.query(sql, params);
  },

  productTransactions(productId, startDate, endDate) {
    return Reports.query(
      `SELECT date(d.Date) as Date, d.Number as DocNumber, d.DocumentTypeId as DocType,
              di.Quantity as Quantity, di.Price as UnitPrice, di.Total as Total
       FROM DocumentItem di JOIN Document d ON d.Id = di.DocumentId
       WHERE di.ProductId = ? AND d.DocumentTypeId IN (2, 4) AND date(d.Date) BETWEEN date(?) AND date(?)
       ORDER BY d.Date DESC, d.Id DESC`,
      [productId, startDate, endDate],
    );
  },

  async renderLatestDay() {
    await this.ensureLoaded();
    const el = document.getElementById("sales-latestday");
    if (!this.lastDataDate) {
      el.innerHTML = `<p class="empty-state">No sales recorded in this database yet.</p>`;
      return;
    }
    this._renderBody(el, this.lastDataDate, this.lastDataDate, () => this.renderLatestDay(), {
      dateLabel: `Showing ${formatDateLong(this.lastDataDate)}`,
    });
  },

  async renderRange() {
    await this.ensureLoaded();
    const el = document.getElementById("sales-range");
    const { start, end } = this._currentRange();
    this._renderBody(el, start, end, () => this.renderRange(), { showPresets: true });
  },

  _currentRange() {
    if (this.rangePreset === "custom") {
      const today = todayStr();
      return { start: this.customStart || addDays(today, -6), end: this.customEnd || today };
    }
    return lastNDays(Number(this.rangePreset));
  },

  _renderBody(el, start, end, onChange, { dateLabel, showPresets } = {}) {
    const rows = this.topProducts(start, end);
    const f = this.filter;
    const groupOptions = [`<option value="">All products</option>`]
      .concat(this.groups.map((g) => `<option value="${g.Id}" ${f.groupId === g.Id ? "selected" : ""}>${escapeHtml(g.Name)}</option>`))
      .join("");

    el.innerHTML = `
      ${showPresets ? this._presetHtml(start, end) : ""}
      ${dateLabel ? `<p class="report-status">${dateLabel}</p>` : ""}
      <div class="sales-controls">
        <div class="chip-row">
          <button class="chip-btn ${f.rankBy === "revenue" ? "active" : ""}" data-rankby="revenue">Revenue</button>
          <button class="chip-btn ${f.rankBy === "qty" ? "active" : ""}" data-rankby="qty">Quantity</button>
        </div>
        <label class="sales-checkbox"><input type="checkbox" data-net ${f.netOfRefunds ? "checked" : ""}> Net of refunds</label>
        <select data-group>${groupOptions}</select>
      </div>
      ${this._resultsHtml(rows)}
    `;

    el.querySelectorAll("[data-rankby]").forEach((btn) => {
      btn.addEventListener("click", () => { this.filter.rankBy = btn.dataset.rankby; onChange(); });
    });
    el.querySelector("[data-net]").addEventListener("change", (e) => {
      this.filter.netOfRefunds = e.target.checked;
      onChange();
    });
    el.querySelector("[data-group]").addEventListener("change", (e) => {
      this.filter.groupId = e.target.value ? Number(e.target.value) : null;
      onChange();
    });
    if (showPresets) this._bindPreset(el, onChange);

    const exportBtn = el.querySelector("[data-export]");
    if (exportBtn) exportBtn.addEventListener("click", () => this._exportCsv(rows, start, end));
    el.querySelectorAll("tr[data-id]").forEach((row) => {
      row.addEventListener("click", () => this._showDetail(Number(row.dataset.id), rows, start, end));
    });
  },

  _presetHtml(start, end) {
    const presets = [["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["custom", "Custom"]];
    const chips = presets
      .map(([val, label]) => `<button class="chip-btn ${this.rangePreset === val ? "active" : ""}" data-preset="${val}">${label}</button>`)
      .join("");
    const customInputs = this.rangePreset === "custom"
      ? `<div class="sales-custom-dates">
           <input type="date" data-custom-start value="${this.customStart || start}">
           <span>to</span>
           <input type="date" data-custom-end value="${this.customEnd || end}" max="${todayStr()}">
         </div>`
      : "";
    return `<div class="chip-row sales-preset-row">${chips}</div>${customInputs}<p class="report-status">${start} to ${end}</p>`;
  },

  _bindPreset(el, onChange) {
    el.querySelectorAll("[data-preset]").forEach((btn) => {
      btn.addEventListener("click", () => { this.rangePreset = btn.dataset.preset; onChange(); });
    });
    const startInput = el.querySelector("[data-custom-start]");
    const endInput = el.querySelector("[data-custom-end]");
    if (startInput) startInput.addEventListener("change", (e) => { this.customStart = e.target.value; onChange(); });
    if (endInput) endInput.addEventListener("change", (e) => { this.customEnd = e.target.value; onChange(); });
  },

  _resultsHtml(rows) {
    if (!rows.length) {
      return `<p class="empty-state">No sales in this period${this.filter.groupId ? " for this group" : ""}.</p>`;
    }
    const isRevenue = this.filter.rankBy === "revenue";
    const qtyKey = this.filter.netOfRefunds ? "NetQty" : "GrossQty";
    const revKey = this.filter.netOfRefunds ? "NetRevenue" : "GrossRevenue";
    const total = rows.reduce((s, r) => s + (r[isRevenue ? revKey : qtyKey] || 0), 0);
    const totalText = isRevenue ? `Total revenue: ${money(total)}` : `Total sold: ${total} units`;

    return `
      <div class="sales-summary">
        <strong>${totalText}</strong>
        <button class="btn" data-export>Export CSV</button>
      </div>
      <div class="sales-table-wrap">
        <table class="report-table">
          <thead><tr><th>#</th><th>Product</th><th>Group</th><th>Barcode</th><th>Qty</th><th>Revenue</th></tr></thead>
          <tbody>
            ${rows.map((r, i) => `
              <tr data-id="${r.ProductId}">
                <td>${i + 1}</td>
                <td>${escapeHtml(r.ProductName)}</td>
                <td>${escapeHtml(r.GroupName || "")}</td>
                <td>${escapeHtml(r.Barcodes || "—")}</td>
                <td>${r[qtyKey]}</td>
                <td>${money(r[revKey])}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
    `;
  },

  _exportCsv(rows, start, end) {
    const qtyKey = this.filter.netOfRefunds ? "NetQty" : "GrossQty";
    const revKey = this.filter.netOfRefunds ? "NetRevenue" : "GrossRevenue";
    const lines = ["Product,Barcode,Group,Quantity Sold,Revenue"];
    for (const r of rows) {
      lines.push([
        csvEscape(r.ProductName), csvEscape(r.Barcodes || ""), csvEscape(r.GroupName || ""),
        r[qtyKey], (r[revKey] || 0).toFixed(2),
      ].join(","));
    }
    const groupName = this.filter.groupId ? this.groups.find((g) => g.Id === this.filter.groupId) : null;
    const label = safeFilename(groupName ? groupName.Name : "products");
    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${label}-${start}-to-${end}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  },

  _showDetail(productId, rows, start, end) {
    const product = rows.find((r) => r.ProductId === productId);
    if (!product) return;
    const transactions = this.productTransactions(productId, start, end);
    const netQty = transactions.reduce((s, t) => s + (t.DocType === 4 ? -t.Quantity : t.Quantity), 0);
    const netRevenue = transactions.reduce((s, t) => s + (t.DocType === 4 ? -t.Total : t.Total), 0);

    document.getElementById("sales-detail-body").innerHTML = `
      <div class="detail-header"><h2>${escapeHtml(product.ProductName)}</h2></div>
      ${product.Barcodes ? `<p class="detail-barcode">Barcode: ${escapeHtml(product.Barcodes)}</p>` : ""}
      <p class="report-status">${netQty} units &middot; ${money(netRevenue)} net &middot; ${transactions.length} transaction${transactions.length === 1 ? "" : "s"}</p>
      ${transactions.length ? `
        <table class="report-table">
          <thead><tr><th>Date</th><th>Receipt #</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr></thead>
          <tbody>
            ${transactions.map((t) => `
              <tr class="${t.DocType === 4 ? "sales-refund-row" : ""}">
                <td>${t.Date}${t.DocType === 4 ? " · Refund" : ""}</td>
                <td>${escapeHtml(t.DocNumber || "")}</td>
                <td>${t.Quantity}</td>
                <td>${money(t.UnitPrice)}</td>
                <td>${t.DocType === 4 ? "-" : ""}${money(t.Total)}</td>
              </tr>`).join("")}
          </tbody>
        </table>` : `<p class="empty-state">No transactions in this period.</p>`}
    `;
    document.getElementById("sales-detail-modal").classList.remove("hidden");
  },

  closeDetail() {
    document.getElementById("sales-detail-modal").classList.add("hidden");
  },
};

function todayStr() {
  return localDateStr(new Date());
}
function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function addDays(dateStr, delta) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + delta);
  return localDateStr(d);
}
function lastNDays(n) {
  const end = todayStr();
  return { start: addDays(end, -(n - 1)), end };
}
function formatDateLong(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}
function csvEscape(s) {
  s = String(s ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function safeFilename(s) {
  return (s || "products").replace(/[^A-Za-z0-9 _-]/g, "").trim() || "products";
}
