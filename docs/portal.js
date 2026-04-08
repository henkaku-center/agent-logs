// Agent Logs — Student Portal
// Single-page app: auth, dashboard, consent, survey, sessions

const API = "https://agent-logging-185303388981.asia-northeast1.run.app";

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
  document.getElementById("auth-bar").innerHTML = "";
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
  loadDashboard();
}

// ── Login flow ──

function setupLogin() {
  const sendBtn = document.getElementById("login-send-btn");
  const verifyBtn = document.getElementById("login-verify-btn");

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
    } catch (err) {
      error.textContent = err.message;
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = "Send verification code";
    }
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
    const preStudy = surveyData.surveys.pre_study;

    container.innerHTML = `
      <div class="status-card">
        <div class="label">Projects shared</div>
        <div class="value">${sessionsData.projects.length}</div>
      </div>
      <div class="status-card">
        <div class="label">Sessions synced</div>
        <div class="value">${totalSessions}</div>
      </div>
      <div class="status-card">
        <div class="label">Research consent</div>
        <div class="value ${consentData.research_use ? "ok" : "off"}">
          ${consentData.research_use ? "Opted in" : "Not enrolled"}
        </div>
      </div>
      <div class="status-card">
        <div class="label">Pre-study survey</div>
        <div class="value ${preStudy.status === "completed" ? "ok" : preStudy.status === "in_progress" ? "warn" : "off"}">
          ${preStudy.status === "completed" ? "Complete" : preStudy.status === "in_progress" ? "In progress" : "Not started"}
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<p class="form-error">${err.message}</p>`;
  }
}

// ── Sessions ──

async function loadSessions() {
  const container = document.getElementById("sessions-container");
  container.innerHTML = '<p class="loading">Loading sessions...</p>';
  try {
    const data = await apiFetch("/portal/sessions");
    if (data.projects.length === 0) {
      container.innerHTML = "<p>No sessions synced yet. Use Claude Code in a shared project to generate session logs.</p>";
      return;
    }
    container.innerHTML = data.projects.map((project) => `
      <div class="session-project">
        <h3>${project.project_path.split("/").pop()}</h3>
        ${project.sessions.map((s) => `
          <div class="session-row">
            <span class="session-date">${new Date(s.first_timestamp).toLocaleDateString()}</span>
            <span class="session-stats">${s.user_count} prompts · ${s.assistant_count} responses</span>
          </div>
        `).join("")}
      </div>
    `).join("");
  } catch (err) {
    container.innerHTML = `<p class="form-error">${err.message}</p>`;
  }
}

// ── Consent ──

async function loadConsent() {
  const toggle = document.getElementById("research-toggle");
  const status = document.getElementById("consent-status");
  const label = document.getElementById("consent-label");

  try {
    const data = await apiFetch("/portal/consent");
    toggle.checked = data.research_use;
    updateConsentUI(data.research_use, status, label);

    // Remove old listener by cloning
    const newToggle = toggle.cloneNode(true);
    toggle.parentNode.replaceChild(newToggle, toggle);
    newToggle.addEventListener("change", async () => {
      try {
        const result = await apiFetch("/portal/consent", {
          method: "POST",
          body: { research_use: newToggle.checked },
        });
        updateConsentUI(result.research_use, status, label);
      } catch (err) {
        newToggle.checked = !newToggle.checked;
        alert(err.message);
      }
    });
  } catch (err) {
    status.textContent = err.message;
    status.className = "consent-status off";
  }
}

function updateConsentUI(isOn, statusEl, labelEl) {
  statusEl.textContent = isOn ? "Opted in" : "Not enrolled";
  statusEl.className = `consent-status ${isOn ? "on" : "off"}`;
  labelEl.textContent = isOn ? "Research-use enabled" : "Opt in to Research-use";
}

// ── Survey ──

