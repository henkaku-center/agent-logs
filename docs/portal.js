// Agent Logs — Participant Portal
// Single-page app: auth, dashboard, consent, survey, sessions

const API = "https://agent-logs-ingestion-321175301732.asia-northeast1.run.app";

// ── Language toggle ──

function getLang() {
  return localStorage.getItem("agent_logs_lang") || (navigator.language?.startsWith("ja") ? "ja" : "en");
}

function setLang(lang) {
  localStorage.setItem("agent_logs_lang", lang);
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-en][data-ja]").forEach((el) => {
    el.textContent = el.dataset[lang];
  });
  const btn = document.getElementById("lang-toggle");
  if (btn) btn.textContent = lang === "en" ? "日本語" : "English";
}

window.toggleLang = function () {
  setLang(getLang() === "en" ? "ja" : "en");
  // Re-render survey form if visible (it uses localizeText at render time)
  const surveyTab = document.getElementById("tab-survey");
  if (surveyTab && surveyTab.style.display !== "none") loadSurvey();
};

/** Pick EN or JA string */
function t(en, ja) {
  return getLang() === "ja" ? ja : en;
}

/** Pick EN or JA text from a "English / 日本語" string */
function localizeText(text) {
  if (!text) return "";
  const parts = text.split(" / ");
  if (parts.length < 2) return text;
  return getLang() === "ja" ? parts.slice(1).join(" / ") : parts[0];
}

// Apply saved language on load
document.addEventListener("DOMContentLoaded", () => setLang(getLang()));

const SURVEY_ORDER = ["pre_course", "mid_course", "post_course"];
function surveyLabel(id) {
  const labels = {
    pre_course: { en: "Pre-Course", ja: "事前" },
    mid_course: { en: "Mid-Course", ja: "中間" },
    post_course: { en: "Post-Course", ja: "事後" },
  };
  return labels[id] ? t(labels[id].en, labels[id].ja) : id;
}
const SURVEY_LABELS = { pre_course: "Pre-Course", mid_course: "Mid-Course", post_course: "Post-Course" };

function getSurveySections(surveyId) {
  const survey = window.SURVEYS?.[surveyId];
  if (!survey) return [];
  if (surveyId === "post_course") {
    return window.SURVEYS.pre_course.sections.filter((s) => s.phase.includes("post_course"));
  }
  return survey.sections;
}

function timeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  if (seconds < 60) return t("just now", "たった今");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return getLang() === "ja" ? `${minutes}分前` : `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return getLang() === "ja" ? `${hours}時間前` : `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return getLang() === "ja" ? `${days}日前` : `${days} day${days === 1 ? "" : "s"} ago`;
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Sign & PDF Export ──

function showSignModal(title, onConfirm) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <h3>${title}</h3>
      <div class="info-box warning">
        <p style="margin-bottom:0">${t("By signing, you confirm that you have read and understood this document.", "署名することにより、この文書を読み、理解したことを確認します。")} <strong>${t("This action cannot be undone.", "この操作は取り消せません。")}</strong></p>
      </div>
      <div style="display:flex;gap:12px;justify-content:flex-end;margin-top:16px">
        <button class="btn btn-secondary" id="modal-cancel">${t("Cancel", "キャンセル")}</button>
        <button class="btn btn-primary" id="modal-confirm">${t("Sign", "署名")}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById("modal-cancel").addEventListener("click", () => overlay.remove());
  document.getElementById("modal-confirm").addEventListener("click", async () => {
    try {
      await onConfirm();
    } finally {
      overlay.remove();
    }
  });
}

function exportPDF(title, contentHtml) {
  const win = window.open("", "_blank");
  const auth = getToken();
  win.document.write(`<!DOCTYPE html>
<html><head><title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; max-width: 700px; margin: 40px auto; font-size: 14px; line-height: 1.6; color: #333; }
  h1 { font-size: 20px; border-bottom: 2px solid #000; padding-bottom: 8px; }
  h2 { font-size: 16px; margin-top: 24px; }
  .meta { color: #666; font-size: 12px; margin-bottom: 24px; }
  .signature { margin-top: 32px; padding-top: 16px; border-top: 2px solid #000; }
  .signature .check { color: #2E7D32; font-weight: bold; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; }
  td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd; }
  th { font-weight: bold; font-size: 12px; text-transform: uppercase; color: #666; }
  @media print { body { margin: 20px; } }
</style></head><body>
  <h1>${title}</h1>
  <div class="meta">Participant: ${auth?.email || ""} · Exported: ${new Date().toLocaleString()}</div>
  ${contentHtml}
</body></html>`);
  win.document.close();
  win.print();
}

