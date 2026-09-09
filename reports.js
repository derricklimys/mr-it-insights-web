// Reports tab: loads confirmed invoice records + the Aronium DB (read
// client-side via sql.js, no backend) and computes margin / cost-trend /
// red-flag reports - the same logic already validated in
// Invoice_Cost_Reconciliation.xlsx, now live instead of a static export.

const Reports = {
  db: null,
  loaded: false,
  lastSyncedAt: null,

  /** Forces a fresh pull of the Aronium DB from Drive, bypassing the
   * loaded-once guard - used by the header Sync button. Callers are
   * responsible for resetting any dependent module's own cache (Memory,
   * Sales) so they recompute against the fresh db next time they render. */
  async forceReload() {
    this.loaded = false;
    this.db = null;
    await this.ensureLoaded();
  },

  async ensureLoaded() {
    if (this.loaded) return;
    const statusEl = document.getElementById("report-status");

    statusEl.textContent = "Loading Aronium database…";
    const dbFolderId = await Drive.findFolderAnywhere(CONFIG.ARONIUM_FOLDER);
    if (!dbFolderId) throw new Error(`Couldn't find "${CONFIG.ARONIUM_FOLDER}" - is it shared with this Google account?`);
    const dbFileId = await Drive.findChild(CONFIG.ARONIUM_DB_FILE, dbFolderId);
    if (!dbFileId) throw new Error(`Couldn't find "${CONFIG.ARONIUM_DB_FILE}" inside "${CONFIG.ARONIUM_FOLDER}".`);
    const dbBlob = await Drive.downloadBlob(dbFileId);
    const dbBuffer = new Uint8Array(await dbBlob.arrayBuffer());

    statusEl.textContent = "Reading confirmed invoices…";
    const SQL = await initSqlJs({ locateFile: (f) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}` });
    this.db = new SQL.Database(dbBuffer);

    this.confirmedLines = [];
    for (const inv of Review.invoices) {
      if (inv.record.status !== "confirmed") continue;
      for (const li of inv.record.line_items) {
        if (li.matched_product_id) {
          this.confirmedLines.push({
            ...li,
            invoice_date: inv.record.invoice_date,
            supplier: inv.record.supplier,
            invoice_id: inv.id,
            invoice_number: inv.record.invoice_number,
          });
        }
      }
    }

    this.loaded = true;
    statusEl.textContent = "";
    this.lastSyncedAt = new Date();
    const syncStatusEl = document.getElementById("sync-status");
    if (syncStatusEl) syncStatusEl.textContent = `Data as of ${formatSyncTime(this.lastSyncedAt)}`;
  },

  query(sql, params = []) {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  },

  productInfo(productId) {
    const rows = this.query(
      "SELECT p.Name, p.Price, pg.Name as GroupName FROM Product p LEFT JOIN ProductGroup pg ON pg.Id = p.ProductGroupId WHERE p.Id = ?",
      [productId],
    );
    return rows[0] || null;
  },

  barcodeFor(productId) {
    const rows = this.query("SELECT Value FROM Barcode WHERE ProductId = ? LIMIT 1", [productId]);
    return rows[0] ? rows[0].Value : null;
  },

  salesFor(productId) {
    const rows = this.query(
      `SELECT SUM(di.Quantity) as qty, MAX(date(d.Date)) as last_sale
       FROM DocumentItem di JOIN Document d ON d.Id = di.DocumentId
       WHERE d.DocumentTypeId = 2 AND di.ProductId = ?`,
      [productId],
    );
    return rows[0] || { qty: null, last_sale: null };
  },

  async renderMargin() {
    await this.ensureLoaded();
    // Most recent cost per product
    const latestByProduct = new Map();
    for (const li of this.confirmedLines) {
      const existing = latestByProduct.get(li.matched_product_id);
      if (!existing || li.invoice_date > existing.invoice_date) latestByProduct.set(li.matched_product_id, li);
    }

    const rows = [...latestByProduct.values()]
      .map((li) => {
        const p = this.productInfo(li.matched_product_id);
        if (!p || !p.Price) return null;
        const marginDollar = p.Price - li.true_cost_incl_gst;
        const marginPct = (marginDollar / p.Price) * 100;
        return {
          name: p.Name, group: p.GroupName, cost: li.true_cost_incl_gst, price: p.Price, marginDollar, marginPct, date: li.invoice_date,
          barcode: this.barcodeFor(li.matched_product_id),
          invoiceId: li.invoice_id, invoiceNumber: li.invoice_number, supplier: li.supplier,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.marginPct - b.marginPct);

    const el = document.getElementById("report-margin");
    if (!rows.length) {
      el.innerHTML = `<p class="empty-state">No confirmed invoices with matched products yet.</p>`;
      return;
    }
    // Custom markup instead of the plain tableHtml() helper - each row needs
    // to be clickable (jump to the source invoice on Review/Invoices) so
    // Derrick can verify a suspicious margin against the actual scanned
    // invoice, not just trust the extracted number.
    el.innerHTML = `<table class="report-table">
      <thead><tr>${["Product", "Group", "Barcode", "Last Cost", "Current Price", "Margin $", "Margin %", "Invoice", "As of"].map((h) => `<th>${h}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `
        <tr class="report-row-linked" data-invoice-id="${r.invoiceId}" title="Click to view the source invoice">
          <td>${escapeHtml(r.name)}</td>
          <td>${escapeHtml(r.group || "")}</td>
          <td>${escapeHtml(r.barcode || "—")}</td>
          <td>${money(r.cost)}</td>
          <td>${money(r.price)}</td>
          <td>${money(r.marginDollar)}</td>
          <td>${r.marginPct.toFixed(1)}%</td>
          <td>${escapeHtml(r.supplier || "")} ${escapeHtml(r.invoiceNumber || "")}</td>
          <td>${r.date}</td>
        </tr>`).join("")}</tbody>
    </table>`;
    el.querySelectorAll(".report-row-linked").forEach((row) => {
      row.addEventListener("click", () => {
        switchTab("review");
        Review.select(row.dataset.invoiceId);
      });
    });
  },

  async renderTrend() {
    await this.ensureLoaded();
    const byProduct = new Map();
    for (const li of this.confirmedLines) {
      if (!byProduct.has(li.matched_product_id)) byProduct.set(li.matched_product_id, []);
      byProduct.get(li.matched_product_id).push(li);
    }

    const el = document.getElementById("report-trend");
    const sections = [...byProduct.entries()]
      .filter(([, lines]) => lines.length > 1)
      .map(([productId, lines]) => {
        const p = this.productInfo(productId);
        const barcode = this.barcodeFor(productId);
        lines.sort((a, b) => a.invoice_date.localeCompare(b.invoice_date));
        // Bold + color each cost against the one before it, so a rising or
        // falling trend reads at a glance instead of needing to compare
        // numbers by eye - red for a cost increase, blue for a decrease.
        const points = lines.map((l, i) => {
          let cls = "";
          if (i > 0) {
            const prev = lines[i - 1].true_cost_incl_gst;
            if (l.true_cost_incl_gst > prev) cls = "cost-up";
            else if (l.true_cost_incl_gst < prev) cls = "cost-down";
          }
          return `${l.invoice_date}: <strong class="${cls}">${money(l.true_cost_incl_gst)}</strong> (${l.supplier})`;
        }).join(" &rarr; ");
        return `<div class="trend-row">
          <strong>${escapeHtml(p ? p.Name : productId)}</strong>
          ${barcode ? `<span class="trend-barcode">${escapeHtml(barcode)}</span>` : ""}
          <div class="trend-points">${points}</div>
        </div>`;
      });

    el.innerHTML = sections.length
      ? sections.join("")
      : `<p class="empty-state">No product has been bought more than once across confirmed invoices yet.</p>`;
  },

  async renderRedFlag() {
    await this.ensureLoaded();
    const byProduct = new Map();
    for (const li of this.confirmedLines) {
      if (!byProduct.has(li.matched_product_id)) {
        byProduct.set(li.matched_product_id, { qtyBought: 0, cost: 0, dates: [] });
      }
      const agg = byProduct.get(li.matched_product_id);
      agg.qtyBought += li.quantity || 0;
      agg.cost += (li.true_cost_incl_gst || 0) * (li.quantity || 0);
      agg.dates.push(li.invoice_date);
    }

    const rows = [...byProduct.entries()]
      .map(([productId, agg]) => {
        const p = this.productInfo(productId);
        const sales = this.salesFor(productId);
        if (sales.qty && sales.qty > 0) return null; // has sold - not a red flag
        return { name: p ? p.Name : productId, group: p ? p.GroupName : "", qtyBought: agg.qtyBought, cost: agg.cost, lastPurchase: agg.dates.sort().at(-1) };
      })
      .filter(Boolean)
      .sort((a, b) => b.cost - a.cost);

    const el = document.getElementById("report-redflag");
    el.innerHTML = rows.length
      ? tableHtml(
          ["Product", "Group", "Qty Bought", "Total Cost", "Last Purchase"],
          rows.map((r) => [r.name, r.group || "", r.qtyBought, money(r.cost), r.lastPurchase]),
        )
      : `<p class="empty-state">Nothing flagged - every confirmed purchase has at least one matching sale.</p>`;
  },
};

function formatSyncTime(d) {
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function money(n) {
  return n == null ? "—" : "$" + n.toFixed(2);
}

function tableHtml(headers, rows) {
  return `<table class="report-table">
    <thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>
  </table>`;
}
