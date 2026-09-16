// Roster tab: the shop's staff work schedule (Michael/Julie/Agnes + Derrick's
// own backup shifts). Everyone's default weekly hours and the Sat/Sun AM
// alternation are long-standing, fixed real-world constraints - hardcoded
// here rather than editable data, matching how Derrick described them
// ("had been pass down from long ago... not easy to change their schedule").
// The two things that actually change over time - leave periods and one-off
// overrides (covering a gap, a swap, a confirmed deviation) - are saved to
// Drive JSON, same create-or-update pattern as order_memory_tracked.json.
//
// Coverage gaps are *computed*, not hand-written: every day, the union of
// everyone's AM/PM/FULL/COVER hours (after leave and overrides are applied)
// is checked against shop hours (11:00-21:00); anything left over shows as a
// gap automatically. That's what lets this stay correct as new leave gets
// added later, instead of needing a fresh round of manual reasoning every
// time - the exact thing that took a full manual pass to work out by hand
// for Oct-Dec 2026 before this tab existed.

const ROSTER_LEAVE_FILE = "roster_leave.json";
const ROSTER_OVERRIDES_FILE = "roster_overrides.json";
const ROSTER_ALERTS_FILE = "roster_alerts.json";

const ROSTER_PEOPLE = ["Michael", "Julie", "Agnes", "Derrick"];
const ROSTER_PKEY = { Michael: "mi", Julie: "ju", Agnes: "ag", Derrick: "de" };
// "Derrick" stays the internal person key everywhere (data already saved to
// Drive under that name, plus every CSS class/variable) - only the label
// shown on screen changes, per his own preferred display name.
const ROSTER_PLABEL = { Michael: "Michael", Julie: "Julie", Agnes: "Agnes", Derrick: "Kelvin" };
const ROSTER_SHOP_OPEN = "11:00";
const ROSTER_SHOP_CLOSE = "21:00";
const ROSTER_ANCHOR_SAT = "2026-09-19"; // confirmed with Derrick: this Sat = Michael AM, this Sun = Julie AM

// 2026 Singapore public holidays (MOM gazetted). When one falls on a Sunday,
// the standard rule is the following Monday is the paid holiday instead -
// applied here for Vesak and National Day. Deepavali is the one deliberate
// exception: Derrick treats the actual Sunday (8 Nov) as the staff's holiday
// for this shop and runs 9 Nov as a normal working Monday - his explicit call,
// not the general rule. Hari Raya Puasa/Haji dates are moon-sighting-based
// and not yet officially confirmed for 2026 - update these two once gazetted.
const ROSTER_PUBLIC_HOLIDAYS = {
  "2026-01-01": "New Year's Day",
  "2026-02-17": "Chinese New Year",
  "2026-02-18": "Chinese New Year",
  "2026-03-21": "Hari Raya Puasa (est.)",
  "2026-04-03": "Good Friday",
  "2026-05-01": "Labour Day",
  "2026-05-27": "Hari Raya Haji (est.)",
  "2026-06-01": "Vesak Day (observed)",
  "2026-08-10": "National Day (observed)",
  "2026-11-08": "Deepavali",
  "2026-12-25": "Christmas Day",
};

