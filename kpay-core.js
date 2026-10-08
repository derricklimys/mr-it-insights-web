// KPay reconciliation logic - no screen code in here, so it can be tested on its own.
// A JavaScript copy of kpay_reconcile/kpay_reconcile.py (the two should give the same numbers).
//
// Times are handled as "naive" milliseconds (the text "2026-09-30 21:08:00" read as UTC) so the
// browser's own time zone can never shift a sale onto the wrong day.

const KPAY_MDR = { VISA: 2.6, MASTERCARD: 2.6, UNIONPAY: 2.5, PAYNOW: 0.8, WECHAT: 1.5 }; // from the KPay MDR sheet
const KPAY_GROUP_OF = {
  VISA: "Credit Cards", MASTERCARD: "Credit Cards", UNIONPAY: "Credit Cards", DINERSCLUB: "Credit Cards",
  PAYNOW: "PayNow", WECHAT: "Alipay/Wechat Pay", ALIPAY: "Alipay/Wechat Pay",
};
const KPAY_ARONIUM_GROUPS = ["Credit Cards", "PayNow", "Alipay/Wechat Pay"];
const KPAY_MATCH_WINDOW_MIN = 90;
const KPAY_NEAR_WINDOW_MIN = 45;
const KPAY_LATE_KEY_MIN = 5;

const kpayMin = (a, b) => Math.abs(a - b) / 60000;
const kpayRound2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const kpayNaive = (s) => { // "YYYY-MM-DD HH:MM:SS" or ISO -> naive ms
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
};
const kpayDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const kpayMonth = (ms) => new Date(ms).toISOString().slice(0, 7);
const kpayFmt = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

function kpayType(txType, org) {
  const t = String(txType || "").toUpperCase();
  if (t.startsWith("PAYNOW")) return "PAYNOW";
  if (t.startsWith("WECHAT")) return "WECHAT";
  if (t.startsWith("ALIPAY")) return "ALIPAY";
  return String(org || "UNKNOWN").toUpperCase();
}

/** Rows of one KPay "monthly statement" sheet (array of arrays) -> transactions. */
function kpayParseStatement(rows) {
  let header = null;
  const out = [];
  for (const r of rows) {
    if (r[0] === "Name of Store.") { header = r; continue; }
    if (!header || !r[0] || !String(r[0]).startsWith("MRIT")) continue;
    const d = {};
    header.forEach((h, i) => { d[h] = r[i]; });
    const time = kpayNaive(String(d["Transaction time"]));
    const type = kpayType(d["Transaction Type"], d["Card organization"]);
    out.push({
      id: String(d["Transaction order No."]), time, date: kpayDay(time), type,
      group: KPAY_GROUP_OF[type] || "Credit Cards",
      amount: Number(d["Transaction amount"]), fee: Number(d["Transaction fees"]),
      card: d["Card No."] || "",
    });
  }
  return out;
}

/** Cancels each refund against the sale it corrects, so Aronium's side is what the customer really paid. */
function kpayApplyRefunds(aron, refunds) {
  const byNumber = new Map(aron.map((a) => [a.number, a]));
  for (const r of [...refunds].sort((x, y) => x.time - y.time)) {
    r.target = null;
    if (!KPAY_ARONIUM_GROUPS.includes(r.group)) continue; // a cash refund doesn't touch KPay
    let target = r.ref ? byNumber.get(r.ref) : null;
    if (target && target.group !== r.group) target = null;
    if (!target) {
      const pool = aron.filter((a) => a.date === r.date && a.group === r.group
        && a.amount - (a.refunded || 0) >= r.amount - 0.005 && kpayMin(a.time, r.time) <= 45);
      target = pool.reduce((best, a) => (!best || kpayMin(a.time, r.time) < kpayMin(best.time, r.time) ? a : best), null);
    }
    if (target) {
      target.refunded = (target.refunded || 0) + r.amount;
      (target.refundDocs = target.refundDocs || []).push(r);
      r.target = target;
    }
  }
  for (const a of aron) { a.gross = a.amount; a.amount = kpayRound2(a.amount - (a.refunded || 0)); }
  return aron.filter((a) => a.amount > 0.005);
}

