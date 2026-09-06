// Powerbank tab: same combined-stock/signal/chart tracking as the Memory
// tab, applied to the Powerbank group instead - Derrick asked for "keep
// track of powerbank stock like memory" once he started carrying reserve
// stock for Verbatim power banks too. Reuses Catalog.* (catalog.js) for the
// signal math, badges, and chart so the two tabs look and behave
// identically instead of drifting apart as separate implementations.
//
// Deliberately simpler than Memory: no Insights or New-in-Pricelist
// sub-tabs (not asked for), and price history is a single current snapshot
// from Convergent's Verbatim pricelist (verbatim_pn_map.json, no dated
// history like SanDisk's) since Derrick said Verbatim pricing doesn't move
// often enough to be worth tracking a trend for - the useful "cost rising"
// signal instead comes from real Convergent invoice-cost history wherever
// 2+ invoices exist for a barcode, exactly like Memory.

const Powerbank = {
  loaded: false,
  products: [],
  selectedId: null,

  async ensureLoaded() {
    if (this.loaded) return;
    await Reports.ensureLoaded();
    const statusEl = document.getElementById("powerbank-status");

    statusEl.textContent = "Loading Verbatim pricelist and reserve stock...";
    const verbatimMap = (await this._loadDriveJson("verbatim_pn_map.json")) || {};
    const reserveStock = (await this._loadDriveJson("reserve_stock.json")) || {};
    // verbatim_pn_map.json is a single current snapshot, not a dated
    // history - wrap it as one "history" entry per barcode so it fits the
    // same priceHistory shape Catalog.computeSignal/drawChart already
    // expect for SanDisk's multi-snapshot history.
    const snapshotDate = new Date().toISOString().slice(0, 10);

    statusEl.textContent = "Cross-referencing your Powerbank catalog...";
    const products = Reports.query(`
      SELECT p.Id, p.Name, p.Price FROM Product p JOIN ProductGroup pg ON pg.Id = p.ProductGroupId
      WHERE pg.Name = 'POWERBANK' AND p.IsEnabled = 1
    `);
    const barcodeRows = Reports.query(`
      SELECT b.ProductId, b.Value FROM Barcode b JOIN Product p ON p.Id = b.ProductId
      JOIN ProductGroup pg ON pg.Id = p.ProductGroupId WHERE pg.Name = 'POWERBANK'
    `);
    const barcodesByProduct = {};
    for (const r of barcodeRows) (barcodesByProduct[r.ProductId] = barcodesByProduct[r.ProductId] || []).push(r.Value);

    const stockRows = Reports.query(`
      SELECT s.ProductId as pid, SUM(s.Quantity) as qty FROM Stock s JOIN Product p ON p.Id = s.ProductId
      JOIN ProductGroup pg ON pg.Id = p.ProductGroupId WHERE pg.Name = 'POWERBANK' GROUP BY s.ProductId
    `);
    const stockByProduct = {};
    for (const r of stockRows) stockByProduct[r.pid] = r.qty;

    // Same "anchor to the DB's own latest date" convention as Memory - the
    // sync can lag real time by a day or more.
    const latestDataRow = Reports.query("SELECT MAX(Date) as d FROM Document")[0];
    const latestDataDate = latestDataRow ? latestDataRow.d : null;
    const last30Rows = latestDataDate
      ? Reports.query(
          `SELECT di.ProductId as pid, SUM(di.Quantity) as qty, SUM(di.Total) as revenue
           FROM DocumentItem di JOIN Document d ON d.Id = di.DocumentId
           WHERE d.DocumentTypeId = 2 AND d.Date >= date(?, '-30 days')
           GROUP BY di.ProductId`,
          [latestDataDate],
        )
      : [];
    const last30ByProduct = {};
    for (const r of last30Rows) last30ByProduct[r.pid] = { qty: r.qty || 0, revenue: r.revenue || 0 };

    // Real invoice cost is what he actually paid - same priority as Memory,
    // built from the same shared confirmedLines (supplier/group-agnostic).
    const invoiceCostsByProduct = {};
    for (const li of Reports.confirmedLines) {
      if (!li.matched_product_id || li.true_cost_incl_gst == null) continue;
      (invoiceCostsByProduct[li.matched_product_id] = invoiceCostsByProduct[li.matched_product_id] || []).push({
        date: li.invoice_date, cost: li.true_cost_incl_gst, supplier: li.supplier,
      });
    }
    for (const pid in invoiceCostsByProduct) invoiceCostsByProduct[pid].sort((a, b) => a.date.localeCompare(b.date));

    this.products = products.map((r) => {
      const barcodes = barcodesByProduct[r.Id] || [];
      const verbatimEntry = barcodes.map((bc) => (verbatimMap[bc] ? { bc, ...verbatimMap[bc] } : null)).find(Boolean);
      const priceHistory = verbatimEntry
        ? [{
            date: snapshotDate,
            dealer_price: verbatimEntry.reseller_cost,
            special_price: null,
            srp: verbatimEntry.srp,
            upc: verbatimEntry.bc,
            description: verbatimEntry.description,
          }]
        : [];
      const monthly = Reports.query(
        `SELECT strftime('%Y-%m', d.Date) as ym, AVG(di.Price) as avgPrice, SUM(di.Quantity) as qty
         FROM DocumentItem di JOIN Document d ON d.Id = di.DocumentId
         WHERE d.DocumentTypeId = 2 AND di.ProductId = ? GROUP BY ym ORDER BY ym`,
        [r.Id],
      );
      const reserveEntry = barcodes.map((bc) => reserveStock[bc]).find(Boolean);
      const aroniumStock = stockByProduct[r.Id] || 0;
      const reserveQty = reserveEntry ? reserveEntry.quantity : 0;
      const invoiceCosts = invoiceCostsByProduct[r.Id] || [];
      const combinedStock = aroniumStock + reserveQty;
      const last30 = last30ByProduct[r.Id] || { qty: 0, revenue: 0 };
      const daysOfStockLeft = last30.qty > 0 ? combinedStock / (last30.qty / 30) : null;

      const signal = Catalog.computeSignal({
        currentPrice: r.Price,
        priceHistory: priceHistory.length ? priceHistory : null,
        invoiceCosts,
        monthly,
        combinedStock,
      });

      return {
        productId: r.Id, name: r.Name, currentPrice: r.Price, barcodes,
        priceHistoryPn: verbatimEntry ? verbatimEntry.pn : null,
        priceHistory,
        invoiceCosts,
        monthly, aroniumStock, reserveQty, combinedStock,
        reserveUpdatedAt: reserveEntry ? reserveEntry.updated_at : null,
        last30Qty: last30.qty, last30Revenue: last30.revenue, daysOfStockLeft,
        signal: signal.type, signalReason: signal.reason, marginPct: signal.marginPct,
        costSource: signal.costSource, costRising: signal.costRising,
      };
    });
    this.products.sort((a, b) => Catalog.signalRank(b.signal) - Catalog.signalRank(a.signal));

    this.loaded = true;
    statusEl.textContent = "";
  },

  async _loadDriveJson(name) {
    const rootId = await Drive.findChild(CONFIG.ROOT_FOLDER, "root", true);
    if (!rootId) return null;
    const fileId = await Drive.findChild(name, rootId);
    if (!fileId) return null;
    return JSON.parse(await Drive.downloadText(fileId));
  },

  renderList() {
    const el = document.getElementById("powerbank-list");
    if (!this.products.length) {
      el.innerHTML = `<p class="empty-state">No Powerbank-group products found in Aronium.</p>`;
      return;
    }
    el.innerHTML = Catalog.tableHtmlWithRowIds(
      ["", "Product", "Barcode", "Combined Stock", "Margin", "Signal"],
      this.products.map((p) => [
        p.productId,
        escapeHtml(p.name),
        escapeHtml(p.barcodes[0] || "—"),
        `${p.combinedStock} <span class="stock-breakdown">(${p.aroniumStock} shop + ${p.reserveQty} reserve)</span>`,
        p.marginPct != null ? p.marginPct.toFixed(0) + "%" : "—",
        Catalog.signalBadge(p.signal),
      ]),
    );
    el.querySelectorAll("tr[data-id]").forEach((row) => {
      row.addEventListener("click", () => this.select(Number(row.dataset.id)));
    });
  },

  select(productId) {
    this.selectedId = productId;
    const p = this.products.find((x) => x.productId === productId);
    const el = document.getElementById("powerbank-detail");
    if (!p) { el.innerHTML = ""; return; }

    const lastInvoice = p.invoiceCosts.length ? p.invoiceCosts[p.invoiceCosts.length - 1] : null;
    const lastPricelist = p.priceHistory.length ? p.priceHistory[p.priceHistory.length - 1] : null;

    el.innerHTML = `
      <div class="detail-header">
        <div>
          <h2>${escapeHtml(p.name)}</h2>
          <p class="detail-barcode">${escapeHtml(p.barcodes.join(", ") || "No barcode on file")}</p>
        </div>
        ${Catalog.signalBadge(p.signal)}
      </div>
      ${p.signalReason ? `<p class="signal-reason">${escapeHtml(p.signalReason)}</p>` : ""}
      <div class="memory-stats">
        <div><span class="stat-label">Shop floor stock</span><span class="stat-value">${p.aroniumStock}</span></div>
        <div><span class="stat-label">Reserve stock</span><span class="stat-value">${p.reserveQty}</span></div>
        <div><span class="stat-label">Sold, last 30 days</span><span class="stat-value">${p.last30Qty}</span></div>
        <div><span class="stat-label">Days of stock left</span><span class="stat-value">${p.daysOfStockLeft != null ? Math.round(p.daysOfStockLeft) : "—"}</span></div>
        <div><span class="stat-label">Current price</span><span class="stat-value">${money(p.currentPrice)}</span></div>
        <div><span class="stat-label">Margin</span><span class="stat-value">${p.marginPct != null ? p.marginPct.toFixed(0) + "%" : "—"}</span></div>
        <div>
          <span class="stat-label">Cost (latest invoice)</span>
          <span class="stat-value">${lastInvoice ? money(lastInvoice.cost) : "—"}</span>
          ${lastInvoice ? `<span class="stock-breakdown">${escapeHtml(lastInvoice.date)} &middot; ${escapeHtml(lastInvoice.supplier)}</span>` : ""}
        </div>
        <div>
          <span class="stat-label">Dealer Cost (pricelist)</span>
          <span class="stat-value">${lastPricelist && lastPricelist.dealer_price != null ? money(lastPricelist.dealer_price) : "—"}</span>
          ${lastPricelist ? `<span class="stock-breakdown">Verbatim pricelist, current</span>` : ""}
        </div>
        <div>
          <span class="stat-label">SRP</span>
          <span class="stat-value">${lastPricelist && lastPricelist.srp != null ? money(lastPricelist.srp) : "—"}</span>
        </div>
      </div>
      <p class="cost-source-note">${Catalog.costSourceNote(p)}</p>
      <canvas id="powerbank-chart" width="900" height="320"></canvas>
    `;
    Catalog.drawChart(document.getElementById("powerbank-chart"), p);
    document.getElementById("powerbank-detail-modal").classList.remove("hidden");
  },

  closeDetail() {
    document.getElementById("powerbank-detail-modal").classList.add("hidden");
  },
};
