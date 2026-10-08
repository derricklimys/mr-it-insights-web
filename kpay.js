// KPay Check tab: reconciles KPay's monthly statements against the Aronium POS (and, optionally,
// the staff's daily settlement sheet). The matching itself lives in kpay-core.js; this file only
// reads the files, loads Aronium + roster data, and draws the results.
//
// Nothing is uploaded anywhere: the statement and settlement files are read in the browser.

const KPayCheck = {
  statementFiles: [],
  invoiceFiles: [],
  invoiceTally: null,
  charges: null,
  settlementFile: null,
  result: null,
  settlement: null,
  rosterNote: "",
  bound: false,

  render() {
    if (this.bound) return;
    this.bound = true;
    document.getElementById("kpay-statements-input").addEventListener("change", (e) => {
      this.statementFiles = [...e.target.files];
      document.getElementById("kpay-statements-names").textContent = this.statementFiles.map((f) => f.name).join(", ");
    });
    document.getElementById("kpay-invoices-input").addEventListener("change", (e) => {
      this.invoiceFiles = [...e.target.files];
      document.getElementById("kpay-invoices-names").textContent = this.invoiceFiles.map((f) => f.name).join(", ");
    });
    document.getElementById("kpay-settlement-input").addEventListener("change", (e) => {
      this.settlementFile = e.target.files[0] || null;
      document.getElementById("kpay-settlement-name").textContent = this.settlementFile ? this.settlementFile.name : "";
    });
    document.getElementById("kpay-run-btn").addEventListener("click", () => this.run());
    document.getElementById("kpay-download-btn").addEventListener("click", () => this.download());
  },

  setStatus(text, isError = false) {
    const el = document.getElementById("kpay-status");
    el.textContent = text;
    el.classList.toggle("kpay-error", isError);
  },

  /** One PDF -> its text as separate lines (every text item on its own line, like the invoice's cells). */
  async pdfLines(file) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const lines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const content = await (await pdf.getPage(p)).getTextContent();
      for (const item of content.items) { const t = item.str.trim(); if (t) lines.push(t); }
    }
    return lines;
  },

  async readWorkbook(file) {
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    // Some KPay exports declare a stale sheet size, which makes SheetJS drop every row below it.
    // Work the real size out from the cells themselves.
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      let maxR = 0, maxC = 0;
      for (const key of Object.keys(ws)) {
        if (key[0] === "!") continue;
        const c = XLSX.utils.decode_cell(key);
        if (c.r > maxR) maxR = c.r;
        if (c.c > maxC) maxC = c.c;
      }
      ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
    }
    return wb;
  },

  async run() {
    if (!this.statementFiles.length) { this.setStatus("Choose at least one KPay monthly statement (.xlsx) first.", true); return; }
    document.getElementById("kpay-run-btn").disabled = true;
    try {
      this.setStatus("Reading KPay statements…");
      const seen = new Set();
      let kpay = [];
      for (const f of this.statementFiles) {
        const wb = await this.readWorkbook(f);
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null });
        for (const t of kpayParseStatement(rows)) if (!seen.has(t.id)) { seen.add(t.id); kpay.push(t); }
      }
      if (!kpay.length) throw new Error("No transactions found - is that a KPay monthly statement?");
      kpay.sort((a, b) => a.time - b.time);
      const months = [...new Set(kpay.map((k) => kpayMonth(k.time)))].sort();
      const first = `${months[0]}-01`;
      const [ly, lm] = months[months.length - 1].split("-").map(Number);
      const last = new Date(Date.UTC(ly, lm, 1)).toISOString().slice(0, 10); // first day of the month after

      this.charges = kpayMonthlyCharges(kpay);
      this.invoiceTally = null;
      if (this.invoiceFiles.length) {
        this.setStatus("Reading KPay invoices…");
        const invoices = [];
        for (const f of this.invoiceFiles) invoices.push(kpayParseInvoice(await this.pdfLines(f)));
        invoices.sort((a, b) => (a.daily[0] ? a.daily[0].settleDate : "").localeCompare(b.daily[0] ? b.daily[0].settleDate : ""));
        this.invoiceTally = kpayInvoiceTally(invoices.filter((i) => i.daily.length), kpay);
      }

      this.setStatus("Loading Aronium sales…");
      await Reports.ensureLoaded();
      const names = KPAY_ARONIUM_GROUPS.map((g) => `'${g}'`).join(",");
      const aron = Reports.query(
        `SELECT d.Number AS number, d.DateCreated AS created, pt.Name AS grp, p.Amount AS amount
         FROM Payment p JOIN Document d ON d.Id = p.DocumentId JOIN PaymentType pt ON pt.Id = p.PaymentTypeId
         WHERE d.DocumentTypeId = 2 AND date(d.Date) >= ? AND date(d.Date) < ? AND pt.Name IN (${names})`,
        [first, last],
      ).filter((r) => months.includes(r.created.slice(0, 7)))
        .map((r) => ({ number: r.number, time: kpayNaive(r.created), date: r.created.slice(0, 10), group: r.grp, amount: Number(r.amount) }));
      const refunds = Reports.query(
        `SELECT d.Number AS number, d.ReferenceDocumentNumber AS ref, d.DateCreated AS created, pt.Name AS grp, p.Amount AS amount
         FROM Document d JOIN Payment p ON p.DocumentId = d.Id JOIN PaymentType pt ON pt.Id = p.PaymentTypeId
         WHERE d.DocumentTypeId = 4 AND date(d.Date) >= ? AND date(d.Date) < ?`,
        [first, last],
      ).map((r) => ({ number: r.number, ref: r.ref, time: kpayNaive(r.created), date: r.created.slice(0, 10), group: r.grp, amount: Number(r.amount) }));

      this.setStatus("Loading the roster…");
      await Roster.ensureLoaded();
      const onDuty = (ms) => Roster.onDutyNames(kpayDay(ms), new Date(ms).getUTCHours() * 60 + new Date(ms).getUTCMinutes());
      const covered = new Set();
      for (const o of Roster.overrides.values()) covered.add(o.date.slice(0, 7));
      for (const p of Roster.leavePeriods) { for (let t = rosterParseUTC(p.start); t <= rosterParseUTC(p.end); t += 86400000 * 28) covered.add(rosterFormatUTC(t).slice(0, 7)); covered.add(p.end.slice(0, 7)); }
      const usual = months.filter((m) => !covered.has(m));
      this.rosterNote = usual.length
        ? `No leave or swaps are saved in the Roster for ${usual.join(", ")}, so those months use the usual weekly pattern and can name the wrong person. Add past leave and swaps in the Roster tab to improve this.`
        : "";

      this.setStatus("Matching transactions…");
      this.result = kpayAnalyse(kpay, aron, refunds, onDuty);

      this.settlement = null;
      let settlementFile = this.settlementFile;
      if (!settlementFile) {
        // No file chosen: use the copy the shop PC uploads to the Aronium folder on Drive, if there is one.
        try {
          const folderId = await Drive.findFolderAnywhere(CONFIG.ARONIUM_FOLDER);
          const fileId = folderId && await Drive.findChild("MrITMoney.xls", folderId);
          if (fileId) settlementFile = new File([await (await Drive.downloadBlob(fileId)).arrayBuffer()], "MrITMoney.xls");
        } catch (e) { /* optional - carry on without it */ }
      }
      if (settlementFile) {
        this.setStatus("Checking the daily settlement sheet…");
        this.settlement = this.checkSettlement(await this.readWorkbook(settlementFile), kpay, months, first, last);
      }
      this.setStatus(`Checked ${kpay.length} KPay transactions across ${months.join(", ")}.`);
      this.renderResults();
      document.getElementById("kpay-download-btn").classList.remove("hidden");
    } catch (e) {
      console.error(e);
      this.setStatus("Couldn't run the check: " + e.message, true);
    } finally {
      document.getElementById("kpay-run-btn").disabled = false;
    }
  },

  checkSettlement(wb, kpay, months, first, last) {
    const ws = wb.Sheets["Sheet1"] || wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
    const num = (v) => (typeof v === "number" ? v : 0);
    const sheetDays = {};
    for (const r of rows.slice(1)) {
      if (typeof r[0] !== "number") continue;
      const day = new Date(Date.UTC(1899, 11, 30) + r[0] * 86400000).toISOString().slice(0, 10);
      if (day < first || day >= last) continue;
      sheetDays[day] = { actual: num(r[1]), drawer: num(r[2]), cash: num(r[3]), cc: num(r[4]), wallet: num(r[5]), paynow: num(r[6]), amex: num(r[7]),
        k_cc: num(r[10]), k_pn: num(r[11]), k_ot: num(r[12]), kelvin: num(r[17]) };
    }
    const map = { Cash: "cash", "Credit Cards": "cc", "Alipay/Wechat Pay": "wallet", PayNow: "paynow", Amex: "amex" };
    const aronDaily = {};
    const q = Reports.query(
      `SELECT d.DocumentTypeId AS t, pt.Name AS grp, date(d.Date) AS day, p.Amount AS amount FROM Payment p
       JOIN PaymentType pt ON pt.Id = p.PaymentTypeId JOIN Document d ON d.Id = p.DocumentId
       WHERE d.DocumentTypeId IN (2, 4) AND date(d.Date) >= ? AND date(d.Date) < ?`, [first, last]);
    for (const r of q) {
      const key = map[r.grp];
      if (!key) continue;
      const d = (aronDaily[r.day] = aronDaily[r.day] || {});
      d[key] = (d[key] || 0) + (r.t === 2 ? 1 : -1) * Number(r.amount);
    }
    const kpayDaily = {};
    for (const k of kpay) {
      const key = k.type === "PAYNOW" ? "k_pn" : k.type === "WECHAT" || k.type === "ALIPAY" ? "k_ot" : "k_cc";
      const d = (kpayDaily[k.date] = kpayDaily[k.date] || {});
      d[key] = (d[key] || 0) + k.amount;
    }
    return kpaySettlementCheck(sheetDays, aronDaily, kpayDaily);
  },

  money(x) { return x == null ? "" : Number(x).toFixed(2); },

  table(headers, rows) {
    if (!rows.length) return `<p class="empty-state">None.</p>`;
    return `<div class="kpay-table-wrap"><table class="report-table"><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c == null ? "" : String(c))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  },

  section(title, count, body, open = false) {
    return `<details class="kpay-section" ${open ? "open" : ""}><summary>${escapeHtml(title)} <span class="badge">${count}</span></summary>${body}</details>`;
  },

  sections() {
    const r = this.result, m = this.money;
    const out = [];
    out.push({ name: "Summary", headers: ["Month", "KPay txns", "KPay $", "KPay fees $", "Aronium payments", "Aronium $", "Gap (Aronium - KPay) $",
      "In KPay not Aronium (n)", "$", "In Aronium not KPay (n)", "$", "Same sale amount differs (n)", "Net $", "Wrong payment type (n)", "One swipe = several sales (n)", "One sale = several swipes (n)"],
      rows: r.summary.map((s) => [s.month, s.kpayN, m(s.kpayAmt), m(s.kpayFees), s.aronN, m(s.aronAmt), m(s.gap), s.onlyKn, m(s.onlyKamt), s.onlyAn, m(s.onlyAamt), s.diffN, m(s.diffNet), s.mistypedN, s.combinedN, s.splitN]) });
    out.push({ name: "KPay monthly charges", headers: ["Month", "Txns", "Gross $", "KPay charges $", "Effective rate %", "You receive $"],
      rows: (this.charges || []).map((c) => [c.month, c.n, m(c.gross), m(c.fee), c.gross ? (100 * c.fee / c.gross).toFixed(3) : "", m(c.gross - c.fee)]) });
    if (this.invoiceTally) {
      out.push({ name: "KPay invoices vs statements", headers: ["Invoice period", "Txns", "Gross $", "Service fee $", "Other fee $", "GST $", "You receive $", "Effective rate %",
        "Days tally with statements", "Days that differ", "Days with no statement", "Invoice adds up"],
        rows: this.invoiceTally.map((t) => [t.period, t.total.count, m(t.total.gross), m(t.total.fee), m(t.total.other), m(t.total.gst), m(t.total.net), t.rate == null ? "" : t.rate.toFixed(3),
          t.okDays, t.diffDays, t.noStatementDays, t.check.daysSumToTotal && t.check.netOk ? "yes" : "NO"]) });
      const bad = this.invoiceTally.flatMap((t) => t.days.filter((d) => d.status !== "OK").map((d) => [t.period, d.txnDate, d.status, d.note]));
      out.push({ name: "Invoice days that don't tally", headers: ["Invoice", "Transaction date", "Status", "What differs"], rows: bad });
    }
    out.push({ name: "Fee check", headers: ["KPay type", "Txns", "Amount $", "KPay fee $", "Effective rate %", "MDR sheet rate %", "Fee at MDR rate $", "Txns charged differently", "Over (+) / under (-) charged $"],
      rows: r.feeRows.map((f) => [f.type, f.n, m(f.amount), m(f.fee), f.effectiveExact == null ? "" : f.effectiveExact.toFixed(3), f.rate == null ? "not on MDR sheet" : f.rate, f.atRate == null ? "" : m(f.atRate), f.wrongN == null ? "n/a" : f.wrongN, f.over == null ? "" : m(f.over)]) });
    out.push({ name: "In Aronium not KPay", headers: ["Aronium time", "Sale no.", "Keyed as", "Amount $"],
      rows: r.arLeft.map((a) => [kpayFmt(a.time), a.number, a.group, m(a.amount)]) });
    out.push({ name: "In KPay not Aronium", headers: ["KPay time", "KPay type", "Amount $", "Fee $", "Card / payer", "KPay order no."],
      rows: r.kpLeft.map((k) => [kpayFmt(k.time), k.type, m(k.amount), m(k.fee), k.card, k.id]) });
    out.push({ name: "Same sale amount differs", headers: ["KPay time", "Aronium time", "Sale no.", "KPay type", "KPay $", "Aronium keyed as", "Aronium $", "Aronium - KPay $"],
      rows: r.near.map(([k, a]) => [kpayFmt(k.time), kpayFmt(a.time), a.number, k.type, m(k.amount), a.group, m(a.amount), m(a.amount - k.amount)]) });
    out.push({ name: "One swipe = several sales", headers: ["KPay time", "KPay type", "KPay $", "Aronium sales", "Aronium amounts"],
      rows: r.combined.map(([k, group]) => [kpayFmt(k.time), k.type, m(k.amount), group.map((a) => a.number).join(", "), group.map((a) => a.amount.toFixed(2)).join(" + ")]) });
    out.push({ name: "One sale = several swipes", headers: ["Aronium time", "Sale no.", "Keyed as", "Sale $", "KPay swipes", "KPay amounts"],
      rows: r.split.map(([a, group]) => [kpayFmt(a.time), a.number, a.group, m(a.amount), group.map((k) => k.type).join(", "), group.map((k) => k.amount.toFixed(2)).join(" + ")]) });
    out.push({ name: "Wrong payment type", headers: ["KPay time", "Sale no.", "Amount $", "KPay says", "Aronium keyed as"],
      rows: r.mistyped.map(([k, a]) => [kpayFmt(k.time), a.number, m(k.amount), k.type, a.group]) });
    out.push({ name: "Late keying", headers: ["KPay time", "Aronium sale created", "Minutes after payment", "Sale no.", "KPay type", "Keyed as", "Amount $", "Rostered when keyed"],
      rows: r.late.map((l) => [kpayFmt(l.k.time), kpayFmt(l.a.time), l.minutes, l.a.number, l.k.type, l.a.group, m(l.k.amount), "—"]) });
    out.push({ name: "Refunds - corrected later", headers: ["Refund time", "Refund no.", "Sale refunded", "Minutes later", "Refund paid as", "Refund $"],
      rows: r.refunds.slice().sort((a, b) => a.time - b.time).map((x) => [kpayFmt(x.time), x.number, x.ref || (x.target ? x.target.number : "(none found)"), x.target ? Math.round((x.time - x.target.time) / 60000) : "", x.group, m(x.amount)]) });
    out.push({ name: "Staff pattern", headers: ["Rostered person", "Card/PayNow/wallet sales while rostered", ...r.staffKinds, "Total flags", "Flags per 100 sales"],
      rows: r.staff.map((s) => [s.name, s.sales, ...s.counts, s.total, s.per100 == null ? "" : s.per100]) });
    if (this.settlement) {
      out.push({ name: "Staff sheet vs systems", headers: ["Date", "Differences"],
        rows: this.settlement.rows.filter((x) => x.flags.length).map((x) => [x.day, x.flags.join("; ")]) });
      out.push({ name: "Cash drawer", headers: ["Date", "Opening cash (sheet)", "Counted drawer", "Expected opening", "Difference $", "What's off"],
        rows: this.settlement.cash.map((c) => [c.day, m(c.actual), m(c.drawer), m(c.expected), m(c.diff), c.note]) });
    }
    return out;
  },

  renderResults() {
    const r = this.result;
    // "Rostered when keyed" needs the roster, so add it to the late-keying rows here.
    const secs = this.sections();
    const lateSec = secs.find((s) => s.name === "Late keying");
    lateSec.rows = r.late.map((l) => [kpayFmt(l.k.time), kpayFmt(l.a.time), l.minutes, l.a.number, l.k.type, l.a.group, this.money(l.k.amount),
      (Roster.onDutyNames(kpayDay(l.a.time), new Date(l.a.time).getUTCHours() * 60 + new Date(l.a.time).getUTCMinutes()).join(", ")) || "nobody rostered"]);
    this.lastSections = secs;

    const el = document.getElementById("kpay-results");
    const open = new Set(["Summary", "KPay monthly charges", "KPay invoices vs statements", "Invoice days that don't tally", "Fee check", "In Aronium not KPay", "In KPay not Aronium"]);
    const html = [];
    html.push(`<h3>Gap between Aronium and KPay</h3>` + this.table(secs[0].headers, secs[0].rows));
    for (const s of secs.slice(1)) {
      let body = this.table(s.headers, s.rows);
      if (s.name === "Staff pattern") {
        body += `<p class="kpay-note">Names come from the Roster, because Aronium logs every sale under the same user. Everyone rostered at that moment is counted, so two people on shift both get the flag. Treat it as a lead and check CCTV before drawing a conclusion. ${escapeHtml(this.rosterNote)}</p>`;
      }
      html.push(this.section(s.name, s.rows.length, body, open.has(s.name)));
    }
    el.innerHTML = html.join("");
  },

  download() {
    if (!this.lastSections) return;
    const wb = XLSX.utils.book_new();
    for (const s of this.lastSections) {
      const ws = XLSX.utils.aoa_to_sheet([s.headers, ...s.rows]);
      XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
    }
    const months = this.result.summary.map((x) => x.month);
    XLSX.writeFile(wb, `kpay_reconciliation_${months[0]}_to_${months[months.length - 1]}.xlsx`);
  },
};