function kpayPairUp(kpay, aron, sameAmount, windowMin) {
  const cands = [];
  const byDay = new Map();
  for (const a of aron) if (!a.used) { if (!byDay.has(a.date)) byDay.set(a.date, []); byDay.get(a.date).push(a); }
  kpay.forEach((k, ki) => {
    if (k.used) return;
    (byDay.get(k.date) || []).forEach((a, ai) => {
      if (sameAmount && Math.abs(a.amount - k.amount) > 0.005) return;
      const gap = kpayMin(a.time, k.time);
      if (gap <= windowMin) cands.push([gap, ki, a.order, k, a]);
    });
  });
  cands.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  const pairs = [];
  for (const [gap, , , k, a] of cands) {
    if (k.used || a.used) continue;
    k.used = a.used = true;
    pairs.push([k, a, gap]);
  }
  return pairs;
}

function* kpayCombos(items, size) {
  const n = items.length;
  const idx = [];
  function* rec(start) {
    if (idx.length === size) { yield idx.map((i) => items[i]); return; }
    for (let i = start; i < n; i++) { idx.push(i); yield* rec(i + 1); idx.pop(); }
  }
  yield* rec(0);
}

/** One KPay swipe that settles two or three Aronium sales together. */
function kpayCombineSales(kpay, aron) {
  const out = [];
  for (const k of kpay) {
    if (k.used) continue;
    const near = aron.filter((a) => !a.used && a.date === k.date && kpayMin(a.time, k.time) <= KPAY_NEAR_WINDOW_MIN);
    let best = null;
    for (const size of [2, 3]) {
      for (const combo of kpayCombos(near, size)) {
        if (Math.abs(combo.reduce((s, a) => s + a.amount, 0) - k.amount) <= 0.005) {
          const gap = Math.max(...combo.map((a) => kpayMin(a.time, k.time)));
          if (!best || gap < best[1]) best = [combo, gap];
        }
      }
      if (best) break;
    }
    if (best) { k.used = true; best[0].forEach((a) => { a.used = true; }); out.push([k, best[0], best[1]]); }
  }
  return out;
}

/** One Aronium sale paid with two or three KPay swipes. */
function kpaySplitPayments(kpay, aron) {
  const out = [];
  for (const a of aron) {
    if (a.used) continue;
    const near = kpay.filter((k) => !k.used && k.date === a.date && kpayMin(k.time, a.time) <= KPAY_NEAR_WINDOW_MIN);
    let best = null;
    for (const size of [2, 3]) {
      for (const combo of kpayCombos(near, size)) {
        if (Math.abs(combo.reduce((s, k) => s + k.amount, 0) - a.amount) <= 0.005) {
          const gap = Math.max(...combo.map((k) => kpayMin(k.time, a.time)));
          if (!best || gap < best[1]) best = [combo, gap];
        }
      }
      if (best) break;
    }
    if (best) { a.used = true; best[0].forEach((k) => { k.used = true; }); out.push([a, best[0], best[1]]); }
  }
  return out;
}

/**
 * kpay: transactions, aron: card/PayNow/wallet payments, refunds: Aronium refund payments,
 * onDuty(ms) -> array of rostered names. Returns every list the screen and the Excel export need.
 */
