// Uses Node's built-in test runner (`node --test`) — no new dependency.
// Each test builds its own temp SQLite DB so tests never share state; this
// mirrors what main.js wires together but never touches Electron, matching
// the constructor-injection design in the service layer (db/scanner passed
// in, not imported globally) specifically so this kind of test is possible.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { EmployeeService } = require('../src/services/employeeService');
const { AttendanceService } = require('../src/services/attendanceService');
const { AuthService, IDLE_TIMEOUT_MS } = require('../src/services/authService');
const { MockScanner } = require('../src/services/adapters/mockScanner');

// Mirrors database.js's getDb(), minus its module-level singleton cache —
// that cache is correct for the real app (one connection per process) but
// would leak state between these otherwise-independent tests.
function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-attnd-test-'));
  const db = new Database(path.join(tmpDir, 'attendance.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8'));
  return { db, tmpDir };
}

function cleanup(db, tmpDir) {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function setup() {
  const { db, tmpDir } = freshDb();
  const employeeService = new EmployeeService(db);
  const scanner = new MockScanner();
  await scanner.initialize();
  const attendanceService = new AttendanceService(db, scanner, employeeService);
  const authService = new AuthService(db);
  return { db, tmpDir, employeeService, scanner, attendanceService, authService };
}

function localDateKey(isoUtcString) {
  const d = new Date(isoUtcString);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// --- Auth ------------------------------------------------------------------

test('auth: starts unconfigured; login/requireAuth refuse before setup', async () => {
  const { db, tmpDir, authService } = await setup();
  try {
    assert.equal(authService.isConfigured(), false);
    assert.throws(() => authService.requireAuth(), /Admin authentication required/);
    assert.throws(() => authService.login('whatever'), /has not been set up/);
  } finally {
    cleanup(db, tmpDir);
  }
});

test('auth: setup rejects a too-short PIN, otherwise auto-authenticates', async () => {
  const { db, tmpDir, authService } = await setup();
  try {
    assert.throws(() => authService.setup('short'), /PIN must be between/);
    authService.setup('correct-horse-battery-staple');
    assert.equal(authService.isAuthenticated(), true);
    assert.throws(() => authService.setup('another-pin-value'), /already configured/);
  } finally {
    cleanup(db, tmpDir);
  }
});

test('auth: wrong PIN fails, correct PIN succeeds, logout clears the session', async () => {
  const { db, tmpDir, authService } = await setup();
  try {
    authService.setup('correct-horse-battery-staple');
    authService.logout();
    assert.throws(() => authService.login('nope'), /Incorrect PIN/);
    authService.login('correct-horse-battery-staple');
    assert.equal(authService.isAuthenticated(), true);
    authService.logout();
    assert.equal(authService.isAuthenticated(), false);
  } finally {
    cleanup(db, tmpDir);
  }
});

test('auth: locks out after 5 failed attempts', async () => {
  const { db, tmpDir, authService } = await setup();
  try {
    authService.setup('correct-horse-battery-staple');
    authService.logout();
    for (let i = 0; i < 5; i++) {
      try {
        authService.login('nope');
      } catch {
        /* expected */
      }
    }
    assert.throws(() => authService.login('correct-horse-battery-staple'), /Too many failed attempts/);
  } finally {
    cleanup(db, tmpDir);
  }
});

test('auth: session expires after idle timeout', async () => {
  const { db, tmpDir, authService } = await setup();
  try {
    authService.setup('correct-horse-battery-staple');
    assert.equal(authService.isAuthenticated(), true);
    authService.lastActivityAt = Date.now() - IDLE_TIMEOUT_MS - 1;
    assert.equal(authService.isAuthenticated(), false);
  } finally {
    cleanup(db, tmpDir);
  }
});

// --- Employee validation -----------------------------------------------

test('employeeService: rejects missing or oversized fields', async () => {
  const { db, tmpDir, employeeService } = await setup();
  try {
    assert.throws(
      () => employeeService.create({ employeeCode: '', firstName: 'A', lastName: 'B' }),
      /employeeCode is required/
    );
    assert.throws(
      () => employeeService.create({ employeeCode: 'X'.repeat(101), firstName: 'A', lastName: 'B' }),
      /100 characters or fewer/
    );
  } finally {
    cleanup(db, tmpDir);
  }
});

// --- Registration (atomic) -----------------------------------------------

test('registration: requires a fingerprint and rolls back on duplicate employee code', async () => {
  const { db, tmpDir, employeeService, scanner } = await setup();
  try {
    assert.throws(
      () => employeeService.registerWithTemplates({ employeeCode: 'E1', firstName: 'Ada', lastName: 'Lovelace' }, []),
      /At least one fingerprint/
    );

    const capture = await scanner.capture({ simulateKey: 'E1' });
    const employee = employeeService.registerWithTemplates(
      { employeeCode: 'E1', firstName: 'Ada', lastName: 'Lovelace', department: 'Engineering' },
      [{ fingerPosition: 'right_index', templateData: capture.templateData }]
    );
    assert.equal(employee.employee_code, 'E1');

    assert.throws(
      () =>
        employeeService.registerWithTemplates(
          { employeeCode: 'E1', firstName: 'Dup', lastName: 'Licate' },
          [{ fingerPosition: 'left_thumb', templateData: 'x' }]
        ),
      /already in use/
    );

    const templates = employeeService.getTemplatesForEmployee(employee.id);
    assert.equal(templates.length, 1);
    assert.equal(templates[0].template_data, undefined, 'template_data must never be exposed');
  } finally {
    cleanup(db, tmpDir);
  }
});

// --- Attendance ------------------------------------------------------------

test('attendance: IN/OUT toggles, unknown fingerprint rejected, history survives deactivation', async () => {
  const { db, tmpDir, employeeService, attendanceService, scanner } = await setup();
  try {
    const capture = await scanner.capture({ simulateKey: 'E1' });
    const employee = employeeService.registerWithTemplates(
      { employeeCode: 'E1', firstName: 'Ada', lastName: 'Lovelace' },
      [{ fingerPosition: 'right_index', templateData: capture.templateData }]
    );

    const scan1 = await attendanceService.recordScan({ simulateKey: 'E1' });
    assert.equal(scan1.status, 'OK');
    assert.equal(scan1.eventType, 'IN');

    const scan2 = await attendanceService.recordScan({ simulateKey: 'E1' });
    assert.equal(scan2.eventType, 'OUT');

    const scanUnknown = await attendanceService.recordScan({ simulateKey: 'ghost' });
    assert.equal(scanUnknown.status, 'NO_MATCH');

    assert.equal(attendanceService.getRecentLogs(10).length, 2);

    employeeService.deactivate(employee.id);
    assert.equal(employeeService.listActive().length, 0);
    const scanAfterDeactivate = await attendanceService.recordScan({ simulateKey: 'E1' });
    assert.equal(scanAfterDeactivate.status, 'NO_MATCH');
    assert.equal(attendanceService.getRecentLogs(10).length, 2, 'history preserved after deactivation');
  } finally {
    cleanup(db, tmpDir);
  }
});

// --- Timesheet ---------------------------------------------------------

test('timesheet: pairs IN/OUT into daily hours and flags a dangling IN as incomplete', async () => {
  const { db, tmpDir, employeeService, scanner, attendanceService } = await setup();
  try {
    const capture = await scanner.capture({ simulateKey: 'E1' });
    const employee = employeeService.registerWithTemplates(
      { employeeCode: 'E1', firstName: 'Ada', lastName: 'Lovelace' },
      [{ fingerPosition: 'right_index', templateData: capture.templateData }]
    );

    // Insert known-timestamp logs directly so the hours math is checkable
    // without depending on wall-clock timing between scans. Expected date
    // buckets are computed the same way the service computes them (local
    // calendar date), so this doesn't assume the test runner's timezone.
    const inAt = '2026-01-05T09:00:00Z';
    const outAt = '2026-01-05T17:30:00Z'; // 8.5h later
    const danglingInAt = '2026-01-06T09:00:00Z';

    const insert = db.prepare(
      `INSERT INTO attendance_logs (employee_id, event_type, match_score, timestamp) VALUES (?, ?, ?, ?)`
    );
    const toDbFormat = (iso) => iso.replace('T', ' ').replace('Z', '');
    insert.run(employee.id, 'IN', 90, toDbFormat(inAt));
    insert.run(employee.id, 'OUT', 90, toDbFormat(outAt));
    insert.run(employee.id, 'IN', 90, toDbFormat(danglingInAt));

    const rows = attendanceService.getTimesheet({ employeeId: employee.id });
    assert.equal(rows.length, 2);

    const day1Key = localDateKey(inAt);
    const day2Key = localDateKey(danglingInAt);
    assert.notEqual(day1Key, day2Key);

    const day1 = rows.find((r) => r.date === day1Key);
    assert.ok(day1, 'expected a completed-shift row');
    assert.equal(day1.hours, 8.5);
    assert.equal(day1.incomplete, false);

    const day2 = rows.find((r) => r.date === day2Key);
    assert.ok(day2, 'expected a dangling-IN row');
    assert.equal(day2.hours, 0);
    assert.equal(day2.incomplete, true);
  } finally {
    cleanup(db, tmpDir);
  }
});

test('timesheet: date range and employeeId filters narrow the result', async () => {
  const { db, tmpDir, employeeService, scanner, attendanceService } = await setup();
  try {
    const capture = await scanner.capture({ simulateKey: 'E1' });
    const employee = employeeService.registerWithTemplates(
      { employeeCode: 'E1', firstName: 'Ada', lastName: 'Lovelace' },
      [{ fingerPosition: 'right_index', templateData: capture.templateData }]
    );

    const insert = db.prepare(
      `INSERT INTO attendance_logs (employee_id, event_type, match_score, timestamp) VALUES (?, ?, ?, ?)`
    );
    insert.run(employee.id, 'IN', 90, '2026-01-01 09:00:00');
    insert.run(employee.id, 'OUT', 90, '2026-01-01 17:00:00');
    insert.run(employee.id, 'IN', 90, '2026-02-01 09:00:00');
    insert.run(employee.id, 'OUT', 90, '2026-02-01 17:00:00');

    const janOnly = attendanceService.getTimesheet({ startDate: '2026-01-01', endDate: '2026-01-31' });
    assert.equal(janOnly.length, 1);

    const noneForOtherEmployee = attendanceService.getTimesheet({ employeeId: employee.id + 999 });
    assert.equal(noneForOtherEmployee.length, 0);
  } finally {
    cleanup(db, tmpDir);
  }
});