// ── Auth ──

function getToken() {
  const token = localStorage.getItem("agent_logs_token");
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      localStorage.removeItem("agent_logs_token");
      return null;
    }
    return { token, email: payload.email };
  } catch {
    localStorage.removeItem("agent_logs_token");
    return null;
  }
}

async function apiFetch(path, opts = {}) {
  const auth = getToken();
  if (!auth) throw new Error("Not authenticated");
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.token}`,
      ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}

// ── Init ──

document.addEventListener("DOMContentLoaded", () => {
  const auth = getToken();
  if (auth) {
    showPortal(auth.email);
  } else {
    showLogin();
  }
  setupTabs();
  setupLogin();
});

function showLogin() {
  document.getElementById("login-section").style.display = "";
  document.getElementById("portal").style.display = "none";
  document.getElementById("auth-bar").innerHTML = '<a href="#" id="login-link">Log in</a>';
  document.getElementById("login-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("login-email")?.focus();
  });
}

function showPortal(email) {
  document.getElementById("login-section").style.display = "none";
  document.getElementById("portal").style.display = "";
  document.getElementById("auth-bar").innerHTML =
    `<span class="user-name">${email}</span> · <a href="#" id="logout-link">Log out</a>`;
  document.getElementById("logout-link").addEventListener("click", (e) => {
    e.preventDefault();
    localStorage.removeItem("agent_logs_token");
    showLogin();
  });
  loadConsent();
}

// ── Login flow ──

function setupLogin() {
  const sendBtn = document.getElementById("login-send-btn");
  const verifyBtn = document.getElementById("login-verify-btn");
  const emailInput = document.getElementById("login-email");

  // Auto-fill and send if email provided via query param (from CLI consent-required screen)
  const urlEmail = new URLSearchParams(window.location.search).get("email");
  if (urlEmail && !getToken()) {
    emailInput.value = urlEmail;
    // Clean URL without reloading
    history.replaceState(null, "", window.location.pathname);
    setTimeout(() => sendBtn.click(), 100);
  }

  emailInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); sendBtn.click(); }
  });

  sendBtn.addEventListener("click", async () => {
    const email = document.getElementById("login-email").value.trim();
    const error = document.getElementById("login-error");
    error.textContent = "";
    if (!email || !email.includes("@")) {
      error.textContent = "Enter a valid email address.";
      return;
    }
    sendBtn.disabled = true;
    sendBtn.textContent = "Sending...";
    try {
      await fetch(`${API}/auth/send-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      }).then(async (r) => {
        if (!r.ok) {
          const d = await r.json();
          throw new Error(d.error || "Failed to send code");
        }
      });
      document.getElementById("login-step-email").style.display = "none";
      document.getElementById("login-step-code").style.display = "";
      document.getElementById("login-code-msg").textContent =
        `Verification code sent to ${email}`;
      // Store email for verify step
      verifyBtn.dataset.email = email;
      document.getElementById("login-code").focus();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = "Send verification code";
    }
  });

  // Auto-submit when 6 digits entered, Enter key also submits
  const codeInput = document.getElementById("login-code");
  codeInput.addEventListener("input", () => {
    if (codeInput.value.trim().length === 6) verifyBtn.click();
  });
  codeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); verifyBtn.click(); }
  });

  verifyBtn.addEventListener("click", async () => {
    const email = verifyBtn.dataset.email;
    const code = document.getElementById("login-code").value.trim();
    const error = document.getElementById("verify-error");
    error.textContent = "";
    if (!code) { error.textContent = "Enter the code."; return; }
    verifyBtn.disabled = true;
    verifyBtn.textContent = "Verifying...";
    try {
      const res = await fetch(`${API}/auth/verify-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Verification failed");
      localStorage.setItem("agent_logs_token", data.token);
      showPortal(data.email);
    } catch (err) {
      error.textContent = err.message;
    } finally {
      verifyBtn.disabled = false;
      verifyBtn.textContent = "Verify";
    }
  });
}

// ── Tabs ──

function setupTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      btn.classList.add("active");
      const tabId = btn.dataset.tab;
      document.querySelectorAll("[id^='tab-']").forEach((s) => {
        s.style.display = s.id === `tab-${tabId}` ? "" : "none";
      });
      // Load data when switching tabs
      if (tabId === "dashboard") loadDashboard();
      if (tabId === "sessions") loadSessions();
      if (tabId === "consent") loadConsent();
      if (tabId === "survey") loadSurvey();
    });
  });
}

// ── Dashboard ──

async function loadDashboard() {
  const container = document.getElementById("dashboard-cards");
  container.innerHTML = '<p class="loading">Loading...</p>';
  try {
    const [sessionsData, consentData, surveyData] = await Promise.all([
      apiFetch("/portal/sessions"),
      apiFetch("/portal/consent"),
      apiFetch("/portal/survey"),
    ]);

    const totalSessions = sessionsData.projects.reduce(
      (sum, p) => sum + p.sessions.length, 0
    );
    const preStudy = surveyData.surveys.pre_course;

    container.innerHTML = `
      <div class="status-card">
        <div class="label">${t("Projects shared", "共有プロジェクト")}</div>
        <div class="value">${sessionsData.projects.length}</div>
      </div>
      <div class="status-card">
        <div class="label">${t("Sessions synced", "同期セッション")}</div>
        <div class="value">${totalSessions}</div>
      </div>
      <div class="status-card">
        <div class="label">${t("Research-use", "研究利用")}</div>
        <div class="value ${consentData.research_use ? "ok" : "off"}">
          ${consentData.research_use ? t("Opted in", "参加") : t("Not enrolled", "未参加")}
        </div>
      </div>
      <div class="status-card">
        <div class="label">${t("Pre-course survey", "事前アンケート")}</div>
        <div class="value ${preStudy.status === "completed" ? "ok" : preStudy.status === "in_progress" ? "warn" : "off"}">
          ${preStudy.status === "completed" ? t("Complete", "完了") : preStudy.status === "in_progress" ? t("In progress", "進行中") : t("Not started", "未開始")}
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<p class="form-error">${err.message}</p>`;
  }
}

// ── Sessions ──

let sessionsOffset = 0;
let allSessionProjects = {};
let sessionsLoaded = false;

async function loadSessions(append = false) {
  const container = document.getElementById("sessions-container");
  if (!append && sessionsLoaded) return;
  if (!append) {
    container.innerHTML = '<p class="loading">Loading sessions...</p>';
    sessionsOffset = 0;
    allSessionProjects = {};
  }

  try {
    const data = await apiFetch(`/portal/sessions?limit=20&offset=${sessionsOffset}`);

    if (!append && data.projects.length === 0) {
      container.innerHTML = `<p>${t("No sessions synced yet. Use Claude Code in a shared project to generate session logs.", "まだセッションが同期されていません。共有プロジェクトでClaude Codeを使用してセッションログを生成してください。")}</p>`;
      return;
    }

    // Merge into existing project groups
    for (const project of data.projects) {
      if (!allSessionProjects[project.project_path]) {
        allSessionProjects[project.project_path] = [];
      }
      allSessionProjects[project.project_path].push(...project.sessions);
    }

    sessionsOffset += data.limit;
    sessionsLoaded = true;

    renderSessions(container, data.has_more);
  } catch (err) {
    if (!append) {
      container.innerHTML = `<p class="form-error">${err.message}</p>`;
    }
  }
}

function renderSessions(container, hasMore) {
  const projectsHtml = Object.entries(allSessionProjects).map(([path, sessions]) => {
    const name = path.split("/").pop();
    const count = sessions.length;
    return `
      <details class="session-project">
        <summary class="session-project-header">
          <span class="session-project-name">${escapeHtml(name)}</span>
          <span class="session-project-count">${count} ${t("session" + (count === 1 ? "" : "s"), "セッション")}</span>
        </summary>
        <div class="session-project-body">
          ${sessions.map((s) => {
            const title = s.title || "Untitled session";
            const truncated = title.length > 80 ? title.slice(0, 80) + "…" : title;
            const ago = timeAgo(s.last_timestamp);
            const revokedClass = s.revoked ? " session-revoked" : "";
            const toggleLabel = s.revoked ? t("Restore", "復元") : t("Withdraw", "撤回");
            const toggleClass = "btn-secondary";
            return `
              <div class="session-row${revokedClass}">
                <div style="flex:1">
                  <div class="session-title">${escapeHtml(truncated)}</div>
                  <div class="session-meta">${ago} · ${s.user_count} ${t("prompts", "プロンプト")} · ${s.assistant_count} ${t("responses", "応答")}${s.revoked ? ` · <span style="color:#C62828">${t("withdrawn", "撤回済み")}</span>` : ""}</div>
                </div>
                <button class="btn ${toggleClass}" style="font-size:12px;padding:4px 12px" onclick="toggleRevoke('${escapeHtml(path)}','${s.session_id}',${!s.revoked},this)">${toggleLabel}</button>
              </div>
            `;
          }).join("")}
        </div>
      </details>
    `;
  }).join("");

  const loadMoreHtml = hasMore
    ? `<div style="text-align:center;margin:24px 0"><button class="btn btn-secondary" id="load-more-sessions">${t("Load more sessions", "さらに読み込む")}</button></div>`
    : "";

  container.innerHTML = projectsHtml + loadMoreHtml;

  document.getElementById("load-more-sessions")?.addEventListener("click", () => {
    loadSessions(true);
  });
}

// ── Consent ──

let consentSigned = false;

async function loadConsent() {
  if (consentSigned) return;
  const eduToggle = document.getElementById("educational-toggle");
  const resToggle = document.getElementById("research-toggle");
  const signArea = document.getElementById("consent-sign-area");

  try {
    const data = await apiFetch("/portal/consent");
    const isSigned = !!data.signed_at;
    if (isSigned) consentSigned = true;

    // Educational-use toggle — on by default for unsigned
    eduToggle.checked = true;
    if (isSigned) {
      eduToggle.disabled = true;
      eduToggle.closest(".consent-toggle-row").classList.add("disabled");
    } else {
      // Clone to remove stale listeners
      const newEdu = eduToggle.cloneNode(true);
      eduToggle.parentNode.replaceChild(newEdu, eduToggle);
    }

    // Research-use toggle — always active, can be changed anytime
    resToggle.checked = isSigned ? data.research_use : true;
    const newRes = resToggle.cloneNode(true);
    resToggle.parentNode.replaceChild(newRes, resToggle);
    newRes.addEventListener("change", async () => {
      try {
        await apiFetch("/portal/consent", {
          method: "POST",
          body: { research_use: newRes.checked },
        });
      } catch (err) {
        newRes.checked = !newRes.checked;
        alert(err.message);
      }
    });

    if (isSigned) {
      signArea.innerHTML = `
        <div class="info-box" style="margin-top:24px">
          <strong>✓ ${t("Signed", "署名済み")} ${new Date(data.signed_at).toLocaleDateString()}</strong>
          <p style="margin-bottom:0">${t("Your consent form has been signed. Research-use can be changed anytime.", "同意書は署名済みです。研究利用はいつでも変更できます。")}</p>
        </div>
        <button class="btn btn-secondary" id="consent-export-pdf" style="margin-top:12px">${t("Export PDF", "PDFをエクスポート")}</button>
      `;
      document.getElementById("consent-export-pdf").addEventListener("click", async () => {
        try {
          const auth = getToken();
          const resp = await fetch(`${API}/portal/consent/pdf`, {
            headers: { Authorization: `Bearer ${auth.token}` },
          });
          if (!resp.ok) throw new Error("Failed to fetch consent PDF");
          const html = await resp.text();
          const win = window.open("", "_blank");
          win.document.write(html);
          win.document.close();
          win.print();
        } catch (err) {
          alert(err.message);
        }
      });
    } else {
      signArea.innerHTML = `
        <div class="info-box" style="margin-top:24px">
          <p style="margin-bottom:0">${t("I have read and understood the above information. I understand that my participation is voluntary, that I may withdraw at any time during the course and up to one month after the end of classes, and that my decision has no effect on my grades or course experience.", "上記の情報を読み、理解しました。参加は任意であること、授業期間中および授業終了後1ヶ月以内であればいつでも同意を撤回できること、この決定が成績やコースでの経験に影響を与えないことを理解しています。")}</p>
        </div>
        <button class="btn btn-primary" id="consent-sign-btn" style="margin-top:12px">${t("Sign consent form", "同意書に署名")}</button>
      `;
      document.getElementById("consent-sign-btn").addEventListener("click", () => {
        const eduChecked = document.getElementById("educational-toggle").checked;
        if (!eduChecked) {
          alert(t("You must agree to Educational-use before signing the consent form. Research-use is optional and can be changed anytime.", "同意書に署名するには、教育利用に同意する必要があります。研究利用は任意であり、いつでも変更できます。"));
          return;
        }
        const consentHtml = document.getElementById("consent-form-content")?.innerHTML || "";
        const researchUse = newRes.checked;
        showSignModal(t("Sign Informed Consent", "インフォームド・コンセントに署名"), async () => {
          await apiFetch("/portal/consent/sign", {
            method: "POST",
            body: { consent_html: consentHtml, research_use: researchUse },
          });
          consentSigned = false;
          loadConsent();
        });
      });
    }
  } catch (err) {
    signArea.innerHTML = `<p class="form-error">${err.message}</p>`;
  }
}

// ── Survey ──

async function loadSurvey() {
  const container = document.getElementById("survey-container");
  container.innerHTML = '<p class="loading">Loading survey...</p>';

  try {
    const data = await apiFetch("/portal/survey");
    const preStudy = data.surveys.pre_course;

    // Determine which survey to show the form for
    // Priority: URL hash > first editable (not signed, not locked)
    let activeSurveyId = null;
    let activeSurvey = null;

    // Check if a specific survey was requested via onclick
    const requested = container.dataset.requestedSurvey;
    if (requested && data.surveys[requested] && !data.surveys[requested].signed_at && data.surveys[requested].status !== "locked") {
      activeSurveyId = requested;
      activeSurvey = data.surveys[requested];
      delete container.dataset.requestedSurvey;
    }

    if (!activeSurvey) {
      for (const id of SURVEY_ORDER) {
        const s = data.surveys[id];
        if (s.status !== "locked" && !s.signed_at) {
          activeSurveyId = id;
          activeSurvey = s;
          break;
        }
      }
    }

    const statusHtml = SURVEY_ORDER.map((id) => {
      const s = data.surveys[id];
      const label = surveyLabel(id);
      if (s.signed_at) {
        return `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #E0E0E0"><span>${label}</span><span class="status shared">${t("Complete", "完了")}</span></div>`;
      }
      if (s.status === "locked") {
        return `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #E0E0E0"><span>${label}</span><span class="status withdrawn">${t("Locked", "未公開")}</span></div>`;
      }
      const badge = s.status === "completed" ? `<span class="status" style="background:#E8F5E9;color:#2E7D32">${t("Submitted", "提出済み")}</span>`
        : s.status === "in_progress" ? `<span class="status" style="background:#FFF3E0;color:#E65100">${t("In progress", "進行中")}</span>`
        : `<span class="status withdrawn">${t("Not started", "未開始")}</span>`;
      return `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #E0E0E0;cursor:pointer" onclick="openSurvey('${id}')"><span style="color:var(--blue);text-decoration:underline">${label}</span>${badge}</div>`;
    }).join("");

    const signButtons = SURVEY_ORDER.map((id) => {
      const s = data.surveys[id];
      if (s.signed_at) {
        return `<div style="margin:8px 0"><span style="color:#2E7D32;font-weight:700">✓ ${surveyLabel(id)} ${t("signed", "署名済み")} ${new Date(s.signed_at).toLocaleDateString()}</span>
          <button class="btn btn-secondary" style="margin-left:8px" onclick="exportSurveyPDF('${id}')">${t("Export PDF", "PDFをエクスポート")}</button></div>`;
      }
      if (s.status === "completed") {
        return `<div style="margin:8px 0">
          <button class="btn btn-primary" onclick="signSurvey('${id}')">${t("Sign", "署名")} ${surveyLabel(id)} ${t("survey", "アンケート")}</button>
          <button class="btn btn-secondary" style="margin-left:8px" onclick="exportSurveyPDF('${id}')">${t("Export PDF", "PDFをエクスポート")}</button>
        </div>`;
      }
      return "";
    }).join("");

    if (!activeSurvey) {
      container.innerHTML = `<div style="margin-bottom:24px">${statusHtml}</div>${signButtons}<div class="info-box"><strong>${t("All surveys signed.", "全てのアンケートが署名されました。")}</strong> ${t("Thank you for your participation.", "ご参加ありがとうございます。")}</div>`;
      return;
    }

    const responses = activeSurvey.responses || {};
    container.innerHTML = `<div style="margin-bottom:24px">${statusHtml}</div>${signButtons}` + renderSurveyForm(activeSurveyId, responses);

    // Auto-save on change
    let saveTimeout;
    container.addEventListener("change", () => {
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => saveSurvey(false), 2000);
    });

    // Submit button
    document.getElementById("survey-submit")?.addEventListener("click", () => saveSurvey(true));
    document.getElementById("survey-save")?.addEventListener("click", () => saveSurvey(false));
  } catch (err) {
    container.innerHTML = `<p class="form-error">${err.message}</p>`;
  }
}

