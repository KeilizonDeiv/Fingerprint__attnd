// Vanilla JS renderer — deliberately no React/bundler here so the app runs
// with zero build step (`npm start` and you're done). If this UI grows
// past a few screens, migrating to React + Vite is the natural next step;
// the IPC contract in preload.js doesn't change either way.

// Escape user-controlled strings before interpolating into innerHTML.
// Employee names/codes/departments are operator-entered free text stored
// in the DB — without this, a value like `<img src=x onerror=...>` saved
// as a name would execute as script the next time any tab renders it.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

// SQLite stores timestamps as UTC text with no timezone marker (see
// attendanceService.js's parseDbTimestamp — same bug, same fix, needed
// here too since the renderer parses raw DB strings independently).
function dbTimestampToDate(ts) {
  return new Date(`${ts.replace(' ', 'T')}Z`);
}

function toCsv(rows, columns) {
  const cell = (value) => {
    const s = String(value ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => cell(c.label)).join(',');
  const body = rows.map((row) => columns.map((c) => cell(row[c.key])).join(',')).join('\n');
  return `${header}\n${body}\n`;
}

async function exportCsvWithStatus(suggestedName, csvContent, statusEl) {
  try {
    const result = await window.api.exportCsv(suggestedName, csvContent);
    if (result.canceled) return;
    statusEl.className = 'status-msg status-ok';
    statusEl.textContent = `Saved to ${result.filePath}`;
  } catch (err) {
    statusEl.className = 'status-msg status-error';
    statusEl.textContent = err.message || 'Export failed.';
  }
}

const tabs = document.querySelectorAll('.tab-btn');
const panels = document.querySelectorAll('.tab-panel');

// Tabs that require an authenticated admin session. Kiosk (clock in/out)
// is deliberately excluded — that's the flow every employee uses.
const PROTECTED_TABS = {
  register: renderRegister,
  employees: renderEmployees,
  enroll: renderEnroll,
  logs: renderLogs,
  timesheet: renderTimesheet,
};

tabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabs.forEach((b) => b.classList.remove('active'));
    panels.forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    refreshActiveTab(btn.dataset.tab);
  });
});

async function refreshActiveTab(tab) {
  if (tab === 'kiosk') return renderKiosk();
  return renderProtectedTab(tab);
}

// The real access control lives in main.js (requireAuth on each IPC
// handler) — this only decides what the UI shows. A renderer that skipped
// this gate entirely would still get "Admin authentication required."
// errors back from the protected endpoints.
async function renderProtectedTab(tab) {
  const el = document.getElementById(`tab-${tab}`);
  const status = await window.api.authStatus();

  if (!status.configured) {
    renderAuthGate(el, { mode: 'setup', tab });
  } else if (!status.authenticated) {
    renderAuthGate(el, { mode: 'login', tab });
  } else {
    PROTECTED_TABS[tab]();
  }
  updateLockButton(status);
}

function renderAuthGate(el, { mode, tab }) {
  const isSetup = mode === 'setup';
  el.innerHTML = `
    <div class="card">
      <h2>${isSetup ? 'Set Up Admin PIN' : 'Admin Login Required'}</h2>
      <p>${isSetup
        ? 'One-time setup: choose a PIN (6+ characters) to protect employee management, registration, enrollment, and attendance logs.'
        : 'Enter the admin PIN to continue.'}</p>
      <div class="form-row">
        <input type="password" id="auth-pin" placeholder="PIN" autocomplete="off" />
        ${isSetup ? '<input type="password" id="auth-pin-confirm" placeholder="Confirm PIN" autocomplete="off" />' : ''}
        <button class="primary" id="auth-submit-btn">${isSetup ? 'Create PIN' : 'Unlock'}</button>
      </div>
      <div id="auth-status"></div>
    </div>
  `;

  // Scoped to `el`, not `document`: every protected tab's <section> stays
  // in the DOM (just hidden via CSS) once rendered, so if more than one
  // tab has shown this same gate, document.getElementById('auth-pin')
  // would return the FIRST one in document order — not necessarily the
  // visible one being typed into. That's a real bug, not a hypothetical:
  // visit two protected tabs before logging in and it bites.
  const submit = async () => {
    const pin = el.querySelector('#auth-pin').value;
    const statusEl = el.querySelector('#auth-status');
    try {
      if (isSetup) {
        const confirmPin = el.querySelector('#auth-pin-confirm').value;
        if (pin !== confirmPin) throw new Error('PINs do not match.');
        await window.api.authSetup(pin);
      } else {
        await window.api.authLogin(pin);
      }
      refreshActiveTab(tab);
    } catch (err) {
      statusEl.className = 'status-msg status-error';
      statusEl.textContent = err.message || 'Authentication failed.';
    }
  };

  el.querySelector('#auth-submit-btn').addEventListener('click', submit);
  el.querySelectorAll('input').forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
  });
}