function kpayAnalyse(kpayRows, aronRows, refundRows, onDuty) {
  const kpay = kpayRows.map((k) => ({ ...k, used: false }));
  const refunds = refundRows.map((r) => ({ ...r }));
  let aron = aronRows.map((a, i) => ({ ...a, used: false, order: i }));
  aron = kpayApplyRefunds(aron, refunds);
  aron.forEach((a, i) => { a.order = i; });

  const exact = kpayPairUp(kpay, aron, true, KPAY_MATCH_WINDOW_MIN);
  const loose = kpayPairUp(kpay, aron, true, 24 * 60);
  const combined = kpayCombineSales(kpay, aron);
  const split = kpaySplitPayments(kpay, aron);
  const near = kpayPairUp(kpay, aron, false, KPAY_NEAR_WINDOW_MIN);
  const kpLeft = kpay.filter((k) => !k.used);
  const arLeft = aron.filter((a) => !a.used);
  const mistyped = [...exact, ...loose].filter(([k, a]) => k.group !== a.group);
  const late = [...exact, ...loose].filter(([, , gap]) => gap > KPAY_LATE_KEY_MIN)
    .map(([k, a, gap]) => ({ k, a, minutes: Math.round((a.time - k.time) / 60000), gap }));

  const months = [...new Set(kpay.map((k) => kpayMonth(k.time)))].sort();
  const summary = months.map((m) => {
    const mk = kpay.filter((k) => kpayMonth(k.time) === m), ma = aron.filter((a) => kpayMonth(a.time) === m);
    const inM = (t) => kpayMonth(t) === m;
    const ka = mk.reduce((s, k) => s + k.amount, 0), aa = ma.reduce((s, a) => s + a.amount, 0);
    const onlyK = kpLeft.filter((k) => inM(k.time)), onlyA = arLeft.filter((a) => inM(a.time));
    const diff = near.filter(([k]) => inM(k.time));
    return {
      month: m, kpayN: mk.length, kpayAmt: kpayRound2(ka), kpayFees: kpayRound2(mk.reduce((s, k) => s + k.fee, 0)),
      aronN: ma.length, aronAmt: kpayRound2(aa), gap: kpayRound2(aa - ka),
      onlyKn: onlyK.length, onlyKamt: kpayRound2(onlyK.reduce((s, k) => s + k.amount, 0)),
      onlyAn: onlyA.length, onlyAamt: kpayRound2(onlyA.reduce((s, a) => s + a.amount, 0)),
      diffN: diff.length, diffNet: kpayRound2(diff.reduce((s, [k, a]) => s + a.amount - k.amount, 0)),
      mistypedN: mistyped.filter(([k]) => inM(k.time)).length,
      combinedN: combined.filter(([k]) => inM(k.time)).length,
      splitN: split.filter(([a]) => inM(a.time)).length,
    };
  });

  const byType = {};
  for (const k of kpay) (byType[k.type] = byType[k.type] || []).push(k);
  const feeRows = Object.keys(byType).sort().map((t) => {
    const items = byType[t], rate = KPAY_MDR[t];
    const amount = items.reduce((s, i) => s + i.amount, 0), fee = items.reduce((s, i) => s + i.fee, 0);
    const expected = (i) => kpayRound2(i.amount * rate / 100);
    const wrong = rate === undefined ? [] : items.filter((i) => Math.abs(expected(i) - i.fee) > 0.005);
    return {
      type: t, n: items.length, amount: kpayRound2(amount), fee: kpayRound2(fee), effective: amount ? kpayRound2(100 * fee / amount * 10) / 10 : null,
      effectiveExact: amount ? 100 * fee / amount : null,
      rate: rate === undefined ? null : rate,
      atRate: rate === undefined ? null : kpayRound2(items.reduce((s, i) => s + expected(i), 0)),
      wrongN: rate === undefined ? null : wrong.length,
      over: rate === undefined ? null : kpayRound2(wrong.reduce((s, i) => s + i.fee - expected(i), 0)),
    };
  });

  // Who was rostered when each kind of flag happened (a proxy - Aronium doesn't record who keyed a sale).
  const names = (ms) => (onDuty ? onDuty(ms) : []);
  const onShift = {}, flags = {};
  for (const a of aron) for (const n of names(a.time)) onShift[n] = (onShift[n] || 0) + 1;
  const flag = (kind, ms) => {
    const list = names(ms).length ? names(ms) : ["nobody rostered"];
    for (const n of list) { flags[n] = flags[n] || {}; flags[n][kind] = (flags[n][kind] || 0) + 1; }
  };
  mistyped.forEach(([, a]) => flag("Wrong payment type", a.time));
  near.forEach(([, a]) => flag("Amount differs", a.time));
  refunds.filter((r) => r.target || KPAY_ARONIUM_GROUPS.includes(r.group)).forEach((r) => flag("Refund / correction", r.time));
  late.forEach((l) => flag(`Keyed late (>${KPAY_LATE_KEY_MIN} min)`, l.a.time));
  arLeft.forEach((a) => flag("Card sale with no KPay swipe", a.time));
  const kinds = ["Wrong payment type", "Amount differs", "Refund / correction", `Keyed late (>${KPAY_LATE_KEY_MIN} min)`, "Card sale with no KPay swipe"];
  const staff = [...new Set([...Object.keys(onShift), ...Object.keys(flags)])].sort().map((n) => {
    const counts = kinds.map((kd) => (flags[n] && flags[n][kd]) || 0);
    const total = counts.reduce((s, x) => s + x, 0);
    return { name: n, sales: onShift[n] || 0, counts, total, per100: onShift[n] ? kpayRound2(100 * total / onShift[n] * 10) / 10 : null };
  });

  return { summary, feeRows, exact, loose, combined, split, near, kpLeft, arLeft, mistyped, late, refunds, staff, staffKinds: kinds, kpay, aron };
}

