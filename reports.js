// Reports tab: loads confirmed invoice records + the Aronium DB (read
// client-side via sql.js, no backend) and computes margin / cost-trend /
// red-flag reports - the same logic already validated in
// Invoice_Cost_Reconciliation.xlsx, now live instead of a static export.

const Reports = {
  db: null,
  loaded: false,

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
        return { name: p.Name, group: p.GroupName, cost: li.true_cost_incl_gst, price: p.Price, marginDollar, marginPct, date: li.invoice_date };
      })
      .filter(Boolean)
      .sort((a, b) => a.marginPct - b.marginPct);

    const el = document.getElementById("report-margin");
    if (!rows.length) {
      el.innerHTML = `<p class="empty-state">No confirmed invoices with matched products yet.</p>`;
      return;
    }
    el.innerHTML = tableHtml(
      ["Product", "Group", "Last Cost", "Current Price", "Margin $", "Margin %", "As of"],
      rows.map((r) => [r.name, r.group || "", money(r.cost), money(r.price), money(r.marginDollar), r.marginPct.toFixed(1) + "%", r.date]),
    );
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
        lines.sort((a, b) => a.invoice_date.localeCompare(b.invoice_date));
        const points = lines.map((l) => `${l.invoice_date}: ${money(l.true_cost_incl_gst)} (${l.supplier})`).join(" &rarr; ");
        return `<div class="trend-row"><strong>${escapeHtml(p ? p.Name : productId)}</strong><div class="trend-points">${points}</div></div>`;
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

function money(n) {
  return n == null ? "—" : "$" + n.toFixed(2);
}

function tableHtml(headers, rows) {
  return `<table class="report-table">
    <thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>
  </table>`;
}
