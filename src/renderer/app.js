// Vanilla JS renderer — deliberately no React/bundler here so the app runs
// with zero build step (`npm start` and you're done). If this UI grows
// past a few screens, migrating to React + Vite is the natural next step;
// the IPC contract in preload.js doesn't change either way.

const tabs = document.querySelectorAll('.tab-btn');
const panels = document.querySelectorAll('.tab-panel');

tabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabs.forEach((b) => b.classList.remove('active'));
    panels.forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    refreshActiveTab(btn.dataset.tab);
  });
});

function refreshActiveTab(tab) {
  if (tab === 'kiosk') renderKiosk();
  if (tab === 'register') renderRegister();
  if (tab === 'employees') renderEmployees();
  if (tab === 'enroll') renderEnroll();
  if (tab === 'logs') renderLogs();
}

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
          ${employees.map((e) => `<option value="${e.employee_code}">${e.first_name} ${e.last_name} (${e.employee_code})</option>`).join('')}
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
      .map((t, i) => `<li>${t.fingerPosition} — quality ${t.quality}% <button data-i="${i}" class="reg-remove-btn">Remove</button></li>`)
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
      <p><em>New employees are added via the Register Employee tab (registration requires a fingerprint).</em></p>
      <table>
        <thead><tr><th>Code</th><th>Name</th><th>Department</th><th></th></tr></thead>
        <tbody>
          ${employees.map((e) => `
            <tr data-row-id="${e.id}">
              <td>${e.employee_code}</td>
              <td>${e.first_name} ${e.last_name}</td>
              <td>${e.department || '-'}</td>
              <td>
                <button data-id="${e.id}" class="edit-btn">Edit</button>
                <button data-id="${e.id}" class="deactivate-btn">Deactivate</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;

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
    <td><input id="edit-code" value="${emp.employee_code}" /></td>
    <td>
      <input id="edit-first" value="${emp.first_name}" style="width:80px" />
      <input id="edit-last" value="${emp.last_name}" style="width:80px" />
    </td>
    <td><input id="edit-dept" value="${emp.department || ''}" /></td>
    <td>
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
          ${employees.map((e) => `<option value="${e.id}">${e.first_name} ${e.last_name}</option>`).join('')}
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
async function renderLogs() {
  const el = document.getElementById('tab-logs');
  const logs = await window.api.recentAttendance(50);

  el.innerHTML = `
    <div class="card">
      <h2>Recent Attendance</h2>
      <table>
        <thead><tr><th>Employee</th><th>Event</th><th>Time</th><th>Confidence</th></tr></thead>
        <tbody>
          ${logs.map((l) => `
            <tr>
              <td>${l.first_name} ${l.last_name} (${l.employee_code})</td>
              <td class="${l.event_type === 'IN' ? 'badge-in' : 'badge-out'}">${l.event_type}</td>
              <td>${new Date(l.timestamp).toLocaleString()}</td>
              <td>${l.match_score ?? '-'}%</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

renderKiosk();