// Seed data: everything worked out by hand for Oct-Dec 2026 before this tab
// existed, so the first load isn't an empty shell. Only used the very first
// time each file doesn't exist yet in Drive - after that, Drive is the only
// source of truth and edits made in the app are what persists.
const ROSTER_SEED_LEAVE = [
  { id: "seed-julie-oct", person: "Julie", start: "2026-10-01", end: "2026-10-11" },
  { id: "seed-michael-oct", person: "Michael", start: "2026-10-25", end: "2026-11-02" },
  { id: "seed-derrick-nov", person: "Derrick", start: "2026-11-27", end: "2026-12-10" },
];
const ROSTER_SEED_OVERRIDES = [
  { date: "2026-10-01", person: "Michael", status: "AM", hours: "11:00-17:00", tag: "confirmed" },
  { date: "2026-10-01", person: "Derrick", status: "PM", hours: "17:00-21:00", tag: "confirmed" },
  { date: "2026-10-04", person: "Derrick", status: "COVER", hours: "11:00-14:00", tag: "confirmed" },
  { date: "2026-10-05", person: "Derrick", status: "COVER", hours: "11:00-16:30", tag: "confirmed" },
  { date: "2026-10-08", person: "Michael", status: "AM", hours: "11:00-17:00", tag: "confirmed" },
  { date: "2026-10-08", person: "Derrick", status: "PM", hours: "17:00-21:00", tag: "confirmed" },
  { date: "2026-10-10", person: "Michael", status: "COVER", hours: "11:00-17:00", tag: "confirmed" },
  { date: "2026-10-10", person: "Derrick", status: "PM", hours: "17:00-21:00", tag: "confirmed" },
  { date: "2026-10-25", person: "Derrick", status: "COVER", hours: "11:00-14:00", tag: "alert" },
  { date: "2026-10-28", person: "Derrick", status: "COVER", hours: "11:00-16:30", tag: "confirmed" },
  { date: "2026-10-29", person: "Derrick", status: "PM", hours: "17:00-21:00", tag: "confirmed" },
  { date: "2026-10-31", person: "Julie", status: "COVER", hours: "11:00-17:00", tag: "confirmed" },
  { date: "2026-10-31", person: "Derrick", status: "PM", hours: "17:00-21:00", tag: "confirmed" },
  { date: "2026-11-01", person: "Derrick", status: "COVER", hours: "11:00-14:00", tag: "confirmed" },
  { date: "2026-11-01", person: "Julie", status: "OFF", hours: null, tag: "confirmed" },
  { date: "2026-11-08", person: "Michael", status: "OFF", hours: null, tag: "confirmed" },
  { date: "2026-11-28", person: "Julie", status: "FULL", hours: "11:00-21:00", tag: "confirmed" },
  { date: "2026-11-28", person: "Michael", status: "OFF", hours: null, tag: "confirmed" },
  { date: "2026-12-05", person: "Julie", status: "FULL", hours: "11:00-21:00", tag: "confirmed" },
  { date: "2026-12-12", person: "Agnes", status: "COVER", hours: "17:30-21:00", tag: "swap" },
  { date: "2026-12-12", person: "Derrick", status: "OFF", hours: null, tag: "swap" },
  { date: "2026-12-13", person: "Derrick", status: "PM", hours: "14:00-21:00", tag: "swap" },
  { date: "2026-12-13", person: "Agnes", status: "OFF", hours: null, tag: "swap" },
  { date: "2026-12-25", person: "Julie", status: "AM", hours: "11:00-17:00", tag: "alert" },
  { date: "2026-12-25", person: "Derrick", status: "PM", hours: "17:00-21:00", tag: "alert" },
  { date: "2026-12-25", person: "Michael", status: "OFF", hours: null, tag: "alert" },
  { date: "2026-12-25", person: "Agnes", status: "OFF", hours: null, tag: "alert" },
];
const ROSTER_SEED_ALERTS = [
  { id: "seed-1", date: "2026-10-25", text: "Confirm with Michael whether his leave really starts by this weekend — the normal rotation has him on Sun 25 Oct AM." },
  { id: "seed-2", date: "2026-11-08", text: "Ask Julie to cover this holiday Sunday; she can pick a make-up day off from a Tue/Fri she shares with Michael." },
  { id: "seed-3", date: "2026-12-13", text: "Confirm your exact PM start time — assumed 14:00 to match Agnes's usual Sunday start." },
  { id: "seed-4", date: "2026-12-25", text: "Ask Julie to confirm she can cover the morning — same plan as past years, you take PM." },
];

