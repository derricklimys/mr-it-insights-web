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
      const aroniumStock = stockByProduct[r.Id] || 0;
      const reserveQty = reserveEntry ? reserveEntry.quantity : 0;
      const invoiceCosts = invoiceCostsByProduct[r.Id] || [];
      const combinedStock = aroniumStock + reserveQty;
      const last30 = last30ByProduct[r.Id] || { qty: 0, revenue: 0 };
      const daysOfStockLeft = last30.qty > 0 ? combinedStock / (last30.qty / 30) : null;

      const signal = computeSignal({
        currentPrice: r.Price,
        priceHistory: priceMatch ? priceMatch.entries : null,
        invoiceCosts,
        monthly,
        combinedStock,
      });

      return {
        productId: r.Id, name: r.Name, currentPrice: r.Price, barcodes,
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
    this.products.sort((a, b) => signalRank(b.signal) - signalRank(a.signal));

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
    el.innerHTML = tableHtmlWithRowIds(
      ["", "Product", "Barcode", "Combined Stock", "Margin", "Signal"],
      this.products.map((p) => [
        p.productId,
        escapeHtml(p.name),
        escapeHtml(p.barcodes[0] || "—"),
        `${p.combinedStock} <span class="stock-breakdown">(${p.aroniumStock} shop + ${p.reserveQty} reserve)</span>`,
        p.marginPct != null ? p.marginPct.toFixed(0) + "%" : "—",
        signalBadge(p.signal),
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

    el.innerHTML = `
      <div class="detail-header">
        <div>
          <h2>${escapeHtml(p.name)}</h2>
          <p class="detail-barcode">${escapeHtml(p.barcodes.join(", ") || "No barcode on file")}</p>
        </div>
        ${signalBadge(p.signal)}
      </div>
      ${p.signalReason ? `<p class="signal-reason">${escapeHtml(p.signalReason)}</p>` : ""}
      <div class="memory-stats">
        <div><span class="stat-label">Shop floor stock</span><span class="stat-value">${p.aroniumStock}</span></div>
        <div><span class="stat-label">Reserve stock</span><span class="stat-value">${p.reserveQty}</span></div>
        <div><span class="stat-label">Sold, last 30 days</span><span class="stat-value">${p.last30Qty}</span></div>
        <div><span class="stat-label">Days of stock left</span><span class="stat-value">${p.daysOfStockLeft != null ? Math.round(p.daysOfStockLeft) : "—"}</span></div>
        <div><span class="stat-label">Current price</span><span class="stat-value">${money(p.currentPrice)}</span></div>
        <div><span class="stat-label">Margin</span><span class="stat-value">${p.marginPct != null ? p.marginPct.toFixed(0) + "%" : "—"}</span></div>
      </div>
      <p class="cost-source-note">${costSourceNote(p)}</p>
      <canvas id="memory-chart" width="900" height="320"></canvas>
    `;
    drawChart(document.getElementById("memory-chart"), p);
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

function signalRank(signal) {
  return signal === "stock-up" ? 2 : signal === "reprice" ? 1 : 0;
}

function costSourceNote(p) {
  const n = p.invoiceCosts.length;
  if (n >= 2) return `Cost and margin are based on ${n} of your actual invoices - the most accurate source.`;
  if (n === 1) return `Cost is your one actual invoice for this product; the trend direction is filled in from the pricelist since one invoice alone can't show a trend.`;
  if (p.priceHistoryPn) return `No invoice for this product yet - cost is estimated from Convergent's pricelist (their quote, not necessarily what you'd actually pay).`;
  return `No cost data available for this product yet.`;
}

function signalBadge(signal) {
  const label = signal === "stock-up" ? "Stock up" : signal === "reprice" ? "Reprice" : "Normal";
  return `<span class="badge signal-${signal}">${label}</span>`;
}

const GST_RATE = 1.09;

// Estimates what he actually pays from the pricelist alone, since he
// negotiates below the printed Dealer price - calibrated against his real
// invoice prices earlier: exactly the Special price when shown, else ~95%
// of Dealer. Only used as a fallback where no real invoice cost exists.
function estimateCostFromPricelist(entry) {
  const raw = entry.special_price != null ? entry.special_price : entry.dealer_price * 0.95;
  return raw * GST_RATE;
}

function computeSignal({ currentPrice, priceHistory, invoiceCosts, monthly, combinedStock }) {
  let velocityDrop = false;
  let recentQty = 0;
  if (monthly.length >= 4) {
    const last = monthly[monthly.length - 1];
    recentQty = last.qty || 0;
    const trailing = monthly.slice(-7, -1);
    const trailingAvg = trailing.reduce((s, m) => s + (m.qty || 0), 0) / Math.max(trailing.length, 1);
    if (trailingAvg > 0 && recentQty < trailingAvg * 0.5) velocityDrop = true;
  }

  let costRising = false;
  let estCost = null;
  let costSource = null;
  if (invoiceCosts && invoiceCosts.length >= 2) {
    // Real paid cost, most accurate - trend from actual invoices.
    const last = invoiceCosts[invoiceCosts.length - 1];
    const priorAvg = invoiceCosts.slice(0, -1).reduce((s, e) => s + e.cost, 0) / (invoiceCosts.length - 1);
    estCost = last.cost;
    costRising = last.cost > priorAvg * 1.05;
    costSource = "invoice";
  } else if (invoiceCosts && invoiceCosts.length === 1) {
    // One real data point - use it for the cost itself, but there's not
    // enough of a trend to call rising/falling from invoices alone, so
    // borrow the pricelist's direction if we have one.
    estCost = invoiceCosts[0].cost;
    costSource = "invoice";
    if (priceHistory && priceHistory.length >= 2) {
      const last = priceHistory[priceHistory.length - 1];
      const prior = priceHistory[Math.max(0, priceHistory.length - 4)];
      costRising = last.dealer_price > prior.dealer_price * 1.05;
    }
  } else if (priceHistory && priceHistory.length >= 2) {
    const last = priceHistory[priceHistory.length - 1];
    const prior = priceHistory[Math.max(0, priceHistory.length - 4)];
    estCost = estimateCostFromPricelist(last);
    costRising = last.dealer_price > prior.dealer_price * 1.05;
    costSource = "pricelist";
  }

  const marginPct = estCost != null && currentPrice > 0 ? ((currentPrice - estCost) / currentPrice) * 100 : null;

  if (velocityDrop) {
    return {
      type: "reprice", marginPct, costSource, costRising,
      reason: `Sales dropped to ${recentQty}/mo, well below its own recent average - the current price may be too high to move it at the old pace.`,
    };
  }
  if (costRising && marginPct != null && marginPct > 15 && combinedStock < Math.max(recentQty, 1) * 1.5) {
    return {
      type: "stock-up", marginPct, costSource, costRising,
      reason: `Cost has been trending up and combined stock is thin relative to recent sales pace - margin is still healthy at ${marginPct.toFixed(0)}%.`,
    };
  }
  if (marginPct != null && marginPct < 8) {
    return {
      type: "reprice", marginPct, costSource, costRising,
      reason: `Margin has thinned to ${marginPct.toFixed(0)}% as cost rose - worth checking if the selling price needs adjusting.`,
    };
  }
  return { type: "normal", marginPct, costSource, costRising, reason: "" };
}

function drawChart(canvas, product) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  const padL = 60, padR = 60, padT = 20, padB = 30;
  ctx.clearRect(0, 0, w, h);

  const months = product.monthly.map((m) => m.ym);
  if (!months.length) {
    ctx.fillStyle = "#7B8190";
    ctx.fillText("No sales history for this product yet.", padL, h / 2);
    return;
  }

  const sellPrices = product.monthly.map((m) => m.avgPrice || 0);
  const qtys = product.monthly.map((m) => m.qty || 0);

  // Real invoice cost wins wherever it exists for a given month; the
  // pricelist only fills months before any invoice data is available.
  const invoiceIsReal = [];
  const costByMonth = months.map((ym) => {
    const invoiceMatches = product.invoiceCosts.filter((e) => e.date.slice(0, 7) <= ym);
    if (invoiceMatches.length) {
      invoiceIsReal.push(true);
      return invoiceMatches[invoiceMatches.length - 1].cost;
    }
    invoiceIsReal.push(false);
    const priceMatches = product.priceHistory.filter((e) => e.date.slice(0, 7) <= ym);
    if (!priceMatches.length) return null;
    return estimateCostFromPricelist(priceMatches[priceMatches.length - 1]);
  });

  const maxPrice = Math.max(...sellPrices, ...costByMonth.filter((v) => v != null), 1) * 1.15;
  const maxQty = Math.max(...qtys, 1) * 1.3;

  const x = (i) => padL + (i / Math.max(months.length - 1, 1)) * (w - padL - padR);
  const yPrice = (v) => padT + (1 - v / maxPrice) * (h - padT - padB);
  const yQty = (v) => padT + (1 - v / maxQty) * (h - padT - padB);

  // axes
  ctx.strokeStyle = "#D8DCD6";
  ctx.beginPath();
  ctx.moveTo(padL, padT); ctx.lineTo(padL, h - padB); ctx.lineTo(w - padR, h - padB);
  ctx.stroke();

  // qty bars
  ctx.fillStyle = "#E8DBBB";
  const barW = Math.max((w - padL - padR) / months.length - 6, 4);
  qtys.forEach((q, i) => {
    const bx = x(i) - barW / 2;
    const by = yQty(q);
    ctx.fillRect(bx, by, barW, h - padB - by);
  });

  function line(values, color, markReal) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    values.forEach((v, i) => {
      if (v == null) return;
      const px = x(i), py = yPrice(v);
      if (!started) { ctx.moveTo(px, py); started = true; } else { ctx.lineTo(px, py); }
    });
    ctx.stroke();
    if (markReal) {
      // Filled dot = a month backed by a real invoice cost; hollow dot =
      // filled in from the pricelist estimate because no invoice covers it.
      values.forEach((v, i) => {
        if (v == null) return;
        const px = x(i), py = yPrice(v);
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        if (invoiceIsReal[i]) {
          ctx.fillStyle = color;
          ctx.fill();
        } else {
          ctx.fillStyle = "#FBFBF9";
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      });
    }
  }
  line(sellPrices, "#3F6B4F");
  line(costByMonth, "#A23B3B", true);

  // month labels (sparse)
  ctx.fillStyle = "#7B8190";
  ctx.font = "10px sans-serif";
  const step = Math.ceil(months.length / 10);
  months.forEach((m, i) => {
    if (i % step === 0) ctx.fillText(m, x(i) - 14, h - 10);
  });

  // legend
  ctx.fillStyle = "#3F6B4F"; ctx.fillRect(padL, 4, 10, 10);
  ctx.fillStyle = "#1B2028"; ctx.fillText("Your selling price", padL + 14, 13);
  ctx.fillStyle = "#A23B3B"; ctx.fillRect(padL + 130, 4, 10, 10);
  ctx.fillStyle = "#1B2028"; ctx.fillText("Cost (● invoice, ○ pricelist est.)", padL + 144, 13);
  ctx.fillStyle = "#E8DBBB"; ctx.fillRect(padL + 340, 4, 10, 10);
  ctx.fillStyle = "#1B2028"; ctx.fillText("Units sold", padL + 354, 13);

  attachChartTooltip(canvas, { months, qtys, sellPrices, costByMonth, invoiceIsReal, x, padL, padR, w, barW });
}

// Hover-only detail so the chart itself stays uncluttered - move over a bar
// or point to see that month's exact numbers instead of guessing from pixels.
function attachChartTooltip(canvas, { months, qtys, sellPrices, costByMonth, invoiceIsReal, x, padL, padR, w, barW }) {
  let tooltip = document.getElementById("memory-chart-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "memory-chart-tooltip";
    tooltip.className = "chart-tooltip hidden";
    document.body.appendChild(tooltip);
  }

  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const mx = (e.clientX - rect.left) * scaleX;

    let idx = Math.round(((mx - padL) / Math.max(w - padL - padR, 1)) * Math.max(months.length - 1, 1));
    idx = Math.max(0, Math.min(months.length - 1, idx));
    if (Math.abs(mx - x(idx)) > barW / 2 + 16) {
      tooltip.classList.add("hidden");
      return;
    }

    const costNote = costByMonth[idx] != null
      ? `<br>Cost: ${money(costByMonth[idx])} ${invoiceIsReal[idx] ? "(invoice)" : "(pricelist est.)"}`
      : "";
    tooltip.innerHTML =
      `<strong>${months[idx]}</strong><br>` +
      `Units sold: ${qtys[idx]}<br>` +
      `Avg selling price: ${money(sellPrices[idx] || 0)}` +
      costNote;
    tooltip.style.left = e.clientX + 14 + "px";
    tooltip.style.top = e.clientY + 14 + "px";
    tooltip.classList.remove("hidden");
  };
  canvas.onmouseleave = () => tooltip.classList.add("hidden");
}

function tableHtmlWithRowIds(headers, rows) {
  return `<table class="report-table memory-table">
    <thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr data-id="${r[0]}">${r.slice(1).map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>
  </table>`;
}