async function updateLockButton(status) {
  const authStatus = status || (await window.api.authStatus());
  const btn = document.getElementById('lock-btn');
  btn.classList.toggle('hidden', !authStatus.authenticated);
}

document.getElementById('lock-btn').addEventListener('click', async () => {
  await window.api.authLogout();
  const activeTab = document.querySelector('.tab-btn.active').dataset.tab;
  refreshActiveTab(activeTab);
});

// Auth actually expires server-side (authService.js's idle timeout), but
// the renderer only learns about it on the next IPC call. Poll while idle
// so a session that expires mid-view flips back to the login gate instead
// of silently letting stale UI sit there until the next click fails.
let lastKnownAuthenticated = false;
setInterval(async () => {
  const status = await window.api.authStatus();
  updateLockButton(status);
  const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
  if (lastKnownAuthenticated && !status.authenticated && activeTab && activeTab !== 'kiosk') {
    renderProtectedTab(activeTab);
  }
  lastKnownAuthenticated = status.authenticated;
}, 30_000);

// ---------- Attendance Kiosk ----------
async function renderKiosk() {
  const el = document.getElementById('tab-kiosk');
  const employees = await window.api.listEmployees();

  el.innerHTML = `
    <div class="card">
      <h2>Clock In / Out</h2>
      <p>In production this screen just waits for a finger on the sensor.
         Since no hardware is connected yet, pick who's "scanning" to test the flow:</p>
      <div class="form-row">
        <select id="kiosk-employee">
          ${employees.map((e) => `<option value="${escapeHtml(e.employee_code)}">${escapeHtml(e.first_name)} ${escapeHtml(e.last_name)} (${escapeHtml(e.employee_code)})</option>`).join('')}
        </select>
        <button class="primary" id="kiosk-scan-btn" ${employees.length === 0 ? 'disabled' : ''}>Simulate Scan</button>
      </div>
      ${employees.length === 0 ? '<p><em>No registered employees yet — use the Register Employee tab first.</em></p>' : ''}
      <div id="kiosk-status"></div>
    </div>
  `;

  const btn = document.getElementById('kiosk-scan-btn');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const employeeCode = document.getElementById('kiosk-employee').value;
    const statusEl = document.getElementById('kiosk-status');
    statusEl.textContent = 'Scanning...';
    statusEl.className = 'status-msg';

    const result = await window.api.scanAttendance(employeeCode);

    if (result.status === 'OK') {
      statusEl.className = 'status-msg status-ok';
      statusEl.textContent = `${result.employee.first_name} ${result.employee.last_name} clocked ${result.eventType} at ${new Date(result.timestamp).toLocaleTimeString()} (confidence ${result.score}%)`;
    } else {
      statusEl.className = 'status-msg status-error';
      statusEl.textContent = result.message;
    }
  });
}

// ---------- Register Employee (Create = registration, atomic) ----------
// Holds captured-but-not-yet-saved fingerprint templates for the employee
// currently being registered. Cleared on successful submit or tab leave.
let registrationTemplates = [];

