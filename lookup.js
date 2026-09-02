// Lookup tab: search any Aronium product by name or barcode (one at a time,
// or paste a whole batch of barcodes at once) and see its stock, full sales
// history, and every invoice it was ever bought on - the web counterpart to
// the phone app's Lookup tab, plus batch search for evaluating a supplier's
// price-support list against Derrick's own sales history in one pass.

const Lookup = {
  latestDataDate: null,

  async ensureLoaded() {
    await Reports.ensureLoaded();
    if (!this.latestDataDate) {
      const row = Reports.query("SELECT MAX(Date) as d FROM Document")[0];
      this.latestDataDate = row ? row.d : null;
    }
  },

  findByBarcode(barcode) {
    const rows = Reports.query(
      `SELECT p.Id as pid, p.Name as name, pg.Name as groupName, p.Price as price
       FROM Barcode b JOIN Product p ON p.Id = b.ProductId
       LEFT JOIN ProductGroup pg ON pg.Id = p.ProductGroupId
       WHERE b.Value = ?`,
      [barcode],
    );
    return rows[0] || null;
  },

  searchByName(term, limit = 30) {
    return Reports.query(
      `SELECT p.Id as pid, p.Name as name, pg.Name as groupName,
              (SELECT GROUP_CONCAT(b.Value, ', ') FROM Barcode b WHERE b.ProductId = p.Id) as barcodes
       FROM Product p LEFT JOIN ProductGroup pg ON pg.Id = p.ProductGroupId
       WHERE p.IsEnabled = 1 AND p.Name LIKE ? COLLATE NOCASE
       ORDER BY p.Name LIMIT ?`,
      [`%${term}%`, limit],
    );
  },

  productDetail(productId) {
    const rows = Reports.query(
      `SELECT p.Id as pid, p.Name as name, p.Price as price, pg.Name as groupName,
              (SELECT GROUP_CONCAT(b.Value, ', ') FROM Barcode b WHERE b.ProductId = p.Id) as barcodes
       FROM Product p LEFT JOIN ProductGroup pg ON pg.Id = p.ProductGroupId
       WHERE p.Id = ?`,
      [productId],
    );
    return rows[0] || null;
  },

  /** Stock exactly as Aronium has it - shown as-is, even if it looks wrong. */
  stockFor(productId) {
    const row = Reports.query("SELECT COALESCE(SUM(Quantity), 0) as stock FROM Stock WHERE ProductId = ?", [productId])[0];
    return row ? row.stock : 0;
  },

  salesSummary(productId) {
    const row = Reports.query(
      `SELECT MAX(date(d.Date)) as lastSale, SUM(di.Quantity) as totalQty, COUNT(*) as txns
       FROM DocumentItem di JOIN Document d ON d.Id = di.DocumentId
       WHERE di.ProductId = ? AND d.DocumentTypeId = 2`,
      [productId],
    )[0];
    const daysSinceLastSale = row && row.lastSale && this.latestDataDate
      ? Math.round((new Date(this.latestDataDate) - new Date(row.lastSale)) / 86400000)
      : null;
    return {
      lastSale: row ? row.lastSale : null,
      totalQty: row && row.totalQty ? row.totalQty : 0,
      txns: row ? row.txns : 0,
      daysSinceLastSale,
    };
  },

  salesHistory(productId) {
    return Reports.query(
      `SELECT date(d.Date) as date, d.Number as docNumber, d.DocumentTypeId as docType,
              di.Quantity as qty, di.Price as price, di.Total as total
       FROM DocumentItem di JOIN Document d ON d.Id = di.DocumentId
       WHERE di.ProductId = ? AND d.DocumentTypeId IN (2, 4)
       ORDER BY d.Date DESC, d.Id DESC`,
      [productId],
    );
  },

  purchaseHistory(productId) {
    return Reports.confirmedLines
      .filter((li) => li.matched_product_id === productId)
      .sort((a, b) => b.invoice_date.localeCompare(a.invoice_date));
  },

  // --- Single search -------------------------------------------------

  renderSearchPanel() {
    const el = document.getElementById("lookup-search");
    el.innerHTML = `
      <div class="lookup-searchbar">
        <input type="text" id="lookup-search-input" placeholder="Search by name or barcode...">
      </div>
      <div id="lookup-search-results"></div>
    `;
    const input = document.getElementById("lookup-search-input");
    input.addEventListener("input", () => this._renderSearchResults(input.value));
  },

  _renderSearchResults(term) {
    const resultsEl = document.getElementById("lookup-search-results");
    term = (term || "").trim();
    if (!term) { resultsEl.innerHTML = ""; return; }

    const barcodeHit = /^\d+$/.test(term) ? this.findByBarcode(term) : null;
    const nameHits = this.searchByName(term).filter((r) => !barcodeHit || r.pid !== barcodeHit.pid);

    if (!barcodeHit && !nameHits.length) {
      resultsEl.innerHTML = `<p class="empty-state">No matching product found.</p>`;
      return;
    }

    const rows = [];
    if (barcodeHit) rows.push({ pid: barcodeHit.pid, name: barcodeHit.name, groupName: barcodeHit.groupName, barcodes: term, matchLabel: "Barcode match" });
    for (const r of nameHits) rows.push({ ...r, matchLabel: null });

    resultsEl.innerHTML = `<div class="lookup-result-list">${rows.map((r) => `
      <div class="lookup-result-card" data-id="${r.pid}">
        ${r.matchLabel ? `<div class="lookup-match-label">${r.matchLabel}</div>` : ""}
        <div class="lookup-result-name">${escapeHtml(r.name)}</div>
        <div class="insight-barcode">${escapeHtml(r.barcodes || "")}</div>
        ${r.groupName ? `<div class="insight-barcode">${escapeHtml(r.groupName)}</div>` : ""}
      </div>
    `).join("")}</div>`;
    resultsEl.querySelectorAll(".lookup-result-card").forEach((card) => {
      card.addEventListener("click", () => this.showDetail(Number(card.dataset.id)));
    });
  },

  // --- Batch search ----------------------------------------------------

  renderBatchPanel() {
    const el = document.getElementById("lookup-batch");
    el.innerHTML = `
      <p class="report-status">Paste a list of barcodes (one per line, or separated by commas/spaces/tabs) - handy for checking a supplier's price-support list against your own sales history before deciding what to stock up on.</p>
      <textarea id="lookup-batch-input" rows="6" placeholder="619659199524&#10;619659188481&#10;619659189655"></textarea>
      <button id="lookup-batch-btn" class="btn btn-primary">Look up all</button>
      <div id="lookup-batch-results"></div>
    `;
    document.getElementById("lookup-batch-btn").addEventListener("click", () => this._runBatchSearch());
  },

  _runBatchSearch() {
    const raw = document.getElementById("lookup-batch-input").value;
    const barcodes = [...new Set(raw.split(/[^0-9]+/).filter(Boolean))];
    const resultsEl = document.getElementById("lookup-batch-results");

    if (!barcodes.length) {
      resultsEl.innerHTML = `<p class="empty-state">Paste at least one barcode above.</p>`;
      return;
    }

    const rows = barcodes.map((bc) => {
      const product = this.findByBarcode(bc);
      if (!product) return { barcode: bc, notFound: true };
      const summary = this.salesSummary(product.pid);
      return { barcode: bc, pid: product.pid, name: product.name, groupName: product.groupName, stock: this.stockFor(product.pid), ...summary };
    });

    const found = rows.filter((r) => !r.notFound);
    const notFound = rows.filter((r) => r.notFound);

    let html = "";
    if (found.length) {
      html += `<table class="report-table lookup-batch-table">
        <thead><tr><th>Barcode</th><th>Product</th><th>Stock</th><th>Last Sale</th><th>Days Ago</th><th>Total Sold</th></tr></thead>
        <tbody>${found
          .sort((a, b) => (b.daysSinceLastSale ?? -1) - (a.daysSinceLastSale ?? -1))
          .map((r) => `
          <tr data-id="${r.pid}" class="lookup-batch-row">
            <td>${escapeHtml(r.barcode)}</td>
            <td>${escapeHtml(r.name)}</td>
            <td>${r.stock}</td>
            <td>${r.lastSale || "Never sold"}</td>
            <td>${r.daysSinceLastSale != null ? r.daysSinceLastSale : "—"}</td>
            <td>${r.totalQty}</td>
          </tr>`).join("")}</tbody>
      </table>`;
    }
    if (notFound.length) {
      html += `<p class="empty-state">Not found in your Aronium catalog: ${notFound.map((r) => escapeHtml(r.barcode)).join(", ")}</p>`;
    }
    resultsEl.innerHTML = html;
    resultsEl.querySelectorAll(".lookup-batch-row").forEach((row) => {
      row.addEventListener("click", () => this.showDetail(Number(row.dataset.id)));
    });
  },

  // --- Detail modal (shared by both single and batch search) -----------

  showDetail(productId) {
    const p = this.productDetail(productId);
    const modal = document.getElementById("lookup-detail-modal");
    const body = document.getElementById("lookup-detail-body");
    if (!p) { body.innerHTML = `<p class="empty-state">Product not found.</p>`; modal.classList.remove("hidden"); return; }

    const stock = this.stockFor(productId);
    const summary = this.salesSummary(productId);
    const history = this.salesHistory(productId);
    const purchases = this.purchaseHistory(productId);

    body.innerHTML = `
      <h2>${escapeHtml(p.name)}</h2>
      <p class="detail-barcode">${escapeHtml(p.barcodes || "No barcode on file")}</p>
      ${p.groupName ? `<p class="detail-barcode">${escapeHtml(p.groupName)}</p>` : ""}
      <div class="memory-stats">
        <div><span class="stat-label">Stock (Aronium)</span><span class="stat-value">${stock}</span></div>
        <div><span class="stat-label">Price</span><span class="stat-value">${money(p.price)}</span></div>
        <div><span class="stat-label">Last Sale</span><span class="stat-value">${summary.lastSale || "Never"}</span></div>
        <div><span class="stat-label">Total Sold</span><span class="stat-value">${summary.totalQty}</span></div>
      </div>
      <h3>Sales History</h3>
      ${history.length ? tableHtml(
        ["Date", "Receipt #", "Qty", "Unit Price", "Total"],
        history.map((h) => [
          h.date + (h.docType === 4 ? " (Refund)" : ""),
          h.docNumber,
          h.qty,
          money(h.price),
          money(h.total),
        ]),
      ) : `<p class="empty-state">No sales recorded.</p>`}
      <h3>Purchase History</h3>
      ${purchases.length ? `<table class="report-table">
        <thead><tr><th>Supplier</th><th>Invoice</th><th>Date</th><th>Qty</th><th>Cost</th></tr></thead>
        <tbody>${purchases.map((li) => `
          <tr class="lookup-purchase-row" data-invoice-id="${li.invoice_id}">
            <td>${escapeHtml(li.supplier || "")}</td>
            <td>${escapeHtml(li.invoice_number || "")}</td>
            <td>${escapeHtml(li.invoice_date || "")}</td>
            <td>${li.quantity != null ? li.quantity : "—"}</td>
            <td>${money(li.true_cost_incl_gst)}</td>
          </tr>`).join("")}</tbody>
      </table>` : `<p class="empty-state">No invoice purchases matched to this product yet.</p>`}
    `;
    body.querySelectorAll(".lookup-purchase-row").forEach((row) => {
      row.addEventListener("click", () => {
        const invoiceId = row.dataset.invoiceId;
        modal.classList.add("hidden");
        switchTab("review");
        Review.select(invoiceId);
      });
    });
    modal.classList.remove("hidden");
  },

  closeDetail() {
    document.getElementById("lookup-detail-modal").classList.add("hidden");
  },
};
