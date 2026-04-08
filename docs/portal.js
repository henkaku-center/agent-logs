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

    if (preStudy.status === "locked") {
      container.innerHTML = "<p>The pre-study survey is not yet available.</p>";
      return;
    }

    if (preStudy.status === "completed") {
      container.innerHTML = '<div class="info-box"><strong>Pre-study survey complete.</strong> Thank you for your responses.</div>';
      return;
    }

    const responses = preStudy.responses || {};
    container.innerHTML = renderSurveyForm(responses);

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

  const formData = new FormData(form);
  const responses = {};
  for (const [key, value] of formData.entries()) {
    responses[key] = value;
  }

  try {
    await apiFetch("/portal/survey", {
      method: "POST",
      body: { survey_id: "pre_study", responses, completed },
    });
    if (completed) {
      document.getElementById("survey-container").innerHTML =
        '<div class="info-box"><strong>Pre-study survey submitted.</strong> Thank you!</div>';
    }
  } catch (err) {
    alert(`Failed to save: ${err.message}`);
  }
}

function renderSurveyForm(responses) {
  // Survey questions — will be populated from survey-data.js
  // For now, render a placeholder structure
  return `
    <form id="survey-form">
      <div class="info-box">
        <strong>Pre-Study Survey</strong>
        <p style="margin-bottom:0">This survey helps us understand your background and experience with AI tools. Your responses are confidential. It takes approximately 15-20 minutes.</p>
      </div>

      <div class="survey-section">
        <h3>A0. Background Information</h3>
        <p class="section-desc">Please tell us about yourself.</p>

        <div class="survey-question">
          <div class="question-text">1. What is your age range?</div>
          <div class="radio-group">
            ${["18-22", "23-27", "28-35", "36+"].map((v) => `
              <label><input type="radio" name="A0_1" value="${v}" ${responses.A0_1 === v ? "checked" : ""}> ${v}</label>
            `).join("")}
          </div>
        </div>

        <div class="survey-question">
          <div class="question-text">2. What is your program of study?</div>
          <textarea class="survey-text" name="A0_2" placeholder="e.g., Computer Science, Design...">${responses.A0_2 || ""}</textarea>
        </div>

        <div class="survey-question">
          <div class="question-text">3. How would you rate your programming experience?</div>
          <div class="likert-scale">
            ${[1,2,3,4,5,6,7].map((n) => `
              <label><input type="radio" name="A0_3" value="${n}" ${responses.A0_3 == n ? "checked" : ""}><span>${n}</span></label>
            `).join("")}
          </div>
          <div class="likert-labels"><span>No experience</span><span>Expert</span></div>
        </div>
      </div>

      <div class="survey-section">
        <h3>A1. AI Tool Familiarity</h3>
        <p class="section-desc">Rate your familiarity with the following AI tools (1 = Never used, 7 = Use daily).</p>

        ${["ChatGPT", "Claude", "GitHub Copilot", "Cursor", "Other AI coding tools"].map((tool, i) => `
          <div class="survey-question">
            <div class="question-text">${i + 1}. ${tool}</div>
            <div class="likert-scale">
              ${[1,2,3,4,5,6,7].map((n) => `
                <label><input type="radio" name="A1_${i+1}" value="${n}" ${responses[`A1_${i+1}`] == n ? "checked" : ""}><span>${n}</span></label>
              `).join("")}
            </div>
            <div class="likert-labels"><span>Never used</span><span>Use daily</span></div>
          </div>
        `).join("")}
      </div>

      <div class="survey-nav">
        <button type="button" class="btn btn-secondary" id="survey-save">Save progress</button>
        <button type="button" class="btn btn-primary" id="survey-submit">Submit survey</button>
      </div>
    </form>
  `;
}
