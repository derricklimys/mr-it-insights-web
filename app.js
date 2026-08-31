// Top-level wiring: sign-in, tab switching, initial load.

window.addEventListener("DOMContentLoaded", () => {
  Drive.init(onSignedIn);
  document.getElementById("signin-btn").addEventListener("click", () => Drive.signIn());

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
  document.querySelectorAll(".report-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchReportTab(btn.dataset.report));
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