function rosterParseUTC(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
function rosterFormatUTC(t) {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function rosterAddDays(dateStr, n) {
  return rosterFormatUTC(rosterParseUTC(dateStr) + n * 86400000);
}
function rosterTimeToMin(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Which of Michael/Julie has the AM turn on this Saturday or Sunday, per the
 * confirmed alternation anchor. */
function rosterWeekendAM(dateStr) {
  const t = rosterParseUTC(dateStr);
  const wd = new Date(t).getUTCDay(); // 0=Sun..6=Sat
  const satT = wd === 0 ? t - 86400000 : t;
  const anchorT = rosterParseUTC(ROSTER_ANCHOR_SAT);
  const weeks = Math.round((satT - anchorT) / (7 * 86400000));
  const michaelHasSat = (((weeks % 2) + 2) % 2) === 0;
  if (wd === 6) return michaelHasSat ? "Michael" : "Julie";
  return michaelHasSat ? "Julie" : "Michael";
}

/** The default weekly pattern - long-standing shop hours, not editable data.
 * Returns {person: [status, hours]}. */
function rosterBasePattern(dateStr) {
  const wd = new Date(rosterParseUTC(dateStr)).getUTCDay(); // 0=Sun..6=Sat
  const s = {
    Michael: ["OFF", null], Julie: ["OFF", null], Agnes: ["OFF", null], Derrick: ["OFF", null],
  };
  if (wd === 1) { s.Julie = ["AM", "11:00-17:00"]; s.Agnes = ["PM", "16:30-21:00"]; } // Mon
  else if (wd === 2) { s.Michael = ["AM", "11:00-17:30"]; s.Julie = ["AM", "11:00-17:00"]; s.Agnes = ["PM", "16:30-21:00"]; } // Tue
  else if (wd === 3) { s.Michael = ["AM", "11:00-17:30"]; s.Agnes = ["PM", "16:30-21:00"]; } // Wed
  else if (wd === 4) { s.Michael = ["PM", "14:30-21:00"]; s.Julie = ["AM", "11:00-17:00"]; } // Thu
  else if (wd === 5) { s.Michael = ["AM", "11:00-17:30"]; s.Julie = ["AM", "11:00-17:00"]; s.Agnes = ["PM", "16:30-21:00"]; } // Fri
  else if (wd === 6) { // Sat
    const who = rosterWeekendAM(dateStr);
    if (who === "Michael") { s.Michael = ["AM", "11:00-17:30"]; s.Derrick = ["PM", "17:30-21:00"]; }
    else { s.Julie = ["AM", "11:00-17:00"]; s.Derrick = ["PM", "17:00-21:00"]; }
  } else if (wd === 0) { // Sun
    const who = rosterWeekendAM(dateStr);
    if (who === "Michael") s.Michael = ["AM", "11:00-17:30"];
    else s.Julie = ["AM", "11:00-17:00"];
    s.Agnes = ["PM", "14:00-21:00"];
  }
  return s;
}

/** Gaps in shop coverage for a set of {status, hours} shifts - anything
 * within 11:00-21:00 not spanned by an AM/PM/FULL/COVER interval. Computed
 * fresh every render rather than hand-flagged, so it self-updates as leave
 * and overrides change. */
function rosterComputeGaps(shifts) {
  const open = rosterTimeToMin(ROSTER_SHOP_OPEN);
  const close = rosterTimeToMin(ROSTER_SHOP_CLOSE);
  const intervals = [];
  for (const person of ROSTER_PEOPLE) {
    const sh = shifts[person];
    if (["AM", "PM", "FULL", "COVER"].includes(sh.status) && sh.hours) {
      const [a, b] = sh.hours.split("-").map(rosterTimeToMin);
      intervals.push([Math.max(a, open), Math.min(b, close)]);
    }
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let cursor = open;
  for (const [a, b] of intervals) {
    if (a > cursor) gaps.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < close) gaps.push([cursor, close]);
  return gaps.filter(([a, b]) => b > a);
}

function rosterMinToHHMM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

const Roster = {
  loaded: false,
  leavePeriods: [],
  overrides: new Map(), // key `${date}|${person}` -> {status, hours, tag}
  alerts: [],
  viewYear: null,
  viewMonth: null, // 1-12

  async ensureLoaded() {
    if (this.loaded) return;
    const now = new Date();
    this.viewYear = now.getFullYear();
    this.viewMonth = now.getMonth() + 1;

    let leave = await this._loadDriveJson(ROSTER_LEAVE_FILE);
    if (!leave || !Array.isArray(leave.periods)) {
      leave = { periods: ROSTER_SEED_LEAVE };
      await this._saveDriveJson(ROSTER_LEAVE_FILE, leave);
    }
    this.leavePeriods = leave.periods;

    let overridesData = await this._loadDriveJson(ROSTER_OVERRIDES_FILE);
    if (!overridesData || !Array.isArray(overridesData.overrides)) {
      overridesData = { overrides: ROSTER_SEED_OVERRIDES };
      await this._saveDriveJson(ROSTER_OVERRIDES_FILE, overridesData);
    }
    this.overrides = new Map(overridesData.overrides.map((o) => [`${o.date}|${o.person}`, o]));

    let alertsData = await this._loadDriveJson(ROSTER_ALERTS_FILE);
    if (!alertsData || !Array.isArray(alertsData.alerts)) {
      alertsData = { alerts: ROSTER_SEED_ALERTS };
      await this._saveDriveJson(ROSTER_ALERTS_FILE, alertsData);
    }
    this.alerts = alertsData.alerts;

    this.loaded = true;
  },

  _isOnLeave(person, dateStr) {
    return this.leavePeriods.some((p) => p.person === person && p.start <= dateStr && dateStr <= p.end);
  },

  /** Final shifts for one day: base pattern, leave zeroes a person out, then
   * any saved override wins outright. */
  computeDay(dateStr) {
    const base = rosterBasePattern(dateStr);
    const shifts = {};
    for (const person of ROSTER_PEOPLE) {
      if (this._isOnLeave(person, dateStr)) {
        shifts[person] = { status: "LEAVE", hours: null };
      } else {
        shifts[person] = { status: base[person][0], hours: base[person][1] };
      }
      const ov = this.overrides.get(`${dateStr}|${person}`);
      if (ov) shifts[person] = { status: ov.status, hours: ov.hours, tag: ov.tag };
    }
    const gaps = rosterComputeGaps(shifts);
    const dayAlerts = this.alerts.filter((a) => a.date === dateStr);
    return { base, shifts, gaps, alerts: dayAlerts };
  },

  /** What actually matters for reading a day at a glance: who's really
   * covering (whether or not it's their normal day - a substitute shows up
   * here too), and separately, anyone whose NORMAL working day this is but
   * who isn't covering it today (on leave, or given the day off). Someone
   * who neither normally works today nor is covering it isn't mentioned at
   * all - that's the "don't show Michael on an ordinary Monday" rule. */
  daySummary(dateStr) {
    const { base, shifts, gaps, alerts } = this.computeDay(dateStr);
    const WORKING = ["AM", "PM", "FULL", "COVER"];
    const workers = [];
    const absent = [];
    for (const person of ROSTER_PEOPLE) {
      const final = shifts[person];
      const isWorkingNow = WORKING.includes(final.status);
      const isUsual = base[person][0] !== "OFF";
      if (isWorkingNow) workers.push({ person, status: final.status, hours: final.hours, tag: final.tag });
      if (isUsual && !isWorkingNow) absent.push({ person, status: final.status });
    }
    workers.sort((a, b) => rosterTimeToMin((a.hours || "23:59").split("-")[0]) - rosterTimeToMin((b.hours || "23:59").split("-")[0]));
    return { workers, absent, gaps, alerts, isIrregular: absent.length > 0 };
  },

  _slotLabel(status, hours) {
    if (status === "FULL") return "whole day";
    if (status === "AM" || status === "PM") return status;
    const startMin = rosterTimeToMin(hours.split("-")[0]);
    return startMin < 14 * 60 ? "AM" : "PM";
  },

  _fmtShort(dateStr) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const [, m, d] = dateStr.split("-").map(Number);
    return `${d} ${months[m - 1]}`;
  },

  /** Anyone whose leave period touches the month currently on screen - shown
   * as a standing banner above the grid, always with the leave's *full*
   * date range (even the part that falls outside this month), so it reads
   * the same way switching from Oct to Nov as it does the other way. */
  renderMonthLeave() {
    const el = document.getElementById("roster-month-leave");
    const pad = String(this.viewMonth).padStart(2, "0");
    const monthStart = `${this.viewYear}-${pad}-01`;
    const daysInMonth = new Date(Date.UTC(this.viewYear, this.viewMonth, 0)).getUTCDate();
    const monthEnd = `${this.viewYear}-${pad}-${String(daysInMonth).padStart(2, "0")}`;
    const overlapping = this.leavePeriods
      .filter((p) => p.start <= monthEnd && p.end >= monthStart)
      .sort((a, b) => a.start.localeCompare(b.start));
    if (!overlapping.length) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML = overlapping.map((p) => `
      <div class="roster-month-leave-item" style="border-left-color:var(--${ROSTER_PKEY[p.person]})">
        <strong>${escapeHtml(ROSTER_PLABEL[p.person])}</strong> on leave: ${escapeHtml(this._fmtShort(p.start))} to ${escapeHtml(this._fmtShort(p.end))}
      </div>`).join("");
  },

  async render() {
    await this.ensureLoaded();
    document.getElementById("roster-prev-btn").onclick = () => this._shiftMonth(-1);
    document.getElementById("roster-next-btn").onclick = () => this._shiftMonth(1);
    document.getElementById("roster-alert-add-btn").onclick = () => this._addAlert();
    document.getElementById("roster-leave-add-btn").onclick = () => this._addLeave();
    document.getElementById("roster-ov-add-btn").onclick = () => this._addOverride();
    this.renderAll();
  },

  _shiftMonth(delta) {
    this.viewMonth += delta;
    if (this.viewMonth < 1) { this.viewMonth = 12; this.viewYear--; }
    if (this.viewMonth > 12) { this.viewMonth = 1; this.viewYear++; }
    this.renderCalendar();
  },

  renderAll() {
    this.renderCalendar();
    this.renderAlerts();
    this.renderLeaveList();
    this.renderOverrideList();
  },

  renderCalendar() {
    this.renderMonthLeave();
    const monthNames = ["January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"];
    document.getElementById("roster-month-label").textContent = `${monthNames[this.viewMonth - 1]} ${this.viewYear}`;

    const firstStr = `${this.viewYear}-${String(this.viewMonth).padStart(2, "0")}-01`;
    const firstT = rosterParseUTC(firstStr);
    const daysInMonth = new Date(Date.UTC(this.viewYear, this.viewMonth, 0)).getUTCDate();
    const leadBlank = (new Date(firstT).getUTCDay() + 6) % 7; // Monday-start
    const totalCells = Math.ceil((leadBlank + daysInMonth) / 7) * 7; // always full weeks - pad with real adjacent-month days, never blanks

    const el = document.getElementById("roster-calendar");
    let html = "";
    for (const n of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) html += `<div class="roster-dow">${n}</div>`;

    for (let i = 0; i < totalCells; i++) {
      const dateStr = rosterAddDays(firstStr, i - leadBlank);
      const inCurrentMonth = i >= leadBlank && i < leadBlank + daysInMonth;
      const dayNum = Number(dateStr.slice(8, 10));
      const { workers, absent, gaps, alerts, isIrregular } = this.daySummary(dateStr);
      const hasGap = gaps.length > 0;
      const hasAlert = alerts.length > 0;
      const wd = new Date(rosterParseUTC(dateStr)).getUTCDay(); // 0=Sun..6=Sat
      const isWeekend = wd === 0 || wd === 6;
      const phName = ROSTER_PUBLIC_HOLIDAYS[dateStr];

      const workerRows = workers.map((w) => this._renderWorkerRow(w)).join("");
      const absentRows = absent.map((a) => this._renderAbsentRow(a)).join("");
      const gapNote = hasGap
        ? `<div class="roster-gap-note">Gap ${gaps.map(([a, b]) => `${rosterMinToHHMM(a)}–${rosterMinToHHMM(b)}`).join(", ")}</div>`
        : "";
      const cellCls = [
        "roster-cell",
        inCurrentMonth ? "" : "other-month",
        hasGap ? "has-gap" : "",
        hasAlert ? "has-alert" : "",
        isWeekend ? "is-weekend" : "",
        isIrregular ? "is-irregular" : "",
        phName ? "is-holiday" : "",
      ].filter(Boolean).join(" ");
      html += `<div class="${cellCls}" data-date="${dateStr}">
        <div class="roster-cell-head">
          <span class="roster-daynum">${dayNum}</span>
          ${hasAlert ? `<span class="roster-alert-dot" title="${escapeHtml(alerts.map((a) => a.text).join(" / "))}">?</span>` : ""}
        </div>
        ${phName ? `<div class="roster-ph-tag">${escapeHtml(phName)}</div>` : ""}
        <div class="roster-rows">${workerRows}${absentRows}</div>
        ${gapNote}
      </div>`;
    }
    el.innerHTML = html;
    el.querySelectorAll(".roster-cell[data-date]").forEach((cell) => {
      cell.addEventListener("click", () => this._prefillOverrideDate(cell.dataset.date));
    });
  },

  /** A person actually covering a shift today - shown as "Name - AM (hours)"
   * etc. Derrick gets a star and his own highlight style so his own shifts
   * are the easiest thing on the page to spot. */
  _renderWorkerRow(w) {
    const key = ROSTER_PKEY[w.person];
    const slot = this._slotLabel(w.status, w.hours);
    const isMe = w.person === "Derrick";
    let cls = `roster-row roster-row-${key}`;
    if (isMe) cls += " roster-row-you";
    if (w.tag === "alert") cls += " pending-tag";
    else if (w.tag === "confirmed" || w.tag === "swap") cls += " confirmed-tag";
    const name = isMe ? `★ ${ROSTER_PLABEL[w.person]}` : ROSTER_PLABEL[w.person];
    return `<div class="${cls}"><span class="who">${escapeHtml(name)}</span> <span class="hrs">${slot} &middot; ${escapeHtml(w.hours)}</span></div>`;
  },

  /** Someone whose normal working day this is, but who isn't covering it -
   * on leave, or given the day off. This is the "irregularity" signal: named
   * explicitly, in its own muted/struck style so it never looks like a
   * working shift, and it's what flips the cell into the irregular-day color. */
  _renderAbsentRow(a) {
    const text = a.status === "LEAVE" ? "on leave" : "off";
    return `<div class="roster-row roster-row-absent"><span class="who">${escapeHtml(ROSTER_PLABEL[a.person])}</span> <span class="hrs">${text}</span></div>`;
  },

  _prefillOverrideDate(dateStr) {
    document.getElementById("roster-ov-date").value = dateStr;
    document.getElementById("roster-ov-date").scrollIntoView({ behavior: "smooth", block: "center" });
  },

  renderAlerts() {
    const el = document.getElementById("roster-alerts");
    const sorted = [...this.alerts].sort((a, b) => a.date.localeCompare(b.date));
    if (!sorted.length) {
      el.innerHTML = `<p class="empty-state">No open reminders.</p>`;
      return;
    }
    el.innerHTML = sorted.map((a) => `
      <div class="roster-alert-card">
        <span class="date">${escapeHtml(a.date)}</span>
        <span class="text">${escapeHtml(a.text)}</span>
        <button class="btn roster-alert-remove" data-id="${a.id}">Done</button>
      </div>`).join("");
    el.querySelectorAll(".roster-alert-remove").forEach((btn) => {
      btn.addEventListener("click", () => this._removeAlert(btn.dataset.id));
    });
  },

  renderLeaveList() {
    const el = document.getElementById("roster-leave-list");
    const sorted = [...this.leavePeriods].sort((a, b) => a.start.localeCompare(b.start));
    if (!sorted.length) {
      el.innerHTML = `<p class="empty-state">No leave periods recorded.</p>`;
      return;
    }
    el.innerHTML = sorted.map((p) => `
      <div class="roster-leave-card">
        <span class="who-dot" style="background:var(--${ROSTER_PKEY[p.person]})"></span>
        <strong>${escapeHtml(ROSTER_PLABEL[p.person])}</strong>
        <span>${escapeHtml(p.start)} to ${escapeHtml(p.end)}</span>
        <button class="btn roster-leave-remove" data-id="${p.id}">Remove</button>
      </div>`).join("");
    el.querySelectorAll(".roster-leave-remove").forEach((btn) => {
      btn.addEventListener("click", () => this._removeLeave(btn.dataset.id));
    });
  },

  renderOverrideList() {
    const el = document.getElementById("roster-override-list");
    const rows = [...this.overrides.values()].sort((a, b) => a.date.localeCompare(b.date));
    if (!rows.length) {
      el.innerHTML = `<p class="empty-state">No overrides recorded.</p>`;
      return;
    }
    el.innerHTML = rows.map((o) => `
      <div class="roster-override-card">
        <span class="who-dot" style="background:var(--${ROSTER_PKEY[o.person]})"></span>
        <strong>${escapeHtml(o.date)}</strong>
        <span>${escapeHtml(ROSTER_PLABEL[o.person])} — ${escapeHtml(o.status)}${o.hours ? " " + escapeHtml(o.hours) : ""} (${escapeHtml(o.tag || "confirmed")})</span>
        <button class="btn roster-ov-remove" data-date="${o.date}" data-person="${o.person}">Remove</button>
      </div>`).join("");
    el.querySelectorAll(".roster-ov-remove").forEach((btn) => {
      btn.addEventListener("click", () => this._removeOverride(btn.dataset.date, btn.dataset.person));
    });
  },

  async _addLeave() {
    const person = document.getElementById("roster-leave-person").value;
    const start = document.getElementById("roster-leave-start").value;
    const end = document.getElementById("roster-leave-end").value;
    if (!start || !end || end < start) {
      setStatus("Pick a valid start and end date for the leave period.", true);
      return;
    }
    this.leavePeriods.push({ id: `${person}-${start}-${Date.now()}`, person, start, end });
    await this._persistLeave();
    this.renderAll();
  },

  async _removeLeave(id) {
    this.leavePeriods = this.leavePeriods.filter((p) => p.id !== id);
    await this._persistLeave();
    this.renderAll();
  },

  async _persistLeave() {
    await this._saveWithStatus(() => this._saveDriveJson(ROSTER_LEAVE_FILE, { periods: this.leavePeriods }));
  },

  async _addOverride() {
    const date = document.getElementById("roster-ov-date").value;
    const person = document.getElementById("roster-ov-person").value;
    const status = document.getElementById("roster-ov-status").value;
    const hoursInput = document.getElementById("roster-ov-hours").value.trim();
    const tag = document.getElementById("roster-ov-tag").value;
    if (!date) {
      setStatus("Pick a date for the override.", true);
      return;
    }
    const needsHours = status !== "OFF";
    if (needsHours && !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(hoursInput)) {
      setStatus('Enter hours as HH:MM-HH:MM, e.g. "11:00-17:00".', true);
      return;
    }
    const ov = { date, person, status, hours: needsHours ? hoursInput : null, tag };
    this.overrides.set(`${date}|${person}`, ov);
    await this._persistOverrides();
    document.getElementById("roster-ov-hours").value = "";
    this.renderAll();
  },

  async _removeOverride(date, person) {
    this.overrides.delete(`${date}|${person}`);
    await this._persistOverrides();
    this.renderAll();
  },

  async _persistOverrides() {
    await this._saveWithStatus(() => this._saveDriveJson(ROSTER_OVERRIDES_FILE, { overrides: [...this.overrides.values()] }));
  },

  async _addAlert() {
    const date = document.getElementById("roster-alert-date").value;
    const text = document.getElementById("roster-alert-text").value.trim();
    if (!date || !text) {
      setStatus("Pick a date and enter a reminder.", true);
      return;
    }
    this.alerts.push({ id: `alert-${Date.now()}`, date, text });
    await this._persistAlerts();
    document.getElementById("roster-alert-text").value = "";
    this.renderAll();
  },

  async _removeAlert(id) {
    this.alerts = this.alerts.filter((a) => a.id !== id);
    await this._persistAlerts();
    this.renderAll();
  },

  async _persistAlerts() {
    await this._saveWithStatus(() => this._saveDriveJson(ROSTER_ALERTS_FILE, { alerts: this.alerts }));
  },

  async _saveWithStatus(fn) {
    const statusEl = document.getElementById("roster-save-status");
    statusEl.textContent = "Saving…";
    try {
      await fn();
      statusEl.textContent = "Saved.";
    } catch (e) {
      statusEl.textContent = "";
      setStatus("Save failed: " + e.message, true);
    }
  },

  async _loadDriveJson(name) {
    const rootId = await Drive.findChild(CONFIG.ROOT_FOLDER, "root", true);
    if (!rootId) return null;
    const fileId = await Drive.findChild(name, rootId);
    if (!fileId) return null;
    return JSON.parse(await Drive.downloadText(fileId));
  },

  async _saveDriveJson(name, obj) {
    const rootId = await Drive.findChild(CONFIG.ROOT_FOLDER, "root", true);
    if (!rootId) throw new Error(`Couldn't find "${CONFIG.ROOT_FOLDER}" in your Drive.`);
    await Drive.saveJson(name, rootId, obj);
  },
};
