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

// Grouping (see memory.js for the same idea applied to SanDisk PNs): a
// Verbatim PN's family/model is everything but the last digit - confirmed
// against the full verbatim_pn_map.json, e.g. VM-32266/32268 are the same
// 10,000mAh Magnetic Wireless power bank in Blue vs Grey. Unlike SanDisk,
// Convergent's own "Color/Type" column is already an explicit, reliable
// color/variant label (not guessed from the Aronium name) - just needs its
// "(Blue)"/"(Grey) C&C" wrapper stripped down to the plain color word.
// Products with no Verbatim PN match (other brands - Denmen, Y2K, Wopow,
// etc.) get their own single-item group keyed by barcode, same as Memory's
// PN-less fallback.
const MAH_RE = /(\d[\d,\s]*\d|\d)\s*mAh/i;

function verbatimFamilyPrefix(pn) {
  return pn.slice(0, -1);
}

function cleanVerbatimColor(raw) {
  if (!raw) return null;
  const m = /\(([^)]+)\)/.exec(raw);
  const cleaned = (m ? m[1] : raw).trim();
  return cleaned && !/^\d+$/.test(cleaned) ? cleaned : null;
}

function capacityFromMah(name) {
  const m = MAH_RE.exec(name || "");
  return m ? `${m[1].replace(/[,\s]/g, "")}mAh` : null;
}

function mahSortKey(capacity) {
  const m = /(\d+)/.exec(capacity || "");
  return m ? parseInt(m[1], 10) : Infinity;
}

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
    // Photos are a separate file from verbatimMap on purpose - verbatim_pn_map.json
    // gets wholesale-overwritten on every pricelist refresh, which would wipe out
    // photo links if they lived in the same file.
    const productPhotos = (await this._loadDriveJson("product_photos.json")) || {};
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
      const photoEntry = barcodes.map((bc) => productPhotos[bc]).find(Boolean);
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

      const groupKey = verbatimEntry ? `pn:${verbatimFamilyPrefix(verbatimEntry.pn)}` : `upc:${barcodes[0] || r.Id}`;

      return {
        productId: r.Id, name: r.Name, currentPrice: r.Price, barcodes,
        photoThumbUrl: photoEntry ? photoEntry.thumb_url : null,
        photoUrl: photoEntry ? photoEntry.url : null,
        priceHistoryPn: verbatimEntry ? verbatimEntry.pn : null,
        priceHistory,
        invoiceCosts,
        monthly, aroniumStock, reserveQty, combinedStock,
        reserveUpdatedAt: reserveEntry ? reserveEntry.updated_at : null,
        last30Qty: last30.qty, last30Revenue: last30.revenue, daysOfStockLeft,
        signal: signal.type, signalReason: signal.reason, marginPct: signal.marginPct,
        costSource: signal.costSource, costRising: signal.costRising,
        groupKey, capacity: capacityFromMah(r.Name),
        color: verbatimEntry ? cleanVerbatimColor(verbatimEntry.color) : null,
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

  /** Grouped by Verbatim PN family (or the product's own barcode when it
   * has no Verbatim match) - same idea as Memory's list, see the grouping
   * helpers up top. */
  renderList() {
    const el = document.getElementById("powerbank-list");
    if (!this.products.length) {
      el.innerHTML = `<p class="empty-state">No Powerbank-group products found in Aronium.</p>`;
      return;
    }
    const groups = new Map();
    for (const p of this.products) {
      if (!groups.has(p.groupKey)) groups.set(p.groupKey, []);
      groups.get(p.groupKey).push(p);
    }
    const groupList = [...groups.values()].map((items) => {
      items.sort((a, b) => mahSortKey(a.capacity) - mahSortKey(b.capacity) || (a.color || "").localeCompare(b.color || ""));
      const label = items.length > 1
        ? items.slice().sort((a, b) => a.name.length - b.name.length)[0].name
            .replace(MAH_RE, "").replace(/\s{2,}/g, " ").trim()
        : items[0].name;
      const worstRank = Math.max(...items.map((p) => Catalog.signalRank(p.signal)));
      const isVerbatim = items[0].groupKey.startsWith("pn:");
      return { items, label, worstRank, isVerbatim };
    });
    // Convergent/Verbatim stock (a real, current PN match) first - the rest
    // is old stock from other brands/suppliers, per Derrick's own framing.
    groupList.sort((a, b) =>
      (b.isVerbatim - a.isVerbatim) || (b.worstRank - a.worstRank) || a.label.localeCompare(b.label));

    el.innerHTML = groupList.map((g, i) => {
      // One label before the first Verbatim group and one right where it
      // switches to old stock - makes the split visible, not just implicit
      // in the ordering.
      const heading = i === 0
        ? `<h3 class="powerbank-section-heading">${g.isVerbatim ? "Convergent (Verbatim)" : "Other brands - old stock"}</h3>`
        : (g.isVerbatim === false && groupList[i - 1].isVerbatim === true)
          ? `<h3 class="powerbank-section-heading">Other brands - old stock</h3>`
          : "";
      return `
      ${heading}
      <details class="memory-group" ${g.worstRank > 0 ? "open" : ""}>
        <summary>
          <span class="memory-group-label">${escapeHtml(g.label)}</span>
          <span class="memory-group-count">${g.items.length} item${g.items.length > 1 ? "s" : ""}</span>
        </summary>
        ${Catalog.tableHtmlWithRowIds(
          ["", "Photo", "Product", "Capacity", "Color", "Barcode", "Model", "Combined Stock", "Margin", "Signal"],
          g.items.map((p) => [
            p.productId,
            p.photoThumbUrl ? `<img class="product-thumb" src="${p.photoThumbUrl}" alt="">` : `<span class="product-thumb-placeholder">—</span>`,
            escapeHtml(p.name),
            escapeHtml(p.capacity || "—"),
            escapeHtml(p.color || "—"),
            escapeHtml(p.barcodes[0] || "—"),
            escapeHtml(p.priceHistoryPn || "—"),
            `${p.combinedStock} <span class="stock-breakdown">(${p.aroniumStock} shop + ${p.reserveQty} reserve)</span>`,
            p.marginPct != null ? p.marginPct.toFixed(0) + "%" : "—",
            Catalog.signalBadge(p.signal),
          ]),
        )}
      </details>
    `;
    }).join("");

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
        ${p.photoUrl ? `<img class="product-photo-large product-photo-clickable" id="powerbank-photo-large" src="${p.photoUrl}" alt="">` : ""}
        <div>
          <h2>${escapeHtml(p.name)}</h2>
          <p class="detail-barcode">${escapeHtml(p.barcodes.join(", ") || "No barcode on file")}</p>
        </div>
        ${Catalog.signalBadge(p.signal)}
      </div>
      ${p.signalReason ? `<p class="signal-reason">${escapeHtml(p.signalReason)}</p>` : ""}
      <div class="memory-stats">
        <div>
          <span class="stat-label">Verbatim Model</span>
          <span class="stat-value">${p.priceHistoryPn ? escapeHtml(p.priceHistoryPn) : "—"}</span>
          ${lastPricelist && lastPricelist.description ? `<span class="stock-breakdown">${escapeHtml(lastPricelist.description).replace(/\n/g, "<br>")}</span>` : ""}
        </div>
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
    if (p.photoUrl) {
      document.getElementById("powerbank-photo-large").addEventListener("click", () => Catalog.openPhotoLightbox(p.photoUrl));
    }
    document.getElementById("powerbank-detail-modal").classList.remove("hidden");
  },

  closeDetail() {
    document.getElementById("powerbank-detail-modal").classList.add("hidden");
  },
};
