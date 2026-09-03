// Top-level wiring: sign-in, tab switching, initial load.

window.addEventListener("DOMContentLoaded", () => {
  Drive.init(onSignedIn);
  document.getElementById("signin-btn").addEventListener("click", () => Drive.signIn());
  Drive.trySilentSignIn(); // restore the session after a refresh instead of requiring Sign in again

  const sidebarWrap = document.getElementById("sidebar-wrap");
  const sidebarToggle = document.getElementById("sidebar-toggle");
  const collapsed = localStorage.getItem("mrit_sidebar_collapsed") === "1";
  sidebarWrap.classList.toggle("collapsed", collapsed);
  sidebarToggle.addEventListener("click", () => {
    const isCollapsed = sidebarWrap.classList.toggle("collapsed");
    sidebarToggle.title = isCollapsed ? "Expand invoice list" : "Collapse invoice list";
    localStorage.setItem("mrit_sidebar_collapsed", isCollapsed ? "1" : "0");
  });

  document.getElementById("invoice-search").addEventListener("input", (e) => Review.setSearch(e.target.value));

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
  document.querySelectorAll(".report-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchReportTab(btn.dataset.report));
  });
  document.querySelectorAll(".memory-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchMemoryTab(btn.dataset.memtab));
  });
  document.querySelectorAll(".sales-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchSalesTab(btn.dataset.salestab));
  });

  document.getElementById("sync-btn").addEventListener("click", doSync);

  const salesModal = document.getElementById("sales-detail-modal");
  document.getElementById("sales-detail-close").addEventListener("click", () => Sales.closeDetail());
  salesModal.addEventListener("click", (e) => { if (e.target === salesModal) Sales.closeDetail(); });

  const memoryModal = document.getElementById("memory-detail-modal");
  document.getElementById("memory-detail-close").addEventListener("click", () => Memory.closeDetail());
  memoryModal.addEventListener("click", (e) => { if (e.target === memoryModal) Memory.closeDetail(); });

  const lookupModal = document.getElementById("lookup-detail-modal");
  document.getElementById("lookup-detail-close").addEventListener("click", () => Lookup.closeDetail());
  lookupModal.addEventListener("click", (e) => { if (e.target === lookupModal) Lookup.closeDetail(); });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!memoryModal.classList.contains("hidden")) Memory.closeDetail();
    if (!lookupModal.classList.contains("hidden")) Lookup.closeDetail();
    if (!salesModal.classList.contains("hidden")) Sales.closeDetail();
  });
});

async function onSignedIn() {
  document.getElementById("signin-btn").classList.add("hidden");
  document.getElementById("signed-in-as").classList.remove("hidden");
  document.getElementById("signed-in-as").textContent = "Signed in";
  document.getElementById("tabs").classList.remove("hidden");
  document.getElementById("app").classList.remove("hidden");
  document.getElementById("sync-area").classList.remove("hidden");

  try {
    await Review.load();
  } catch (e) {
    setStatus(e.message, true);
  }
}

/** Re-fetches the Aronium DB and the invoice list from Drive, bypassing every
 * module's own loaded-once cache - the fix for "I forgot my Android phone
 * and can't tell if this is today's data." Re-renders whatever tab/sub-tab
 * is currently on screen so the refresh is visible immediately. */
async function doSync() {
  const btn = document.getElementById("sync-btn");
  const statusEl = document.getElementById("sync-status");
  btn.disabled = true;
  statusEl.textContent = "Syncing…";
  try {
    // Sequential, not Promise.all: Reports.ensureLoaded() reads Review.invoices
    // to build confirmedLines, and Review.load() only reassigns that array
    // atomically at the very end of its own fetch - running both at once risks
    // Reports reading the pre-sync list if it finishes first.
    await Review.load();
    await Reports.forceReload();
    Memory.loaded = false;
    Sales.loaded = false;
    Lookup.latestDataDate = null;
    await rerenderActiveTab();
  } catch (e) {
    statusEl.textContent = "";
    setStatus(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

let currentTab = "review";
function switchTab(name) {
  currentTab = name;
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
  if (name === "sales") loadSalesTab();
  if (name === "reports") loadCurrentReport();
  if (name === "memory") loadMemoryTab();
  if (name === "lookup") loadLookupTab();
}

/** Re-renders whichever tab/sub-tab is currently visible - used after a
 * Sync so the refreshed data shows up without the user having to re-click
 * into the tab themselves. Review is excluded: doSync() already reloaded
 * and re-rendered its list directly. */
async function rerenderActiveTab() {
  if (currentTab === "sales") await loadSalesTab();
  else if (currentTab === "reports") await loadCurrentReport();
  else if (currentTab === "memory") await loadMemoryTab();
  else if (currentTab === "lookup") { lookupLoaded = false; await loadLookupTab(); }
}

let currentSalesTab = "latestday";
function switchSalesTab(name) {
  currentSalesTab = name;
  document.querySelectorAll(".sales-tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.salestab === name));
  document.querySelectorAll(".sales-panel").forEach((p) => p.classList.toggle("active", p.id === `sales-${name}`));
  loadSalesTab();
}

async function loadSalesTab() {
  try {
    if (currentSalesTab === "latestday") await Sales.renderLatestDay();
    else if (currentSalesTab === "range") await Sales.renderRange();
  } catch (e) {
    setStatus(e.message, true);
  }
}

let lookupLoaded = false;
async function loadLookupTab() {
  try {
    await Lookup.ensureLoaded();
    if (!lookupLoaded) {
      lookupLoaded = true;
      Lookup.renderSearchPanel();
      Lookup.renderBatchPanel();
      await Lookup.renderListingPanel();
    }
  } catch (e) {
    setStatus(e.message, true);
  }
}

let currentMemoryTab = "products";
function switchMemoryTab(name) {
  currentMemoryTab = name;
  document.querySelectorAll(".memory-tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.memtab === name));
  document.querySelectorAll(".memory-panel").forEach((p) => p.classList.toggle("active", p.id === `memory-${name}`));
  loadMemoryTab();
}

async function loadMemoryTab() {
  try {
    await Memory.ensureLoaded();
    if (currentMemoryTab === "products") Memory.renderList();
    else if (currentMemoryTab === "insights") Memory.renderInsights();
    else if (currentMemoryTab === "new") Memory.renderNewProducts();
  } catch (e) {
    document.getElementById("memory-status").textContent = "";
    setStatus(e.message, true);
  }
}

let currentReport = "margin";
function switchReportTab(name) {
  currentReport = name;
  document.querySelectorAll(".report-tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.report === name));
  document.querySelectorAll(".report-panel").forEach((p) => p.classList.toggle("active", p.id === `report-${name}`));
  loadCurrentReport();
}

async function loadCurrentReport() {
  try {
    if (currentReport === "margin") await Reports.renderMargin();
    else if (currentReport === "trend") await Reports.renderTrend();
    else if (currentReport === "redflag") await Reports.renderRedFlag();
  } catch (e) {
    document.getElementById("report-status").textContent = "";
    setStatus(e.message, true);
  }
}