function renderRegister() {
  registrationTemplates = [];
  const el = document.getElementById('tab-register');

  el.innerHTML = `
    <div class="card">
      <h2>Register Employee</h2>
      <p>Registration is a single step: employee details are only saved once
         at least one fingerprint has been captured. Nothing is written to
         the database until you complete registration.</p>

      <h3>1. Employee details</h3>
      <div class="form-row">
        <input id="reg-code" placeholder="Employee code (unique)" />
        <input id="reg-first" placeholder="First name" />
        <input id="reg-last" placeholder="Last name" />
        <input id="reg-dept" placeholder="Department" />
      </div>

      <h3>2. Capture fingerprint(s)</h3>
      <p><em>Enter the employee code above first — the scanner needs it to simulate a reading.</em></p>
      <div class="form-row">
        <select id="reg-finger">
          <option value="right_index">Right Index</option>
          <option value="left_index">Left Index</option>
          <option value="right_thumb">Right Thumb</option>
          <option value="left_thumb">Left Thumb</option>
        </select>
        <button id="reg-capture-btn">Capture Fingerprint</button>
      </div>
      <ul id="reg-captured-list"></ul>

      <h3>3. Complete</h3>
      <button class="primary" id="reg-submit-btn">Complete Registration</button>
      <div id="reg-status"></div>
    </div>
  `;

  const renderCapturedList = () => {
    const list = document.getElementById('reg-captured-list');
    list.innerHTML = registrationTemplates
      .map((t, i) => `<li><span>${escapeHtml(t.fingerPosition)} — quality ${t.quality}%</span> <button data-i="${i}" class="reg-remove-btn">Remove</button></li>`)
      .join('') || '<li><em>No fingerprints captured yet.</em></li>';

    list.querySelectorAll('.reg-remove-btn').forEach((b) => {
      b.addEventListener('click', () => {
        registrationTemplates.splice(Number(b.dataset.i), 1);
        renderCapturedList();
      });
    });
  };
  renderCapturedList();

  document.getElementById('reg-capture-btn').addEventListener('click', async () => {
    const code = document.getElementById('reg-code').value.trim();
    const statusEl = document.getElementById('reg-status');
    if (!code) {
      statusEl.className = 'status-msg status-error';
      statusEl.textContent = 'Enter an employee code before capturing a fingerprint.';
      return;
    }
    statusEl.className = 'status-msg';
    statusEl.textContent = 'Place finger on scanner...';

    const fingerPosition = document.getElementById('reg-finger').value;
    const captured = await window.api.captureRegistrationFingerprint(code);
    registrationTemplates.push({ fingerPosition, templateData: captured.templateData, quality: captured.quality });
    renderCapturedList();

    statusEl.className = 'status-msg status-ok';
    statusEl.textContent = `Captured ${fingerPosition} (quality ${captured.quality}%). Capture more, or complete registration.`;
  });

  document.getElementById('reg-submit-btn').addEventListener('click', async () => {
    const statusEl = document.getElementById('reg-status');

    const employeeData = {
      employeeCode: document.getElementById('reg-code').value.trim(),
      firstName: document.getElementById('reg-first').value.trim(),
      lastName: document.getElementById('reg-last').value.trim(),
      department: document.getElementById('reg-dept').value.trim(),
    };

    if (!employeeData.employeeCode || !employeeData.firstName || !employeeData.lastName) {
      statusEl.className = 'status-msg status-error';
      statusEl.textContent = 'Employee code, first name, and last name are required.';
      return;
    }
    if (registrationTemplates.length === 0) {
      statusEl.className = 'status-msg status-error';
      statusEl.textContent = 'At least one fingerprint capture is required to complete registration.';
      return;
    }

    try {
      const templates = registrationTemplates.map(({ fingerPosition, templateData }) => ({ fingerPosition, templateData }));
      await window.api.completeRegistration(employeeData, templates);
      statusEl.className = 'status-msg status-ok';
      statusEl.textContent = `Registered ${employeeData.firstName} ${employeeData.lastName} with ${templates.length} fingerprint(s).`;
      registrationTemplates = [];
      renderCapturedList();
      document.getElementById('reg-code').value = '';
      document.getElementById('reg-first').value = '';
      document.getElementById('reg-last').value = '';
      document.getElementById('reg-dept').value = '';
    } catch (err) {
      // e.g. duplicate employee code — the whole registration was rolled
      // back server-side, so it's safe to just let the operator retry.
      statusEl.className = 'status-msg status-error';
      statusEl.textContent = err.message || 'Registration failed.';
    }
  });
}

