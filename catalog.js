// Group-agnostic signal/chart logic shared by any per-product-group tab
// (Memory, Powerbank, ...) that wants the same "stock-up"/"reprice" signal,
// margin math, and cost-trend chart. Extracted out of memory.js so every
// such tab looks and behaves identically instead of re-implementing this
// by hand and slowly drifting apart.

const Catalog = {
  GST_RATE: 1.09,

  signalRank(signal) {
    return signal === "stock-up" ? 2 : signal === "reprice" ? 1 : 0;
  },

  costSourceNote(p) {
    const n = p.invoiceCosts.length;
    if (n >= 2) return `Cost and margin are based on ${n} of your actual invoices - the most accurate source.`;
    if (n === 1) return `Cost is your one actual invoice for this product; the trend direction is filled in from the pricelist since one invoice alone can't show a trend.`;
    if (p.priceHistoryPn) return `No invoice for this product yet - cost is estimated from the pricelist (a quote, not necessarily what you'd actually pay).`;
    return `No cost data available for this product yet.`;
  },

  signalBadge(signal) {
    const label = signal === "stock-up" ? "Stock up" : signal === "reprice" ? "Reprice" : "Normal";
    return `<span class="badge signal-${signal}">${label}</span>`;
  },

  // Estimates what he actually pays from the pricelist alone, since he
  // negotiates below the printed Dealer price - calibrated against his real
  // invoice prices earlier: exactly the Special price when shown, else ~95%
  // of Dealer. Only used as a fallback where no real invoice cost exists.
  estimateCostFromPricelist(entry) {
    const raw = entry.special_price != null ? entry.special_price : entry.dealer_price * 0.95;
    return raw * Catalog.GST_RATE;
  },

  computeSignal({ currentPrice, priceHistory, invoiceCosts, monthly, combinedStock }) {
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
      estCost = Catalog.estimateCostFromPricelist(last);
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
  },

  drawChart(canvas, product) {
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
      return Catalog.estimateCostFromPricelist(priceMatches[priceMatches.length - 1]);
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

    Catalog._attachChartTooltip(canvas, { months, qtys, sellPrices, costByMonth, invoiceIsReal, x, padL, padR, w, barW });
  },

  // Hover-only detail so the chart itself stays uncluttered - move over a bar
  // or point to see that month's exact numbers instead of guessing from pixels.
  _attachChartTooltip(canvas, { months, qtys, sellPrices, costByMonth, invoiceIsReal, x, padL, padR, w, barW }) {
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
  },

  tableHtmlWithRowIds(headers, rows) {
    return `<table class="report-table memory-table">
      <thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr data-id="${r[0]}">${r.slice(1).map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>
    </table>`;
  },

  /** Shared by Memory and Powerbank detail views - the small product photo
   * there is deliberately compact so it doesn't crowd the stats next to it;
   * click it to see it full-size instead of only ever seeing a thumbnail. */
  openPhotoLightbox(url) {
    document.getElementById("photo-lightbox-img").src = url;
    document.getElementById("photo-lightbox-modal").classList.remove("hidden");
  },

  closePhotoLightbox() {
    document.getElementById("photo-lightbox-modal").classList.add("hidden");
    document.getElementById("photo-lightbox-img").src = "";
  },
};
