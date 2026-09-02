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

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
  document.querySelectorAll(".report-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchReportTab(btn.dataset.report));
  });
  document.querySelectorAll(".memory-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchMemoryTab(btn.dataset.memtab));
  });

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
  });
});

async function onSignedIn() {
  document.getElementById("signin-btn").classList.add("hidden");
  document.getElementById("signed-in-as").classList.remove("hidden");
  document.getElementById("signed-in-as").textContent = "Signed in";
  document.getElementById("tabs").classList.remove("hidden");
  document.getElementById("app").classList.remove("hidden");

  try {
    await Review.load();
  } catch (e) {
    setStatus(e.message, true);
  }
}

function switchTab(name) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
  if (name === "reports") loadCurrentReport();
  if (name === "memory") loadMemoryTab();
  if (name === "lookup") loadLookupTab();
}

let lookupLoaded = false;
async function loadLookupTab() {
  try {
    await Lookup.ensureLoaded();
    if (!lookupLoaded) {
      lookupLoaded = true;
      Lookup.renderSearchPanel();
      Lookup.renderBatchPanel();
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