// ---------- Employees (Read, Update, Deactivate) ----------
async function renderEmployees() {
  const el = document.getElementById('tab-employees');
  const employees = await window.api.listEmployees();

  el.innerHTML = `
    <div class="card">
      <h2>Employees</h2>
      <div class="form-row">
        <button id="backup-btn">Backup Database</button>
      </div>
      <div id="backup-status"></div>
      <p><em>New employees are added via the Register Employee tab (registration requires a fingerprint).</em></p>
      <table>
        <thead><tr><th>Code</th><th>Name</th><th>Department</th><th></th></tr></thead>
        <tbody>
          ${employees.map((e) => `
            <tr data-row-id="${e.id}">
              <td data-label="Code">${escapeHtml(e.employee_code)}</td>
              <td data-label="Name">${escapeHtml(e.first_name)} ${escapeHtml(e.last_name)}</td>
              <td data-label="Department">${escapeHtml(e.department) || '-'}</td>
              <td data-label="">
                <button data-id="${e.id}" class="edit-btn">Edit</button>
                <button data-id="${e.id}" class="deactivate-btn">Deactivate</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;

  document.getElementById('backup-btn').addEventListener('click', async () => {
    const statusEl = document.getElementById('backup-status');
    statusEl.className = 'status-msg';
    statusEl.textContent = 'Creating backup...';
    try {
      const result = await window.api.createBackup();
      if (result.canceled) {
        statusEl.textContent = '';
        return;
      }
      statusEl.className = 'status-msg status-ok';
      statusEl.textContent = `Backup saved to ${result.filePath}`;
    } catch (err) {
      statusEl.className = 'status-msg status-error';
      statusEl.textContent = err.message || 'Backup failed.';
    }
  });

  el.querySelectorAll('.deactivate-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Deactivate this employee? Their attendance history is kept.')) return;
      await window.api.deactivateEmployee(Number(btn.dataset.id));
      renderEmployees();
    });
  });

  el.querySelectorAll('.edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => openEditRow(Number(btn.dataset.id), employees));
  });
}

function openEditRow(employeeId, employees) {
  const emp = employees.find((e) => e.id === employeeId);
  const row = document.querySelector(`tr[data-row-id="${employeeId}"]`);
  row.innerHTML = `
    <td data-label="Code"><input id="edit-code" value="${escapeHtml(emp.employee_code)}" /></td>
    <td data-label="Name">
      <input id="edit-first" class="input-narrow" value="${escapeHtml(emp.first_name)}" />
      <input id="edit-last" class="input-narrow" value="${escapeHtml(emp.last_name)}" />
    </td>
    <td data-label="Department"><input id="edit-dept" value="${escapeHtml(emp.department)}" /></td>
    <td data-label="">
      <button class="primary" id="edit-save-btn">Save</button>
      <button id="edit-cancel-btn">Cancel</button>
    </td>
  `;

  document.getElementById('edit-cancel-btn').addEventListener('click', renderEmployees);

  document.getElementById('edit-save-btn').addEventListener('click', async () => {
    try {
      await window.api.updateEmployee(employeeId, {
        employeeCode: document.getElementById('edit-code').value.trim(),
        firstName: document.getElementById('edit-first').value.trim(),
        lastName: document.getElementById('edit-last').value.trim(),
        department: document.getElementById('edit-dept').value.trim(),
      });
      renderEmployees();
    } catch (err) {
      alert(err.message || 'Update failed.');
    }
  });
}

