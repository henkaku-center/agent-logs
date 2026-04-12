// Agent Logs — Language toggle (shared between index.html and portal.html)

function getLang() {
  return localStorage.getItem("agent_logs_lang") || (navigator.language?.startsWith("ja") ? "ja" : "en");
}

function setLang(lang) {
  localStorage.setItem("agent_logs_lang", lang);
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-en][data-ja]").forEach((el) => {
    el.innerHTML = el.dataset[lang];
  });
  const btn = document.getElementById("lang-toggle");
  if (btn) btn.textContent = lang === "en" ? "日本語" : "English";
}

function toggleLang() {
  setLang(getLang() === "en" ? "ja" : "en");
  // Re-render survey if visible (uses localizeText at render time)
  if (typeof loadSurvey === "function") {
    const tab = document.getElementById("tab-survey");
    if (tab && tab.style.display !== "none") loadSurvey();
  }
}

// Apply saved language once DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => setLang(getLang()));
} else {
  setLang(getLang());
}
