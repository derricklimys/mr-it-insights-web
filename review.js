// Review tab: lists invoices (needs_review first), shows PDF + line items
// side by side, lets Derrick correct fields and confirm.

const Review = {
  invoices: [], // { id, folderId, jsonFileId, pdfFileId, record }
  selectedId: null,

  async load() {
    const listEl = document.getElementById("invoice-list");
    listEl.innerHTML = `<p class="loading">Loading invoices…</p>`;

    const rootId = await Drive.findChild(CONFIG.ROOT_FOLDER, "root", true);
    if (!rootId) throw new Error(`Couldn't find "${CONFIG.ROOT_FOLDER}" in your Drive - has the migration been uploaded yet?`);
    const invoicesId = await Drive.findChild(CONFIG.INVOICES_FOLDER, rootId, true);
    if (!invoicesId) throw new Error(`Couldn't find "${CONFIG.INVOICES_FOLDER}" inside "${CONFIG.ROOT_FOLDER}".`);

    const folders = (await Drive.listChildren(invoicesId)).filter(
      (f) => f.mimeType === "application/vnd.google-apps.folder",
    );

    let loaded = 0;
    const updateProgress = () => {
      loaded += 1;
      listEl.innerHTML = `<p class="loading">Loading invoices… (${loaded}/${folders.length})</p>`;
    };

    // One invoice's folder listing + JSON download is 2 round trips; doing
    // that for all 45 invoices one at a time in series is what made this
    // feel stuck for a minute or two - running them concurrently instead
    // turns ~90 sequential round trips into one wave of parallel ones.
    const results = await Promise.allSettled(
      folders.map(async (folder) => {
        const children = await Drive.listChildren(folder.id);
        const jsonFile = children.find((c) => c.name === "invoice.json");
        const pdfFile = children.find((c) => c.name === "invoice.pdf");
        updateProgress();
        if (!jsonFile) return null;
        const record = JSON.parse(await Drive.downloadText(jsonFile.id));
        return { id: folder.id, folderId: folder.id, jsonFileId: jsonFile.id, pdfFileId: pdfFile ? pdfFile.id : null, record };
      }),
    );

    const invoices = [];
    const failures = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled" && r.value) invoices.push(r.value);
      else if (r.status === "rejected") failures.push(`${folders[i].name}: ${r.reason.message}`);
    }
    if (failures.length) {
      setStatus(`${failures.length} invoice(s) failed to load: ${failures.join("; ")}`, true);
    }

    invoices.sort((a, b) => {
      if (a.record.status !== b.record.status) return a.record.status === "needs_review" ? -1 : 1;
      return (b.record.invoice_date || "").localeCompare(a.record.invoice_date || "");
    });

    this.invoices = invoices;
    this.renderList();
  },

  renderList() {
    const listEl = document.getElementById("invoice-list");
    const needsReview = this.invoices.filter((i) => i.record.status === "needs_review").length;
    document.getElementById("review-count").textContent = needsReview ? `(${needsReview})` : "";

    if (!this.invoices.length) {
      listEl.innerHTML = `<p class="empty-state">No invoices found.</p>`;
      return;
    }

    listEl.innerHTML = this.invoices
      .map((inv) => {
        const r = inv.record;
        const cls = inv.id === this.selectedId ? "invoice-row selected" : "invoice-row";
        return `
        <button class="${cls}" data-id="${inv.id}">
          <span class="badge badge-${r.status}">${r.status === "confirmed" ? "OK" : "review"}</span>
          <span class="inv-main">
            <span class="inv-supplier">${escapeHtml(r.supplier)}</span>
            <span class="inv-meta">${escapeHtml(r.invoice_number)} · ${escapeHtml(r.invoice_date)}</span>
          </span>
        </button>`;
      })
      .join("");

    listEl.querySelectorAll(".invoice-row").forEach((btn) => {
      btn.addEventListener("click", () => this.select(btn.dataset.id));
    });
  },

  async select(id) {
    this.selectedId = id;
    this.renderList();
    const inv = this.invoices.find((i) => i.id === id);
    const detail = document.getElementById("invoice-detail");
    detail.innerHTML = `<p class="loading">Loading…</p>`;

    let pdfUrl = null;
    if (inv.pdfFileId) {
      const blob = await Drive.downloadBlob(inv.pdfFileId);
      pdfUrl = URL.createObjectURL(blob);
    }

    const r = inv.record;
    detail.innerHTML = `
      <div class="detail-header">
        <h2>${escapeHtml(r.supplier)} — ${escapeHtml(r.invoice_number)}</h2>
        <span class="badge badge-${r.status}">${r.status}</span>
      </div>
      <div class="detail-split">
        <div class="pdf-pane">
          ${pdfUrl ? `<iframe src="${pdfUrl}" title="Invoice PDF"></iframe>` : `<p class="empty-state">No PDF found.</p>`}
        </div>
        <div class="lines-pane">
          <div class="lines-table-wrap">
            <table class="lines-table">
              <thead><tr>
                <th>Description</th><th>Match</th><th>Product</th>
                <th>Qty</th><th>Unit Cost</th><th>True Cost</th><th>Conf.</th>
              </tr></thead>
              <tbody id="lines-tbody"></tbody>
            </table>
          </div>
          <div class="detail-actions">
            <button id="save-btn" class="btn btn-primary">Save &amp; Mark Confirmed</button>
            <span id="save-status"></span>
          </div>
        </div>
      </div>`;

    const tbody = document.getElementById("lines-tbody");
    tbody.innerHTML = r.line_items
      .map((li, idx) => {
        const lowConf = (li.confidence ?? 0) < 0.85;
        return `
        <tr class="${lowConf ? "low-confidence" : ""}" data-idx="${idx}">
          <td>${escapeHtml(li.description)}</td>
          <td><input type="text" class="li-match" value="${escapeHtml(li.match_method || "")}"></td>
          <td><input type="text" class="li-product" value="${escapeHtml(li.matched_product_name || "")}"></td>
          <td><input type="number" step="any" class="li-qty" value="${li.quantity ?? ""}"></td>
          <td><input type="number" step="any" class="li-unit" value="${li.unit_price ?? ""}"></td>
          <td><input type="number" step="any" class="li-cost" value="${li.true_cost_incl_gst ?? ""}"></td>
          <td>${li.confidence != null ? li.confidence.toFixed(2) : "—"}</td>
        </tr>`;
      })
      .join("");

    document.getElementById("save-btn").addEventListener("click", () => this.save(inv));
  },

  async save(inv) {
    const saveStatus = document.getElementById("save-status");
    saveStatus.textContent = "Saving…";
    const rows = document.querySelectorAll("#lines-tbody tr");
    rows.forEach((row) => {
      const idx = Number(row.dataset.idx);
      const li = inv.record.line_items[idx];
      li.match_method = row.querySelector(".li-match").value || "manual_review";
      li.matched_product_name = row.querySelector(".li-product").value || null;
      li.quantity = numOrNull(row.querySelector(".li-qty").value);
      li.unit_price = numOrNull(row.querySelector(".li-unit").value);
      li.true_cost_incl_gst = numOrNull(row.querySelector(".li-cost").value);
      li.confidence = 1.0; // human-reviewed
    });
    inv.record.status = "confirmed";
    inv.record.reviewed_at = new Date().toISOString();

    try {
      await Drive.updateContent(inv.jsonFileId, JSON.stringify(inv.record, null, 2), "application/json");
      saveStatus.textContent = "Saved.";
      this.renderList();
    } catch (e) {
      saveStatus.textContent = "Save failed: " + e.message;
    }
  },
};

function numOrNull(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