// ---------- Add Fingerprint (extra finger for an already-registered employee) ----------
async function renderEnroll() {
  const el = document.getElementById('tab-enroll');
  const employees = await window.api.listEmployees();

  el.innerHTML = `
    <div class="card">
      <h2>Add Fingerprint</h2>
      <p>For an employee who's already registered but needs another finger enrolled
         (e.g. a backup finger, or their first one wasn't reading well).</p>
      <div class="form-row">
        <select id="enroll-employee">
          ${employees.map((e) => `<option value="${e.id}">${escapeHtml(e.first_name)} ${escapeHtml(e.last_name)}</option>`).join('')}
        </select>
        <select id="enroll-finger">
          <option value="right_index">Right Index</option>
          <option value="left_index">Left Index</option>
          <option value="right_thumb">Right Thumb</option>
          <option value="left_thumb">Left Thumb</option>
        </select>
        <button class="primary" id="enroll-btn" ${employees.length === 0 ? 'disabled' : ''}>Capture & Save</button>
      </div>
      <div id="enroll-status"></div>
    </div>
  `;

  const btn = document.getElementById('enroll-btn');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const employeeId = Number(document.getElementById('enroll-employee').value);
    const fingerPosition = document.getElementById('enroll-finger').value;
    const statusEl = document.getElementById('enroll-status');
    statusEl.textContent = 'Place finger on scanner...';
    statusEl.className = 'status-msg';

    const captured = await window.api.captureEnrollment(employeeId, fingerPosition);

    statusEl.className = 'status-msg status-ok';
    statusEl.textContent = `Enrolled (quality: ${captured.quality}%).`;
  });
}

// ---------- Recent Logs ----------
async function renderLogs(limit = 50) {
  const el = document.getElementById('tab-logs');
  const logs = await window.api.recentAttendance(limit);

  el.innerHTML = `
    <div class="card">
      <h2>Recent Attendance</h2>
      <div class="form-row">
        <select id="logs-limit">
          <option value="50" ${limit === 50 ? 'selected' : ''}>Last 50</option>
          <option value="100" ${limit === 100 ? 'selected' : ''}>Last 100</option>
          <option value="200" ${limit === 200 ? 'selected' : ''}>Last 200</option>
        </select>
        <button id="logs-refresh-btn">Refresh</button>
        <button id="logs-export-btn" ${logs.length === 0 ? 'disabled' : ''}>Export CSV</button>
      </div>
      <div id="logs-status"></div>
      <table>
        <thead><tr><th>Employee</th><th>Event</th><th>Time</th><th>Confidence</th></tr></thead>
        <tbody>
          ${logs.map((l) => `
            <tr>
              <td data-label="Employee">${escapeHtml(l.first_name)} ${escapeHtml(l.last_name)} (${escapeHtml(l.employee_code)})</td>
              <td data-label="Event"><span class="${l.event_type === 'IN' ? 'badge-in' : 'badge-out'}">${escapeHtml(l.event_type)}</span></td>
              <td data-label="Time">${escapeHtml(dbTimestampToDate(l.timestamp).toLocaleString())}</td>
              <td data-label="Confidence">${l.match_score ?? '-'}%</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;

  document.getElementById('logs-refresh-btn').addEventListener('click', () => {
    renderLogs(Number(document.getElementById('logs-limit').value));
  });

  document.getElementById('logs-export-btn').addEventListener('click', () => {
    const csv = toCsv(logs, [
      { key: 'employee_code', label: 'Employee Code' },
      { key: 'first_name', label: 'First Name' },
      { key: 'last_name', label: 'Last Name' },
      { key: 'event_type', label: 'Event' },
      { key: 'timestamp', label: 'Timestamp (UTC)' },
      { key: 'match_score', label: 'Confidence' },
    ]);
    exportCsvWithStatus('attendance-logs.csv', csv, document.getElementById('logs-status'));
  });
}

