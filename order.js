// Order Memory tab: replaces Derrick manually cross-referencing shop stock,
// reserve stock, and the SanDisk pricelist by eye to decide what to order
// from Convergent. Pulls all three together (stock via Reports/Lookup,
// pricelist via sandisk_price_history.json, sales velocity via a fresh
// query) into one editable table, saves the in-progress order, and exports
// it to an .xlsx in Convergent's own pricelist column shape plus Order Qty.

const ORDER_TRACKED_FILE = "order_memory_tracked.json";
const ORDER_DRAFT_FILE = "order_memory_draft.json";

const Order = {
  loaded: false,
  priceByUpc: null, // Map<upc, {pn, description, dealer_price, srp, remarks, date}>
  pricelistDate: null,
  trackedBarcodes: null, // Set<barcode>
  draftQty: {}, // {barcode: qty}
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

    this._buildRows();
    this.loaded = true;
  },

  async render() {
    const el = document.getElementById("order-status");
    el.textContent = "Loading stock, reserve, and pricelist data…";
    try {
      await this.ensureLoaded();
      el.textContent = "";
      this.renderList();
      this.renderAddCandidates();
    } catch (e) {
      el.textContent = "";
      setStatus(e.message, true);
    }
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
      rows.push({
        barcode,
        name: aronium ? aronium.name : (priced ? priced.description : barcode),
        pn: priced ? priced.pn : null,
        description: priced ? priced.description : null,
        dealerPrice: priced ? priced.dealer_price : null,
        srp: priced ? priced.srp : null,
        remarks: priced ? priced.remarks : null,
        inCurrentPricelist: !!priced,
        shopStock, reserveQty, stock: shopStock + reserveQty,
        d30: v.d30, d60: v.d60, d90: v.d90,
        qty: this.draftQty[barcode] || 0,
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

  renderList() {
    const el = document.getElementById("order-list");
    if (!this.rows.length) {
      el.innerHTML = `<p class="empty-state">No products tracked yet - add some from the list below.</p>`;
      return;
    }
    el.innerHTML = `
      <div class="sales-summary">
        <span>${this.rows.length} products tracked${this.pricelistDate ? ` &middot; pricelist as of ${escapeHtml(this.pricelistDate)}` : ""}</span>
        <div>
          <button id="order-save-btn" class="btn btn-primary">Save Order</button>
          <button id="order-export-btn" class="btn">Export to Excel</button>
        </div>
      </div>
      <p class="order-total-line">Order total: <strong id="order-total-value">${money(this._orderTotal())}</strong></p>
      <p id="order-save-status" class="report-status"></p>
      <div class="sales-table-wrap">
        <table class="report-table order-table">
          <thead><tr>
            <th>Product</th><th>Barcode</th><th>Dealer S$</th><th>SRP</th>
            <th>Stock</th><th>30d</th><th>60d</th><th>90d</th><th>Order Qty</th><th>Line Cost</th><th></th>
          </tr></thead>
          <tbody>
            ${this.rows.map((r) => `
              <tr data-barcode="${r.barcode}">
                <td>
                  ${escapeHtml(r.name)}
                  ${r.pn ? `<div class="insight-barcode">${escapeHtml(r.pn)}</div>` : ""}
                  ${!r.inCurrentPricelist ? `<div class="insight-barcode order-dropped-note">Not in current pricelist</div>` : ""}
                </td>
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