/** The staff's daily settlement sheet vs Aronium and KPay, plus the cash drawer roll-forward. */
function kpaySettlementCheck(sheetDays, aronDaily, kpayDaily) {
  const CATS = [["Cash", "cash"], ["Credit Cards", "cc"], ["Alipay/Wechat", "wallet"], ["PayNow", "paynow"], ["Amex", "amex"]];
  const KCATS = [["KPay CC", "k_cc"], ["KPay PayNow", "k_pn"], ["KPay Other", "k_ot"]];
  const days = Object.keys(sheetDays).sort();
  const rows = days.map((day) => {
    const s = sheetDays[day], flags = [];
    for (const [label, key] of CATS) {
      const a = (aronDaily[day] && aronDaily[day][key]) || 0;
      if (Math.abs(s[key] - a) > 0.005) flags.push(`${label}: sheet ${s[key].toFixed(2)} vs Aronium ${a.toFixed(2)}`);
    }
    for (const [label, key] of KCATS) {
      const k = (kpayDaily[day] && kpayDaily[day][key]) || 0;
      if (Math.abs(s[key] - k) > 0.005) flags.push(`${label}: sheet ${s[key].toFixed(2)} vs KPay ${k.toFixed(2)}`);
    }
    return { day, flags };
  });
  const cash = [];
  for (let i = 1; i < days.length; i++) {
    const prev = new Date(days[i - 1] + "T00:00:00Z").getTime();
    if (new Date(days[i] + "T00:00:00Z").getTime() - prev !== 86400000) continue;
    const p = sheetDays[days[i - 1]], s = sheetDays[days[i]];
    const expected = p.actual + p.cash - p.kelvin;
    const note = [];
    if (Math.abs(s.actual - expected) > 0.05) note.push(`opening cash ${s.actual.toFixed(2)}, expected ${expected.toFixed(2)}`);
    if (Math.abs(s.actual - s.drawer) > 0.05) note.push(`counted drawer ${s.drawer.toFixed(2)} vs actual cash ${s.actual.toFixed(2)}`);
    if (note.length) cash.push({ day: days[i], actual: s.actual, drawer: s.drawer, expected: kpayRound2(expected), diff: kpayRound2(s.actual - expected), note: note.join("; ") });
  }
  return { rows, cash };
}

if (typeof module !== "undefined") module.exports = { kpayParseStatement, kpayAnalyse, kpaySettlementCheck, kpayNaive, kpayApplyRefunds };