// ---------- Timesheet (computed hours from IN/OUT pairs) ----------
async function renderTimesheet() {
  const el = document.getElementById('tab-timesheet');
  const employees = await window.api.listEmployees();

  const toDateInput = (d) => d.toISOString().slice(0, 10);
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);

  el.innerHTML = `
    <div class="card">
      <h2>Timesheet</h2>
      <p>Hours are computed by pairing IN/OUT scans. An overnight shift's
         hours are counted entirely on the day it started. Rows marked
         <strong>no clock-out</strong> aren't counted — the employee is
         either still clocked in or forgot to scan out.</p>
      <div class="form-row">
        <label>From <input type="date" id="ts-start" value="${toDateInput(weekAgo)}" /></label>
        <label>To <input type="date" id="ts-end" value="${toDateInput(today)}" /></label>
        <select id="ts-employee">
          <option value="">All employees</option>
          ${employees.map((e) => `<option value="${e.id}">${escapeHtml(e.first_name)} ${escapeHtml(e.last_name)}</option>`).join('')}
        </select>
        <button class="primary" id="ts-generate-btn">Generate</button>
        <button id="ts-export-btn" disabled>Export CSV</button>
      </div>
      <div id="ts-status"></div>
      <div id="ts-results"></div>
    </div>
  `;

  let currentRows = [];

  const generate = async () => {
    const startDate = document.getElementById('ts-start').value;
    const endDate = document.getElementById('ts-end').value;
    const employeeId = document.getElementById('ts-employee').value || undefined;
    const statusEl = document.getElementById('ts-status');
    const resultsEl = document.getElementById('ts-results');
    const exportBtn = document.getElementById('ts-export-btn');

    try {
      currentRows = await window.api.getTimesheet({ startDate, endDate, employeeId });
    } catch (err) {
      statusEl.className = 'status-msg status-error';
      statusEl.textContent = err.message || 'Failed to generate timesheet.';
      return;
    }
    statusEl.textContent = '';
    exportBtn.disabled = currentRows.length === 0;

    if (currentRows.length === 0) {
      resultsEl.innerHTML = '<p><em>No attendance data in this range.</em></p>';
      return;
    }

    const totals = new Map();
    const namesById = new Map();
    for (const r of currentRows) {
      totals.set(r.employeeId, (totals.get(r.employeeId) || 0) + r.hours);
      namesById.set(r.employeeId, `${r.firstName} ${r.lastName}`);
    }

    resultsEl.innerHTML = `
      <table>
        <thead><tr><th>Employee</th><th>Date</th><th>First In</th><th>Last Out</th><th>Hours</th><th></th></tr></thead>
        <tbody>
          ${currentRows.map((r) => `
            <tr>
              <td data-label="Employee">${escapeHtml(r.firstName)} ${escapeHtml(r.lastName)} (${escapeHtml(r.employeeCode)})</td>
              <td data-label="Date">${escapeHtml(r.date)}</td>
              <td data-label="First In">${escapeHtml(new Date(r.firstIn).toLocaleTimeString())}</td>
              <td data-label="Last Out">${r.lastOut ? escapeHtml(new Date(r.lastOut).toLocaleTimeString()) : '-'}</td>
              <td data-label="Hours">${r.hours.toFixed(2)}</td>
              <td data-label="">${r.incomplete ? '<span class="badge-out">no clock-out</span>' : ''}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      <h3>Totals</h3>
      <table>
        <thead><tr><th>Employee</th><th>Hours</th></tr></thead>
        <tbody>
          ${[...totals.entries()].map(([employeeId, hours]) =>
            `<tr><td data-label="Employee">${escapeHtml(namesById.get(employeeId))}</td><td data-label="Hours">${hours.toFixed(2)}</td></tr>`
          ).join('')}
        </tbody>
      </table>
    `;
  };

  document.getElementById('ts-generate-btn').addEventListener('click', generate);
  document.getElementById('ts-export-btn').addEventListener('click', () => {
    const csv = toCsv(currentRows, [
      { key: 'employeeCode', label: 'Employee Code' },
      { key: 'firstName', label: 'First Name' },
      { key: 'lastName', label: 'Last Name' },
      { key: 'date', label: 'Date' },
      { key: 'firstIn', label: 'First In' },
      { key: 'lastOut', label: 'Last Out' },
      { key: 'hours', label: 'Hours' },
      { key: 'incomplete', label: 'Incomplete' },
    ]);
    exportCsvWithStatus('timesheet.csv', csv, document.getElementById('ts-status'));
  });

  await generate();
}

renderKiosk();
updateLockButton();