function collectSurveyResponses() {
  const form = document.getElementById("survey-form");
  if (!form) return null;

  const formData = new FormData(form);
  const responses = {};
  const checkboxes = {};
  for (const [key, value] of formData.entries()) {
    const el = form.querySelector(`[name="${key}"]`);
    if (el && el.type === "checkbox") {
      if (!checkboxes[key]) checkboxes[key] = [];
      checkboxes[key].push(value);
    } else {
      responses[key] = value;
    }
  }
  for (const [key, values] of Object.entries(checkboxes)) {
    responses[key] = values.join("|||");
  }
  return responses;
}

function validateSurvey(surveyId) {
  const survey = window.SURVEYS?.[surveyId];
  if (!survey) return [];

  const sections = getSurveySections(surveyId);
  const form = document.getElementById("survey-form");
  if (!form) return [];

  const missing = [];
  for (const section of sections) {
    for (const q of section.questions) {
      if (q.type === "vignette") {
        // Vignette has 3 sub-parts: _a (likert), _b (text), _c (text)
        if (!form.querySelector(`[name="${q.id}_a"]:checked`)) missing.push({ section: section.id, question: q.id + "_a" });
        const bVal = form.querySelector(`[name="${q.id}_b"]`)?.value?.trim();
        if (!bVal) missing.push({ section: section.id, question: q.id + "_b" });
      } else if (q.type === "radio" || q.type === "likert") {
        if (!form.querySelector(`[name="${q.id}"]:checked`)) missing.push({ section: section.id, question: q.id });
      } else if (q.type === "text" || q.type === "textarea") {
        const val = form.querySelector(`[name="${q.id}"]`)?.value?.trim();
        if (!val) missing.push({ section: section.id, question: q.id });
      } else if (q.type === "percentage") {
        for (let ci = 0; ci < q.categories.length; ci++) {
          const val = form.querySelector(`[name="${q.id}_${ci}"]`)?.value?.trim();
          if (!val) missing.push({ section: section.id, question: `${q.id}_${ci}` });
        }
      }
      // checkbox is optional (can select none)
    }
  }
  return missing;
}

