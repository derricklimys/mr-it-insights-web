// Memory tab: cross-references Aronium's Memory-group catalog against the
// SanDisk price history and reserve-stock file to surface two signals -
// stock-up (cost rising, stock thin, margin still healthy) and reprice
// (a real, measured sales slowdown, or margin that's quietly thinned as
// cost rose) - plus a per-product history chart and a "new in the
// pricelist but never stocked" list.

const Memory = {
  loaded: false,
  products: [],
  newProducts: [],
  selectedId: null,

  async ensureLoaded() {
    if (this.loaded) return;
    await Reports.ensureLoaded();
    const statusEl = document.getElementById("memory-status");

    statusEl.textContent = "Loading price history and reserve stock...";
    const priceHistory = (await this._loadDriveJson("sandisk_price_history.json")) || {};
    const reserveStock = (await this._loadDriveJson("reserve_stock.json")) || {};
    // Shared with Powerbank - a separate file from priceHistory on purpose,
    // since that file gets wholesale-overwritten on every pricelist refresh.
    const productPhotos = (await this._loadDriveJson("product_photos.json")) || {};

    statusEl.textContent = "Cross-referencing your Memory catalog...";
    const products = Reports.query(`
      SELECT p.Id, p.Name, p.Price FROM Product p JOIN ProductGroup pg ON pg.Id = p.ProductGroupId
      WHERE pg.Name = 'MEMORY' AND p.IsEnabled = 1
    `);
    const barcodeRows = Reports.query(`
      SELECT b.ProductId, b.Value FROM Barcode b JOIN Product p ON p.Id = b.ProductId
      JOIN ProductGroup pg ON pg.Id = p.ProductGroupId WHERE pg.Name = 'MEMORY'
    `);
    const barcodesByProduct = {};
    for (const r of barcodeRows) (barcodesByProduct[r.ProductId] = barcodesByProduct[r.ProductId] || []).push(r.Value);

    const stockRows = Reports.query(`
      SELECT s.ProductId as pid, SUM(s.Quantity) as qty FROM Stock s JOIN Product p ON p.Id = s.ProductId
      JOIN ProductGroup pg ON pg.Id = p.ProductGroupId WHERE pg.Name = 'MEMORY' GROUP BY s.ProductId
    `);
    const stockByProduct = {};
    for (const r of stockRows) stockByProduct[r.pid] = r.qty;

    // "Last 30 days" is relative to the newest data actually in the synced
    // DB, not the browser's clock - the sync can lag behind real time by a
    // day or more, and this keeps every "recent" figure on the same clock.
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

    const priceByUpc = {};
    for (const [pn, entries] of Object.entries(priceHistory)) {
      const last = entries[entries.length - 1];
      if (last && last.upc && !priceByUpc[last.upc]) priceByUpc[last.upc] = { pn, entries };
    }

    // Real invoice cost is what he actually paid - the pricelist is just
    // what Convergent is quoting, which he often beats. Prefer this
    // wherever it exists; the pricelist trend only fills gaps.
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
      let priceMatch = null;
      for (const bc of barcodes) {
        if (priceByUpc[bc]) { priceMatch = priceByUpc[bc]; break; }
      }
      const monthly = Reports.query(
        `SELECT strftime('%Y-%m', d.Date) as ym, AVG(di.Price) as avgPrice, SUM(di.Quantity) as qty
         FROM DocumentItem di JOIN Document d ON d.Id = di.DocumentId
         WHERE d.DocumentTypeId = 2 AND di.ProductId = ? GROUP BY ym ORDER BY ym`,
        [r.Id],
      );
      const reserveEntry = barcodes.map((bc) => reserveStock[bc]).find(Boolean);
      const photoEntry = barcodes.map((bc) => productPhotos[bc]).find(Boolean);
      const aroniumStock = stockByProduct[r.Id] || 0;
      const reserveQty = reserveEntry ? reserveEntry.quantity : 0;
      const invoiceCosts = invoiceCostsByProduct[r.Id] || [];
      const combinedStock = aroniumStock + reserveQty;
      const last30 = last30ByProduct[r.Id] || { qty: 0, revenue: 0 };
      const daysOfStockLeft = last30.qty > 0 ? combinedStock / (last30.qty / 30) : null;

      const signal = Catalog.computeSignal({
        currentPrice: r.Price,
        priceHistory: priceMatch ? priceMatch.entries : null,
        invoiceCosts,
        monthly,
        combinedStock,
      });

      return {
        productId: r.Id, name: r.Name, currentPrice: r.Price, barcodes,
        photoThumbUrl: photoEntry ? photoEntry.thumb_url : null,
        photoUrl: photoEntry ? photoEntry.url : null,
        priceHistoryPn: priceMatch ? priceMatch.pn : null,
        priceHistory: priceMatch ? priceMatch.entries : [],
        invoiceCosts,
        monthly, aroniumStock, reserveQty, combinedStock,
        reserveUpdatedAt: reserveEntry ? reserveEntry.updated_at : null,
        last30Qty: last30.qty, last30Revenue: last30.revenue, daysOfStockLeft,
        signal: signal.type, signalReason: signal.reason, marginPct: signal.marginPct,
        costSource: signal.costSource, costRising: signal.costRising,
      };
    });
    this.products.sort((a, b) => Catalog.signalRank(b.signal) - Catalog.signalRank(a.signal));

    statusEl.textContent = "Checking for SanDisk products you don't stock...";
    const allBarcodes = new Set(Reports.query("SELECT Value FROM Barcode").map((r) => r.Value));
    const latestDate = Object.values(priceHistory).flat().reduce((max, e) => (e.date > max ? e.date : max), "");
    const seenUpc = new Set();
    this.newProducts = [];
    for (const entries of Object.values(priceHistory)) {
      const last = entries[entries.length - 1];
      if (!last || last.date !== latestDate || !last.upc || seenUpc.has(last.upc)) continue;
      seenUpc.add(last.upc);
      if (!allBarcodes.has(last.upc)) {
        this.newProducts.push({ description: last.description, price: last.dealer_price, upc: last.upc });
      }
    }
    this.newProducts.sort((a, b) => a.price - b.price);

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
    const el = document.getElementById("memory-list");
    if (!this.products.length) {
      el.innerHTML = `<p class="empty-state">No Memory-group products found in Aronium.</p>`;
      return;
    }
    el.innerHTML = Catalog.tableHtmlWithRowIds(
      ["", "Photo", "Product", "Barcode", "Combined Stock", "Margin", "Signal"],
      this.products.map((p) => [
        p.productId,
        p.photoThumbUrl ? `<img class="product-thumb" src="${p.photoThumbUrl}" alt="">` : `<span class="product-thumb-placeholder">—</span>`,
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
    const el = document.getElementById("memory-detail");
    if (!p) { el.innerHTML = ""; return; }

    // Deliberately the raw latest figures, not the blended cost estimate
    // used for the Margin stat/signal logic - Derrick asked to see exactly
    // what he actually paid on his last invoice and what Convergent's own
    // current pricelist quotes, side by side, not a single derived number.
    const lastInvoice = p.invoiceCosts.length ? p.invoiceCosts[p.invoiceCosts.length - 1] : null;
    const lastPricelist = p.priceHistory.length ? p.priceHistory[p.priceHistory.length - 1] : null;

    el.innerHTML = `
      <div class="detail-header">
        ${p.photoUrl ? `<img class="product-photo-large product-photo-clickable" id="memory-photo-large" src="${p.photoUrl}" alt="">` : ""}
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
          <span class="stat-label">Last Selling Price (Dealer)</span>
          <span class="stat-value">${lastPricelist && lastPricelist.dealer_price != null ? money(lastPricelist.dealer_price) : "—"}</span>
          ${lastPricelist ? `<span class="stock-breakdown">pricelist ${escapeHtml(lastPricelist.date)}</span>` : ""}
        </div>
        <div>
          <span class="stat-label">RCP (SRP)</span>
          <span class="stat-value">${lastPricelist && lastPricelist.srp != null ? money(lastPricelist.srp) : "—"}</span>
        </div>
      </div>
      <p class="cost-source-note">${Catalog.costSourceNote(p)}</p>
      <canvas id="memory-chart" width="900" height="320"></canvas>
    `;
    Catalog.drawChart(document.getElementById("memory-chart"), p);
    if (p.photoUrl) {
      document.getElementById("memory-photo-large").addEventListener("click", () => Catalog.openPhotoLightbox(p.photoUrl));
    }
    document.getElementById("memory-detail-modal").classList.remove("hidden");
  },

  closeDetail() {
    document.getElementById("memory-detail-modal").classList.add("hidden");
  },

  renderInsights() {
    const el = document.getElementById("memory-insights");
    const p = this.products;

    const topByVolume = p.filter((x) => x.last30Qty > 0).sort((a, b) => b.last30Qty - a.last30Qty).slice(0, 10);
    const topByRevenue = p.filter((x) => x.last30Revenue > 0).sort((a, b) => b.last30Revenue - a.last30Revenue).slice(0, 10);
    const thinnestMargin = p.filter((x) => x.marginPct != null).sort((a, b) => a.marginPct - b.marginPct).slice(0, 10);
    const costMovers = p.filter((x) => x.costRising).sort((a, b) => (a.marginPct ?? 999) - (b.marginPct ?? 999));
    const reserveAging = p.filter((x) => x.reserveQty > 0 && x.reserveUpdatedAt)
      .sort((a, b) => a.reserveUpdatedAt.localeCompare(b.reserveUpdatedAt)).slice(0, 10);

    el.innerHTML = `
      <div class="insights-lookup">
        <input type="text" id="barcode-lookup" placeholder="Scan or type a barcode, then press Enter...">
        <p id="barcode-lookup-status" class="report-status"></p>
      </div>
      <div class="insights-grid">
        ${this._insightSection("Top Sellers - by Volume (last 30 days)", topByVolume, (x) => `${x.last30Qty} sold`)}
        ${this._insightSection("Top Sellers - by Revenue (last 30 days)", topByRevenue, (x) => money(x.last30Revenue))}
        ${this._insightSection("Thinnest Margin", thinnestMargin, (x) => (x.marginPct != null ? x.marginPct.toFixed(0) + "%" : "—"))}
        ${this._insightSection(
          "Cost Recently Rising", costMovers,
          (x) => (x.marginPct != null ? x.marginPct.toFixed(0) + "% margin" : "—"),
          "Nothing flagged for a recent cost increase.",
        )}
        ${this._insightSection(
          "Reserve Stock Sitting Longest", reserveAging,
          (x) => `${x.reserveQty} since ${(x.reserveUpdatedAt || "").slice(0, 10)}`,
          "No reserve stock recorded yet.",
        )}
      </div>
    `;

    const lookupInput = document.getElementById("barcode-lookup");
    lookupInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this._lookupBarcode(lookupInput.value);
    });
    el.querySelectorAll("[data-insight-id]").forEach((row) => {
      row.addEventListener("click", () => this.select(Number(row.dataset.insightId)));
    });
  },

  _insightSection(title, items, valueFn, emptyText) {
    if (!items.length) {
      return `<section class="insight-section"><h3>${title}</h3><p class="empty-state">${emptyText || "Nothing to show yet."}</p></section>`;
    }
    return `
      <section class="insight-section">
        <h3>${title}</h3>
        <table class="report-table insight-table">
          <tbody>
            ${items.map((x) => `
              <tr data-insight-id="${x.productId}">
                <td>${escapeHtml(x.name)}<div class="insight-barcode">${escapeHtml(x.barcodes[0] || "—")}</div></td>
                <td class="insight-value">${valueFn(x)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </section>
    `;
  },

  /** Jumps straight to a product's detail from anywhere - the modal is a
   * page-level overlay, so this works regardless of which Memory sub-tab is
   * currently showing. */
  _lookupBarcode(term) {
    const status = document.getElementById("barcode-lookup-status");
    term = (term || "").trim();
    if (!term) { status.textContent = ""; return; }
    const match = this.products.find((x) => x.barcodes.includes(term))
      || this.products.find((x) => x.barcodes.some((b) => b.includes(term)));
    if (match) {
      status.textContent = "";
      this.select(match.productId);
    } else {
      status.textContent = `No product found with barcode "${term}".`;
    }
  },

  renderNewProducts() {
    const el = document.getElementById("memory-new");
    if (!this.newProducts.length) {
      el.innerHTML = `<p class="empty-state">Nothing new - every SanDisk SKU in the latest pricelist matches something you already stock.</p>`;
      return;
    }
    el.innerHTML = `
      <div class="memory-filters">
        <input type="text" id="new-search" placeholder="Filter by description...">
        <input type="number" id="new-maxprice" placeholder="Max price ($)">
      </div>
      <p id="new-status" class="report-status"></p>
      <div id="new-results"></div>`;
    const update = () => this._renderNewProductsResults(document.getElementById("new-maxprice").value, document.getElementById("new-search").value);
    document.getElementById("new-search").addEventListener("input", update);
    document.getElementById("new-maxprice").addEventListener("input", update);
    update();
  },

  _renderNewProductsResults(maxPrice, search) {
    const max = maxPrice !== "" && maxPrice != null ? Number(maxPrice) : null;
    const term = (search || "").trim().toLowerCase();
    const filtered = this.newProducts.filter((n) => {
      if (max != null && n.price > max) return false;
      if (term && !(n.description || "").toLowerCase().includes(term)) return false;
      return true;
    });
    document.getElementById("new-status").textContent =
      `${filtered.length} of ${this.newProducts.length} SanDisk SKUs in the latest pricelist don't match anything in your Aronium catalog (mostly external SSDs - use the filters above to narrow to memory cards).`;
    document.getElementById("new-results").innerHTML = tableHtml(
      ["Description", "Dealer Price", "UPC"],
      filtered.map((n) => [escapeHtml(n.description || ""), money(n.price), n.upc]),
    );
  },
};
