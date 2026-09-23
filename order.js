// Order Memory tab: replaces Derrick manually cross-referencing shop stock,
// reserve stock, and the SanDisk pricelist by eye to decide what to order
// from Convergent. Pulls all three together (stock via Reports/Lookup,
// pricelist via sandisk_price_history.json, sales velocity via a fresh
// query) into one editable table, saves the in-progress order, and exports
// it to an .xlsx in Convergent's own pricelist column shape plus Order Qty.

const ORDER_TRACKED_FILE = "order_memory_tracked.json";
const ORDER_DRAFT_FILE = "order_memory_draft.json";
const ORDER_HISTORY_FILE = "order_memory_history.json";
const ORDER_STATUS_LABELS = { pending: "Pending", ok: "OK", no_stock: "No Stock", lesser_stock: "Lesser Stock" };

function orderStatusClass(status) {
  return status === "ok" ? "order-status-ok"
    : status === "no_stock" ? "order-status-no-stock"
    : status === "lesser_stock" ? "order-status-lesser"
    : "order-status-pending";
}

const Order = {
  loaded: false,
  priceByUpc: null, // Map<upc, {pn, description, dealer_price, srp, remarks, date}>
  pricelistDate: null,
  trackedBarcodes: null, // Set<barcode>
  draftQty: {}, // {barcode: qty}
  orderHistory: [], // [{id, placedDate, lines: [{barcode, pn, name, qtyOrdered, dealerPrice, status}]}]
  lastIssueByBarcode: null, // Map<barcode, {status, placedDate}> - most recent no_stock/lesser_stock flag
  rows: [],

  async ensureLoaded() {
    if (this.loaded) return;
    // Reuses Lookup's own cache (Reports.ensureLoaded() + reserveStock +
    // latestDataDate) rather than loading any of that a second time.
    await Lookup.ensureLoaded();

    const { byUpc, latestDate } = await this._loadLatestPricelist();
    this.priceByUpc = byUpc;
    this.pricelistDate = latestDate;

    this.trackedBarcodes = await this._loadTrackedList();
    this.draftQty = (await this._loadDriveJson(ORDER_DRAFT_FILE)) || {};
    const savedHistory = await this._loadDriveJson(ORDER_HISTORY_FILE);
    this.orderHistory = (savedHistory && Array.isArray(savedHistory.orders)) ? savedHistory.orders : [];
    this._buildLastIssueMap();

    this._buildRows();
    this.loaded = true;
  },

  /** Surfaces "this came back short or empty last time" on the CURRENT
   * list, so it's visible while deciding this round's quantities - not
   * just buried in the history. Only no_stock/lesser_stock count as an
   * issue worth flagging; "ok"/"pending" lines say nothing here. Looks at
   * every past order (not just the latest one) and keeps whichever flagged
   * occurrence is most recent per barcode. */
  _buildLastIssueMap() {
    const map = new Map();
    for (const order of this.orderHistory) {
      for (const line of order.lines || []) {
        if (line.status !== "no_stock" && line.status !== "lesser_stock") continue;
        const existing = map.get(line.barcode);
        if (!existing || order.placedDate > existing.placedDate) {
          map.set(line.barcode, { status: line.status, placedDate: order.placedDate });
        }
      }
    }
    this.lastIssueByBarcode = map;
  },

  /** Only entries whose *last* history date matches the most recent pricelist
   * upload count as "currently offered" - same rule memory.js's New in
   * Pricelist detection already uses, so both features agree on what "in
   * the latest pricelist" means. A PN whose last entry is from an older
   * snapshot has effectively dropped out. */
  async _loadLatestPricelist() {
    const priceHistory = (await this._loadDriveJson("sandisk_price_history.json")) || {};
    const latestDate = Object.values(priceHistory).flat().reduce((max, e) => (e.date > max ? e.date : max), "");
    const byUpc = new Map();
    for (const [pn, entries] of Object.entries(priceHistory)) {
      const last = entries[entries.length - 1];
      if (!last || !last.upc || last.date !== latestDate) continue;
      byUpc.set(last.upc, { pn, ...last });
    }
    return { byUpc, latestDate };
  },

  /** The tracked list is its own source of truth once it exists - never
   * silently re-derived from Aronium/the pricelist after the first load, so
   * a barcode Convergent drops from the pricelist (or Derrick sells through
   * and disables in Aronium) keeps showing until he removes it himself.
   * Seeded exactly once, the first time this file doesn't exist yet - with
   * just what Memory's own signal logic already flags "Stock up" (rising
   * cost + thin stock + healthy margin), not the full ~100+-item Memory
   * catalog. Starting broad would mean removing far more rows than he'd
   * ever add just to get down to what's actually worth ordering - starting
   * from the short, actionable list and adding anything else by barcode
   * (or from the pricelist candidates below) is the easier direction, per
   * Derrick's own framing of the problem. */
  async _loadTrackedList() {
    const saved = await this._loadDriveJson(ORDER_TRACKED_FILE);
    if (saved && Array.isArray(saved.barcodes)) {
      return new Set(saved.barcodes);
    }
    await Memory.ensureLoaded();
    const seeded = new Set(
      Memory.products.filter((p) => p.signal === "stock-up").flatMap((p) => p.barcodes),
    );
    await this._saveTrackedList(seeded);
    return seeded;
  },

  /** Direct "I know the barcode I want" add - faster than scanning the
   * pricelist-candidates table for one specific item, and the only way to
   * re-add something by barcode that isn't in the current pricelist at all
   * (e.g. re-tracking a discontinued item after removing it once). */
  async addByBarcodeFromInput() {
    const input = document.getElementById("order-add-barcode-input");
    const statusEl = document.getElementById("order-add-barcode-status");
    const barcode = input.value.trim();
    if (!barcode) return;
    if (this.trackedBarcodes.has(barcode)) {
      statusEl.textContent = "Already on the list.";
      return;
    }
    const inPricelist = this.priceByUpc.has(barcode);
    const inAronium = !!Lookup.findByBarcode(barcode);
    if (!inPricelist && !inAronium) {
      statusEl.textContent = `No product found for barcode "${barcode}" in Aronium or the current pricelist.`;
      return;
    }
    statusEl.textContent = "";
    input.value = "";
    await this.addBarcode(barcode);
  },

  async _saveTrackedList(set) {
    this.trackedBarcodes = set;
    await this._saveDriveJson(ORDER_TRACKED_FILE, { barcodes: [...set] });
  },

  /** One pass over DocumentItem covering all three windows at once, keyed by
   * product id - avoids a separate query per tracked row. Anchored to the
   * synced DB's own latest date (Lookup.latestDataDate), not the browser's
   * clock, same reasoning as memory.js's "last 30 days". */
  _salesVelocity() {
    const anchor = Lookup.latestDataDate;
    if (!anchor) return {};
    const rows = Reports.query(
      `SELECT di.ProductId as pid,
              SUM(CASE WHEN date(d.Date) >= date(?, '-29 days') THEN di.Quantity ELSE 0 END) as d30,
              SUM(CASE WHEN date(d.Date) >= date(?, '-59 days') THEN di.Quantity ELSE 0 END) as d60,
              SUM(CASE WHEN date(d.Date) >= date(?, '-89 days') THEN di.Quantity ELSE 0 END) as d90
       FROM DocumentItem di JOIN Document d ON d.Id = di.DocumentId
       WHERE d.DocumentTypeId = 2 AND date(d.Date) >= date(?, '-89 days')
       GROUP BY di.ProductId`,
      [anchor, anchor, anchor, anchor],
    );
    const byProduct = {};
    for (const r of rows) byProduct[r.pid] = { d30: r.d30 || 0, d60: r.d60 || 0, d90: r.d90 || 0 };
    return byProduct;
  },

  _buildRows() {
    const velocity = this._salesVelocity();
    const rows = [];
    for (const barcode of this.trackedBarcodes) {
      const aronium = Lookup.findByBarcode(barcode);
      const priced = this.priceByUpc.get(barcode) || null;
      const shopStock = aronium ? Lookup.stockFor(aronium.pid) : 0;
      // Every row on this page is a Memory item by construction (that's the
      // whole point of the tracked list), so the group-gate in reserveFor
      // is passed "MEMORY" directly rather than trusting Aronium's own
      // groupName, which is absent for a barcode that's dropped out of
      // Aronium entirely but is still being tracked here.
      const reserveQty = Lookup.reserveFor("MEMORY", barcode) ?? 0;
      const v = aronium ? (velocity[aronium.pid] || { d30: 0, d60: 0, d90: 0 }) : { d30: 0, d60: 0, d90: 0 };
      const name = aronium ? aronium.name : (priced ? priced.description : barcode);
      // Grouped by SanDisk PN family, same helpers/reasoning as memory.js -
      // never guessed from Aronium's own name text, only falls back to the
      // product's own barcode (its own single-item group) when untracked
      // by any current PN.
      rows.push({
        barcode,
        name,
        pn: priced ? priced.pn : null,
        description: priced ? priced.description : null,
        dealerPrice: priced ? priced.dealer_price : null,
        srp: priced ? priced.srp : null,
        remarks: priced ? priced.remarks : null,
        inCurrentPricelist: !!priced,
        shopStock, reserveQty, stock: shopStock + reserveQty,
        d30: v.d30, d60: v.d60, d90: v.d90,
        qty: this.draftQty[barcode] || 0,
        capacity: (priced && capacityFromPn(priced.pn)) || capacityFromName(name),
        color: colorFromName(name),
        groupKey: priced ? `pn:${familyPrefix(priced.pn)}` : `upc:${barcode}`,
        lastIssue: this.lastIssueByBarcode.get(barcode) || null,
      });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    this.rows = rows;
  },

  /** Line cost is null (shown "—", contributes 0) when the dealer price is
   * unknown - e.g. a tracked item that's dropped out of the current
   * pricelist (still orderable in principle, just not at a known current
   * price) shouldn't silently masquerade as a $0 line in the budget total. */
  _lineCost(r) {
    return r.dealerPrice != null ? r.dealerPrice * (r.qty || 0) : null;
  },

  _orderTotal() {
    return this.rows.reduce((sum, r) => sum + (this._lineCost(r) || 0), 0);
  },

  /** Grouped by SanDisk PN family (or the tracked barcode itself when it
   * has none) - same idea as memory.js's list. Every group stays open here
   * (unlike Memory) since this is a short, deliberately-curated tracked
   * list, not the ~100-item full catalog - nothing to collapse away. */
  renderList() {
    const el = document.getElementById("order-list");
    if (!this.rows.length) {
      el.innerHTML = `<p class="empty-state">No products tracked yet - add some from the list below.</p>`;
      return;
    }
    const groups = new Map();
    for (const r of this.rows) {
      if (!groups.has(r.groupKey)) groups.set(r.groupKey, []);
      groups.get(r.groupKey).push(r);
    }
    const groupList = [...groups.values()].map((items) => {
      items.sort((a, b) => capacitySortKey(a.capacity) - capacitySortKey(b.capacity) || (a.color || "").localeCompare(b.color || ""));
      const label = items.length > 1
        ? items.slice().sort((a, b) => a.name.length - b.name.length)[0].name
            .replace(NAME_CAPACITY_RE, "").replace(/\s{2,}/g, " ").trim()
        : items[0].name;
      return { items, label };
    });
    groupList.sort((a, b) => a.label.localeCompare(b.label));

    const today = new Date().toISOString().slice(0, 10);
    el.innerHTML = `
      <div class="sales-summary">
        <span>${this.rows.length} products tracked${this.pricelistDate ? ` &middot; pricelist as of ${escapeHtml(this.pricelistDate)}` : ""}</span>
        <div class="order-actions">
          <button id="order-save-btn" class="btn">Save Order</button>
          <button id="order-export-btn" class="btn">Export to Excel</button>
          <input type="date" id="order-place-date" value="${today}">
          <button id="order-place-btn" class="btn btn-primary">Place Order</button>
        </div>
      </div>
      <p class="order-total-line">Order total: <strong id="order-total-value">${money(this._orderTotal())}</strong></p>
      <p id="order-save-status" class="report-status"></p>
      ${groupList.map((g) => `
        <details class="memory-group" open>
          <summary>
            <span class="memory-group-label">${escapeHtml(g.label)}</span>
            <span class="memory-group-count">${g.items.length} item${g.items.length > 1 ? "s" : ""}</span>
          </summary>
          <div class="sales-table-wrap">
            <table class="report-table order-table">
              <thead><tr>
                <th>Product</th><th>Capacity</th><th>Color</th><th>Barcode</th><th>Dealer S$</th><th>SRP</th>
                <th>Stock</th><th>30d</th><th>60d</th><th>90d</th><th>Order Qty</th><th>Line Cost</th><th></th>
              </tr></thead>
              <tbody>
                ${g.items.map((r) => `
                  <tr data-barcode="${r.barcode}">
                    <td>
                      ${escapeHtml(r.name)}
                      ${r.pn ? `<div class="insight-barcode">${escapeHtml(r.pn)}</div>` : ""}
                      ${!r.inCurrentPricelist ? `<div class="insight-barcode order-dropped-note">Not in current pricelist</div>` : ""}
                      ${r.lastIssue ? `<div class="insight-barcode order-dropped-note">⚠ ${escapeHtml(ORDER_STATUS_LABELS[r.lastIssue.status])} on ${escapeHtml(r.lastIssue.placedDate)} order</div>` : ""}
                    </td>
                    <td>${escapeHtml(r.capacity || "—")}</td>
                    <td>${escapeHtml(r.color || "—")}</td>
                    <td>${escapeHtml(r.barcode)}</td>
                    <td>${r.dealerPrice != null ? money(r.dealerPrice) : "—"}</td>
                    <td>${r.srp != null ? money(r.srp) : "—"}</td>
                    <td>${r.stock} <span class="stock-breakdown">(${r.shopStock} shop + ${r.reserveQty} reserve)</span></td>
                    <td>${r.d30}</td>
                    <td>${r.d60}</td>
                    <td>${r.d90}</td>
                    <td><input type="number" min="0" step="1" class="order-qty-input" data-barcode="${r.barcode}" value="${r.qty || ""}" placeholder="0"></td>
                    <td class="order-line-cost" data-barcode="${r.barcode}">${this._lineCost(r) != null ? money(this._lineCost(r)) : "—"}</td>
                    <td><button class="btn order-remove-btn" data-barcode="${r.barcode}" title="Remove from tracked list">Remove</button></td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </div>
        </details>
      `).join("")}
    `;

    el.querySelectorAll(".order-qty-input").forEach((input) => {
      input.addEventListener("input", (e) => {
        const bc = e.target.dataset.barcode;
        const n = parseInt(e.target.value, 10);
        const r = this.rows.find((row) => row.barcode === bc);
        if (Number.isFinite(n) && n > 0) {
          this.draftQty[bc] = n;
          if (r) r.qty = n;
        } else {
          delete this.draftQty[bc];
          if (r) r.qty = 0;
        }
        // Live budget feedback without a full re-render - a full renderList()
        // here would rebuild every input and drop focus/cursor position
        // mid-keystroke.
        const costCell = el.querySelector(`.order-line-cost[data-barcode="${CSS.escape(bc)}"]`);
        if (costCell && r) costCell.textContent = this._lineCost(r) != null ? money(this._lineCost(r)) : "—";
        const totalEl = document.getElementById("order-total-value");
        if (totalEl) totalEl.textContent = money(this._orderTotal());
      });
    });
    el.querySelectorAll(".order-remove-btn").forEach((btn) => {
      btn.addEventListener("click", () => this.removeBarcode(btn.dataset.barcode));
    });
    document.getElementById("order-save-btn").addEventListener("click", () => this.saveDraft());
    document.getElementById("order-export-btn").addEventListener("click", () => this.exportXlsx());
    document.getElementById("order-place-btn").addEventListener("click", () => this.placeOrder());
  },

  renderAddCandidates() {
    const el = document.getElementById("order-add-candidates");
    const candidates = [...this.priceByUpc.entries()]
      .filter(([upc]) => !this.trackedBarcodes.has(upc))
      .map(([upc, p]) => ({ upc, ...p }))
      .sort((a, b) => (a.description || "").localeCompare(b.description || ""));

    if (!candidates.length) {
      el.innerHTML = `<p class="empty-state">Nothing new - every item in the current pricelist is already tracked.</p>`;
      return;
    }
    el.innerHTML = `
      <table class="report-table">
        <thead><tr><th>PN</th><th>Description</th><th>Dealer S$</th><th>UPC</th><th></th></tr></thead>
        <tbody>
          ${candidates.map((c) => `
            <tr>
              <td>${escapeHtml(c.pn)}</td>
              <td>${escapeHtml(c.description || "")}</td>
              <td>${money(c.dealer_price)}</td>
              <td>${escapeHtml(c.upc)}</td>
              <td><button class="btn order-add-btn" data-barcode="${c.upc}">Add</button></td>
            </tr>`).join("")}
        </tbody>
      </table>
    `;
    el.querySelectorAll(".order-add-btn").forEach((btn) => {
      btn.addEventListener("click", () => this.addBarcode(btn.dataset.barcode));
    });
  },

  /** Newest first. Groups open automatically when they still have a
   * "pending" line (nothing reconciled yet) or any no_stock/lesser_stock -
   * a fully-OK past order collapses out of the way. */
  renderHistoryList() {
    const el = document.getElementById("order-history-list");
    if (!this.orderHistory.length) {
      el.innerHTML = `<p class="empty-state">No orders placed yet - use "Place Order" on the Current Order tab once you've sent one to Convergent.</p>`;
      return;
    }
    const sorted = [...this.orderHistory].sort((a, b) => b.placedDate.localeCompare(a.placedDate) || b.id.localeCompare(a.id));

    el.innerHTML = sorted.map((order) => {
      const counts = { pending: 0, ok: 0, no_stock: 0, lesser_stock: 0 };
      for (const line of order.lines) counts[line.status] = (counts[line.status] || 0) + 1;
      const needsAttention = counts.pending > 0 || counts.no_stock > 0 || counts.lesser_stock > 0;
      const total = order.lines.reduce((sum, l) => sum + (l.dealerPrice != null ? l.dealerPrice * l.qtyOrdered : 0), 0);
      const summary = Object.entries(counts).filter(([, n]) => n > 0)
        .map(([status, n]) => `<span class="${orderStatusClass(status)}">${n} ${escapeHtml(ORDER_STATUS_LABELS[status])}</span>`).join(" &middot; ");

      return `
        <details class="memory-group" data-order-id="${order.id}" ${needsAttention ? "open" : ""}>
          <summary>
            <span class="memory-group-label">${escapeHtml(order.placedDate)}</span>
            <span class="memory-group-count">${order.lines.length} item${order.lines.length > 1 ? "s" : ""} &middot; ${money(total)} &middot; ${summary}</span>
          </summary>
          <div class="sales-table-wrap">
            <table class="report-table order-table">
              <thead><tr><th>Product</th><th>Barcode</th><th>Qty Ordered</th><th>Dealer S$</th><th>Status</th></tr></thead>
              <tbody>
                ${order.lines.map((l, i) => `
                  <tr>
                    <td>${escapeHtml(l.name)}${l.pn ? `<div class="insight-barcode">${escapeHtml(l.pn)}</div>` : ""}</td>
                    <td>${escapeHtml(l.barcode)}</td>
                    <td>${l.qtyOrdered}</td>
                    <td>${l.dealerPrice != null ? money(l.dealerPrice) : "—"}</td>
                    <td>
                      <select class="order-history-status ${orderStatusClass(l.status)}" data-order-id="${order.id}" data-line-index="${i}">
                        ${Object.entries(ORDER_STATUS_LABELS).map(([v, label]) => `<option value="${v}" ${l.status === v ? "selected" : ""}>${label}</option>`).join("")}
                      </select>
                    </td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </div>
          <div class="order-history-save-row">
            <button class="btn order-history-save-btn" data-order-id="${order.id}">Save</button>
            <span class="report-status" data-order-status="${order.id}"></span>
          </div>
        </details>`;
    }).join("");

    el.querySelectorAll(".order-history-status").forEach((select) => {
      select.addEventListener("change", (e) => {
        select.className = `order-history-status ${orderStatusClass(e.target.value)}`;
      });
    });
    el.querySelectorAll(".order-history-save-btn").forEach((btn) => {
      btn.addEventListener("click", () => this.saveHistoryOrder(btn.dataset.orderId));
    });
  },

  /** Reads every status <select> for one order straight from the DOM
   * (simpler and less error-prone than keeping a parallel edit-buffer in
   * sync) and writes it back into that order's lines before saving. */
  async saveHistoryOrder(orderId) {
    const statusEl = document.querySelector(`[data-order-status="${CSS.escape(orderId)}"]`);
    const order = this.orderHistory.find((o) => o.id === orderId);
    if (!order) return;
    document.querySelectorAll(`.order-history-status[data-order-id="${CSS.escape(orderId)}"]`).forEach((select) => {
      const i = Number(select.dataset.lineIndex);
      if (order.lines[i]) order.lines[i].status = select.value;
    });
    statusEl.textContent = "Saving…";
    try {
      await this._saveDriveJson(ORDER_HISTORY_FILE, { orders: this.orderHistory });
      this._buildLastIssueMap();
      statusEl.textContent = "Saved.";
      this.renderHistoryList();
    } catch (e) {
      statusEl.textContent = "";
      setStatus("Save failed: " + e.message, true);
    }
  },

  async removeBarcode(barcode) {
    this.trackedBarcodes.delete(barcode);
    delete this.draftQty[barcode];
    await this._saveTrackedList(this.trackedBarcodes);
    this._buildRows();
    this.renderList();
    this.renderAddCandidates();
  },

  async addBarcode(barcode) {
    this.trackedBarcodes.add(barcode);
    await this._saveTrackedList(this.trackedBarcodes);
    this._buildRows();
    this.renderList();
    this.renderAddCandidates();
  },

  async saveDraft() {
    const statusEl = document.getElementById("order-save-status");
    statusEl.textContent = "Saving…";
    try {
      await this._saveDriveJson(ORDER_DRAFT_FILE, this.draftQty);
      statusEl.textContent = "Saved.";
    } catch (e) {
      statusEl.textContent = "";
      setStatus("Save failed: " + e.message, true);
    }
  },

  /** Distinct from Save Order: this is "I actually sent this to Convergent",
   * not just "keep my in-progress quantities." Snapshots every line with a
   * quantity into a new order_memory_history.json entry (status "pending"
   * until reconciled from the History tab), then clears the draft
   * quantities so the next visit starts a fresh order - the tracked list
   * itself is untouched, since he's still tracking the same products. */
  async placeOrder() {
    const statusEl = document.getElementById("order-save-status");
    const orderRows = this.rows.filter((r) => (r.qty || 0) > 0);
    if (!orderRows.length) {
      statusEl.textContent = "";
      setStatus("No quantities entered yet - nothing to place.", true);
      return;
    }
    const dateInput = document.getElementById("order-place-date");
    const placedDate = dateInput.value || new Date().toISOString().slice(0, 10);

    statusEl.textContent = "Placing order…";
    try {
      const order = {
        id: `order-${Date.now()}`,
        placedDate,
        lines: orderRows.map((r) => ({
          barcode: r.barcode, pn: r.pn, name: r.name,
          qtyOrdered: r.qty, dealerPrice: r.dealerPrice, status: "pending",
        })),
      };
      this.orderHistory.push(order);
      await this._saveDriveJson(ORDER_HISTORY_FILE, { orders: this.orderHistory });

      this.draftQty = {};
      await this._saveDriveJson(ORDER_DRAFT_FILE, this.draftQty);

      this._buildLastIssueMap();
      this._buildRows();
      this.renderList();
      // renderList() just rebuilt #order-save-status from scratch (empty) -
      // grab the fresh element rather than the one captured before render.
      document.getElementById("order-save-status").textContent =
        `Order placed on ${placedDate} (${orderRows.length} products). Quantities cleared for your next order - see it under Order History.`;
    } catch (e) {
      statusEl.textContent = "";
      setStatus("Couldn't place order: " + e.message, true);
    }
  },

  exportXlsx() {
    const orderRows = this.rows.filter((r) => (r.qty || 0) > 0);
    if (!orderRows.length) {
      setStatus("No quantities entered yet - nothing to export.", true);
      return;
    }
    const header = ["PN", "Description", "Dealer S$", "SRP", "UPC", "Remarks", "Order Qty"];
    const data = orderRows.map((r) => [
      r.pn || "", r.description || r.name, r.dealerPrice ?? "", r.srp ?? "", r.barcode, r.remarks || "", r.qty,
    ]);
    const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
    ws["!cols"] = [{ wch: 16 }, { wch: 50 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 20 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Order");
    const today = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `convergent-order-${today}.xlsx`);
  },

  async _loadDriveJson(name) {
    const rootId = await Drive.findChild(CONFIG.ROOT_FOLDER, "root", true);
    if (!rootId) return null;
    const fileId = await Drive.findChild(name, rootId);
    if (!fileId) return null;
    return JSON.parse(await Drive.downloadText(fileId));
  },

  async _saveDriveJson(name, obj) {
    const rootId = await Drive.findChild(CONFIG.ROOT_FOLDER, "root", true);
    if (!rootId) throw new Error(`Couldn't find "${CONFIG.ROOT_FOLDER}" in your Drive.`);
    await Drive.saveJson(name, rootId, obj);
  },
};