async function saveSurvey(completed) {
  const form = document.getElementById("survey-form");
  if (!form) return;

  const surveyId = form.dataset.surveyId || "pre_course";
  const responses = collectSurveyResponses();

  if (completed) {
    const missing = validateSurvey(surveyId);
    if (missing.length > 0) {
      const sections = [...new Set(missing.map((m) => m.section))];
      alert(`Please complete all questions before submitting.\n\nMissing responses in: ${sections.join(", ")}`);
      // Scroll to first missing question
      const firstMissing = form.querySelector(`[name="${missing[0].question}"]`);
      if (firstMissing) firstMissing.closest(".survey-question")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
  }

  try {
    await apiFetch("/portal/survey", {
      method: "POST",
      body: { survey_id: surveyId, responses, completed },
    });
    if (completed) {
      loadSurvey();
    }
  } catch (err) {
    alert(`Failed to save: ${err.message}`);
  }
}

function renderSurveyForm(surveyId, responses) {
  const survey = window.SURVEYS?.[surveyId];
  if (!survey) return "<p>Survey definition not found.</p>";

  const sections = getSurveySections(surveyId);

  const html = sections.map((section, si) => {
    const scale = section.scale || section.vignetteScale;
    const sectionTitle = localizeText(section.title);
    const sectionDesc = localizeText(section.description);
    const questionsHtml = section.questions.map((q, qi) => {
      const num = qi + 1;
      const qText = localizeText(q.text);
      if (q.type === "radio") {
        return `<div class="survey-question">
          <div class="question-text">${num}. ${qText}</div>
          <div class="radio-group">
            ${q.options.map((opt) => `
              <label><input type="radio" name="${q.id}" value="${opt}" ${responses[q.id] === opt ? "checked" : ""}> ${localizeText(opt)}</label>
            `).join("")}
          </div>
        </div>`;
      }

      if (q.type === "likert") {
        const s = scale || { min: 1, max: 7, minLabel: "", maxLabel: "" };
        const range = Array.from({ length: s.max - s.min + 1 }, (_, i) => s.min + i);
        return `<div class="survey-question">
          <div class="question-text">${num}. ${qText}</div>
          <div class="likert-scale">
            ${range.map((n) => `
              <label><input type="radio" name="${q.id}" value="${n}" ${responses[q.id] == n ? "checked" : ""}><span>${n}</span></label>
            `).join("")}
          </div>
          <div class="likert-labels"><span>${localizeText(s.minLabel)}</span><span>${localizeText(s.maxLabel)}</span></div>
        </div>`;
      }

      if (q.type === "vignette") {
        const vs = section.vignetteScale || { min: 1, max: 7, minLabel: "", maxLabel: "" };
        const range = Array.from({ length: vs.max - vs.min + 1 }, (_, i) => vs.min + i);
        return `<div class="survey-question">
          <div class="question-text"><strong>${num}. ${qText}</strong></div>
          <p style="margin:8px 0">${t("A. How appropriate is this task for AI?", "A. このタスクはAIにどの程度適していますか？")}</p>
          <div class="likert-scale">
            ${range.map((n) => `
              <label><input type="radio" name="${q.id}_a" value="${n}" ${responses[q.id + "_a"] == n ? "checked" : ""}><span>${n}</span></label>
            `).join("")}
          </div>
          <div class="likert-labels"><span>${localizeText(vs.minLabel)}</span><span>${localizeText(vs.maxLabel)}</span></div>
          <p style="margin:12px 0 4px">${t("B. Explain your reasoning (1-2 sentences)", "B. 理由を説明してください（1〜2文）")}</p>
          <textarea class="survey-text" name="${q.id}_b" rows="2">${responses[q.id + "_b"] || ""}</textarea>
          <p style="margin:12px 0 4px">${t("C. Which tool would you use?", "C. どのツールを使いますか？")}</p>
          <input class="form-input" name="${q.id}_c" value="${responses[q.id + "_c"] || ""}" placeholder="${t("e.g., Claude Code, ChatGPT, none...", "例：Claude Code、ChatGPT、なし...")}">
        </div>`;
      }

      if (q.type === "text") {
        return `<div class="survey-question">
          <div class="question-text">${num}. ${qText}</div>
          <input class="form-input" name="${q.id}" value="${responses[q.id] || ""}" placeholder="${localizeText(q.placeholder) || ""}">
        </div>`;
      }

      if (q.type === "textarea") {
        return `<div class="survey-question">
          <div class="question-text">${num}. ${qText}</div>
          <textarea class="survey-text" name="${q.id}" rows="3">${responses[q.id] || ""}</textarea>
        </div>`;
      }

      if (q.type === "checkbox") {
        const selected = (responses[q.id] || "").split("|||");
        return `<div class="survey-question">
          <div class="question-text">${num}. ${qText}</div>
          <div class="radio-group">
            ${q.options.map((opt) => `
              <label><input type="checkbox" name="${q.id}" value="${opt}" ${selected.includes(opt) ? "checked" : ""}> ${localizeText(opt)}</label>
            `).join("")}
          </div>
        </div>`;
      }

      if (q.type === "percentage") {
        return `<div class="survey-question">
          <div class="question-text">${num}. ${qText}</div>
          <div class="percentage-inputs">
            ${q.categories.map((cat, ci) => `
              <div style="display:flex;align-items:center;gap:8px;margin:6px 0">
                <label style="flex:1;font-weight:400">${localizeText(cat)}</label>
                <input type="number" class="form-input" style="width:80px;margin:0" name="${q.id}_${ci}" value="${responses[q.id + "_" + ci] || ""}" min="0" max="100" placeholder="%">
              </div>
            `).join("")}
            <div style="text-align:right;font-weight:700;margin-top:8px" id="${q.id}_total">Total: 0%</div>
          </div>
        </div>`;
      }

      return "";
    }).join("");

    return `<div class="survey-section">
      <h3>${section.id}. ${sectionTitle}</h3>
      <p class="section-desc">${sectionDesc}</p>
      ${questionsHtml}
    </div>`;
  }).join("");

  return `
    <form id="survey-form" data-survey-id="${surveyId}">
      <div class="info-box">
        <strong>${localizeText(survey.title)}</strong>
        <p style="margin-bottom:0">${localizeText(survey.description)}</p>
      </div>
      ${html}
      <div class="survey-nav">
        <button type="button" class="btn btn-secondary" id="survey-save">${t("Save progress", "保存")}</button>
        <button type="button" class="btn btn-primary" id="survey-submit">${t("Submit survey", "アンケートを提出")}</button>
      </div>
    </form>
  `;
}

window.toggleRevoke = async function(projectPath, sessionId, revoked, btn) {
  const origText = btn.textContent;
  btn.textContent = "...";
  btn.disabled = true;

  try {
    await apiFetch("/portal/revoke", {
      method: "POST",
      body: { project_path: projectPath, session_id: sessionId, revoked },
    });

    // Update local state
    for (const sessions of Object.values(allSessionProjects)) {
      const s = sessions.find((s) => s.session_id === sessionId);
      if (s) { s.revoked = revoked; break; }
    }

    // Update row in-place
    const row = btn.closest(".session-row");
    if (revoked) {
      row.classList.add("session-revoked");
      btn.textContent = t("Restore", "復元");
      const meta = row.querySelector(".session-meta");
      if (meta && !meta.innerHTML.includes("withdrawn")) {
        meta.innerHTML += ` · <span style="color:var(--dark-grey)">${t("withdrawn", "撤回済み")}</span>`;
      }
    } else {
      row.classList.remove("session-revoked");
      btn.textContent = t("Withdraw", "撤回");
      const meta = row.querySelector(".session-meta");
      if (meta) meta.innerHTML = meta.innerHTML.replace(/ · <span[^>]*>withdrawn<\/span>/, "");
    }
    btn.style.cssText = "font-size:12px;padding:4px 12px";
    btn.setAttribute("onclick", `toggleRevoke('${escapeHtml(projectPath)}','${sessionId}',${!revoked},this)`);
  } catch (err) {
    btn.textContent = origText;
    alert(`Failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
};

window.scrollToSurveyForm = function() {
  document.getElementById("survey-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
};

window.openSurvey = function(surveyId) {
  const container = document.getElementById("survey-container");
  container.dataset.requestedSurvey = surveyId;
  loadSurvey();
};

// Global handlers for survey sign/export (called from onclick in rendered HTML)
window.signSurvey = function(surveyId) {
  const label = SURVEY_LABELS[surveyId];
  showSignModal(`${t("Sign", "署名")} ${label} ${t("Survey", "アンケート")}`, async () => {
    await apiFetch("/portal/survey/sign", { method: "POST", body: { survey_id: surveyId } });
    loadSurvey();
  });
};

window.exportSurveyPDF = async function(surveyId) {
  const label = SURVEY_LABELS[surveyId];
  try {
    const data = await apiFetch("/portal/survey");
    const survey = data.surveys[surveyId];
    if (!survey || !survey.responses) { alert("No responses to export."); return; }

    const responses = survey.responses;
    const sections = getSurveySections(surveyId);

    // Build HTML with questions and answers
    let html = "";
    for (const section of sections) {
      html += `<h2>${section.id}. ${escapeHtml(section.title)}</h2>`;
      for (const q of section.questions) {
        const qText = q.text.split(" / ")[0]; // English only for PDF
        if (q.type === "vignette") {
          html += `<p style="margin:12px 0 4px"><strong>${escapeHtml(qText)}</strong></p>`;
          html += `<table>`;
          html += `<tr><td style="width:40%">Appropriateness (1-7)</td><td>${escapeHtml(responses[q.id + "_a"] || "—")}</td></tr>`;
          html += `<tr><td>Reasoning</td><td>${escapeHtml(responses[q.id + "_b"] || "—")}</td></tr>`;
          html += `<tr><td>Tool choice</td><td>${escapeHtml(responses[q.id + "_c"] || "—")}</td></tr>`;
          html += `</table>`;
        } else if (q.type === "percentage") {
          html += `<p style="margin:12px 0 4px"><strong>${escapeHtml(qText)}</strong></p><table>`;
          for (let ci = 0; ci < (q.categories || []).length; ci++) {
            const cat = q.categories[ci].split(" / ")[0];
            html += `<tr><td>${escapeHtml(cat)}</td><td>${escapeHtml(responses[q.id + "_" + ci] || "—")}%</td></tr>`;
          }
          html += `</table>`;
        } else {
          const answer = responses[q.id] || "—";
          html += `<table><tr><td style="width:60%">${escapeHtml(qText)}</td><td><strong>${escapeHtml(String(answer))}</strong></td></tr></table>`;
        }
      }
    }

    const signLine = survey.signed_at
      ? `<p class="check">✓ Signed by participant on ${new Date(survey.signed_at).toLocaleString()}</p>`
      : `<p style="color:#666">Not yet signed</p>`;

    exportPDF(`${label} Survey — Agent Logs`, `${html}<div class="signature">${signLine}</div>`);
  } catch (err) {
    alert(err.message);
  }
};