async function loadSurvey() {
  const container = document.getElementById("survey-container");
  container.innerHTML = '<p class="loading">Loading survey...</p>';

  try {
    const data = await apiFetch("/portal/survey");
    const preStudy = data.surveys.pre_study;

    // Find the first available (unlocked, not completed) survey
    const surveyOrder = ["pre_study", "mid_semester", "post_study"];
    let activeSurveyId = null;
    let activeSurvey = null;

    for (const id of surveyOrder) {
      const s = data.surveys[id];
      if (s.status === "not_started" || s.status === "in_progress") {
        activeSurveyId = id;
        activeSurvey = s;
        break;
      }
    }

    // Show completion status for all surveys
    const statusHtml = surveyOrder.map((id) => {
      const s = data.surveys[id];
      const label = { pre_study: "Pre-Study", mid_semester: "Mid-Semester", post_study: "Post-Study" }[id];
      const badge = s.status === "completed" ? '<span class="status shared">Complete</span>'
        : s.status === "locked" ? '<span class="status withdrawn">Locked</span>'
        : s.status === "in_progress" ? '<span class="status" style="background:#FFF3E0;color:#E65100">In progress</span>'
        : '<span class="status withdrawn">Not started</span>';
      return `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #E0E0E0"><span>${label}</span>${badge}</div>`;
    }).join("");

    if (!activeSurvey) {
      container.innerHTML = `<div style="margin-bottom:24px">${statusHtml}</div><div class="info-box"><strong>All available surveys complete.</strong> Thank you for your responses.</div>`;
      return;
    }

    const responses = activeSurvey.responses || {};
    container.innerHTML = `<div style="margin-bottom:24px">${statusHtml}</div>` + renderSurveyForm(activeSurveyId, responses);

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

async function saveSurvey(completed) {
  const form = document.getElementById("survey-form");
  if (!form) return;

  // Collect responses, handling checkboxes specially
  const formData = new FormData(form);
  const responses = {};
  const checkboxes = {};
  for (const [key, value] of formData.entries()) {
    // Group checkbox values with ||| separator
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

  // Determine active survey from the form
  const surveyId = form.dataset.surveyId || "pre_study";

  try {
    await apiFetch("/portal/survey", {
      method: "POST",
      body: { survey_id: surveyId, responses, completed },
    });
    if (completed) {
      loadSurvey(); // Refresh to show completion status
    }
  } catch (err) {
    alert(`Failed to save: ${err.message}`);
  }
}

function renderSurveyForm(surveyId, responses) {
  const survey = window.SURVEYS?.[surveyId];
  if (!survey) return "<p>Survey definition not found.</p>";

  let sections = survey.sections;

  // Post-study reuses A1-A5 from pre_study
  if (surveyId === "post_study") {
    sections = window.SURVEYS.pre_study.sections.filter(
      (s) => s.phase.includes("post_study")
    );
  }

  const html = sections.map((section, si) => {
    const scale = section.scale || section.vignetteScale;
    const questionsHtml = section.questions.map((q, qi) => {
      const num = qi + 1;
      if (q.type === "radio") {
        return `<div class="survey-question">
          <div class="question-text">${num}. ${q.text}</div>
          <div class="radio-group">
            ${q.options.map((opt) => `
              <label><input type="radio" name="${q.id}" value="${opt}" ${responses[q.id] === opt ? "checked" : ""}> ${opt}</label>
            `).join("")}
          </div>
        </div>`;
      }

      if (q.type === "likert") {
        const s = scale || { min: 1, max: 7, minLabel: "", maxLabel: "" };
        const range = Array.from({ length: s.max - s.min + 1 }, (_, i) => s.min + i);
        return `<div class="survey-question">
          <div class="question-text">${num}. ${q.text}</div>
          <div class="likert-scale">
            ${range.map((n) => `
              <label><input type="radio" name="${q.id}" value="${n}" ${responses[q.id] == n ? "checked" : ""}><span>${n}</span></label>
            `).join("")}
          </div>
          <div class="likert-labels"><span>${s.minLabel}</span><span>${s.maxLabel}</span></div>
        </div>`;
      }

      if (q.type === "vignette") {
        const vs = section.vignetteScale || { min: 1, max: 7, minLabel: "", maxLabel: "" };
        const range = Array.from({ length: vs.max - vs.min + 1 }, (_, i) => vs.min + i);
        return `<div class="survey-question">
          <div class="question-text"><strong>${num}. ${q.text}</strong></div>
          <p style="margin:8px 0">A. How appropriate is this task for AI?</p>
          <div class="likert-scale">
            ${range.map((n) => `
              <label><input type="radio" name="${q.id}_a" value="${n}" ${responses[q.id + "_a"] == n ? "checked" : ""}><span>${n}</span></label>
            `).join("")}
          </div>
          <div class="likert-labels"><span>${vs.minLabel}</span><span>${vs.maxLabel}</span></div>
          <p style="margin:12px 0 4px">B. Explain your reasoning (1-2 sentences)</p>
          <textarea class="survey-text" name="${q.id}_b" rows="2">${responses[q.id + "_b"] || ""}</textarea>
          <p style="margin:12px 0 4px">C. Which tool would you use?</p>
          <input class="form-input" name="${q.id}_c" value="${responses[q.id + "_c"] || ""}" placeholder="e.g., Claude Code, ChatGPT, none...">
        </div>`;
      }

      if (q.type === "text") {
        return `<div class="survey-question">
          <div class="question-text">${num}. ${q.text}</div>
          <input class="form-input" name="${q.id}" value="${responses[q.id] || ""}" placeholder="${q.placeholder || ""}">
        </div>`;
      }

      if (q.type === "textarea") {
        return `<div class="survey-question">
          <div class="question-text">${num}. ${q.text}</div>
          <textarea class="survey-text" name="${q.id}" rows="3">${responses[q.id] || ""}</textarea>
        </div>`;
      }

      if (q.type === "checkbox") {
        const selected = (responses[q.id] || "").split("|||");
        return `<div class="survey-question">
          <div class="question-text">${num}. ${q.text}</div>
          <div class="radio-group">
            ${q.options.map((opt) => `
              <label><input type="checkbox" name="${q.id}" value="${opt}" ${selected.includes(opt) ? "checked" : ""}> ${opt}</label>
            `).join("")}
          </div>
        </div>`;
      }

      if (q.type === "percentage") {
        return `<div class="survey-question">
          <div class="question-text">${num}. ${q.text}</div>
          <div class="percentage-inputs">
            ${q.categories.map((cat, ci) => `
              <div style="display:flex;align-items:center;gap:8px;margin:6px 0">
                <label style="flex:1;font-weight:400">${cat}</label>
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
      <h3>${section.id}. ${section.title}</h3>
      <p class="section-desc">${section.description}</p>
      ${questionsHtml}
    </div>`;
  }).join("");

  return `
    <form id="survey-form" data-survey-id="${surveyId}">
      <div class="info-box">
        <strong>${survey.title}</strong>
        <p style="margin-bottom:0">${survey.description}</p>
      </div>
      ${html}
      <div class="survey-nav">
        <button type="button" class="btn btn-secondary" id="survey-save">Save progress</button>
        <button type="button" class="btn btn-primary" id="survey-submit">Submit survey</button>
      </div>
    </form>
  `;
}
