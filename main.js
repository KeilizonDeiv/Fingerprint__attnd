const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const { getDb } = require('./src/db/database');
const { createScanner } = require('./src/services/fingerprintScanner');
const { EmployeeService } = require('./src/services/employeeService');
const { AttendanceService } = require('./src/services/attendanceService');
const { AuthService } = require('./src/services/authService');

const FINGER_POSITIONS = new Set(['right_index', 'left_index', 'right_thumb', 'left_thumb']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EXPORT_CHARS = 5_000_000; // ~5MB of CSV text — generous for a single-kiosk dataset

let mainWindow;
let db;
let employeeService;
let attendanceService;
let authService;
let scanner;

async function createWindow() {
  // This is a single-purpose kiosk app, not a document editor — a native
  // File/Edit/View/Window menu bar doesn't belong here and breaks the
  // app-like feel. All navigation happens through the in-app tab bar.
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 360,
    minHeight: 560,
    webPreferences: {
      // Security defaults: the renderer gets NO direct Node/filesystem/DB
      // access. Everything crosses through preload.js's whitelisted API.
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Defense in depth: this app never loads remote content, so there's no
  // legitimate reason for the renderer to navigate away or open new
  // windows. Block both outright.
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.loadFile(path.join(__dirname, 'src/renderer/index.html'));
}

// --- Input validation helpers -------------------------------------------
// Services validate too, but the IPC boundary is where untrusted renderer
// input first enters the main process — fail fast here with clear errors
// rather than letting malformed values reach SQL or the scanner adapter.

function toPositiveInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return n;
}

function toOptionalString(value, label, maxLength = 100) {
  if (value == null || value === '') return value ?? null;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function clampLimit(value, def = 50, max = 200) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

function toOptionalDate(value, label) {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new Error(`${label} must be a YYYY-MM-DD date.`);
  }
  return value;
}

/** Strips path separators/traversal so a renderer-supplied name can only ever suggest a filename, never a destination. */
function sanitizeFilename(name, fallback) {
  const base = typeof name === 'string' && name ? path.basename(name) : fallback;
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || fallback;
  return cleaned.toLowerCase().endsWith('.csv') ? cleaned : `${cleaned}.csv`;
}

/**
 * Wraps every IPC handler so: (1) an admin session can be required with one
 * line, and (2) unexpected errors are logged server-side but only ever
 * cross the IPC boundary as a clean message — never a raw stack trace,
 * which could leak local file paths to the renderer.
 */
function handler(fn, { auth = false } = {}) {
  return async (...args) => {
    try {
      if (auth) authService.requireAuth();
      return await fn(...args);
    } catch (err) {
      console.error(err);
      throw new Error(err.message || 'An unexpected error occurred.');
    }
  };
}

function registerIpcHandlers() {
  // --- Auth ---------------------------------------------------------------
  // Never gated by requireAuth (you can't require login to log in), but
  // setup()/login() enforce their own rules (already-configured, lockout).
  ipcMain.handle('auth:status', handler(() => ({
    configured: authService.isConfigured(),
    authenticated: authService.isAuthenticated(),
  })));
  ipcMain.handle('auth:setup', handler((_event, { pin }) => {
    authService.setup(pin);
    return { authenticated: true };
  }));
  ipcMain.handle('auth:login', handler((_event, { pin }) => {
    authService.login(pin);
    return { authenticated: true };
  }));
  ipcMain.handle('auth:logout', handler(() => {
    authService.logout();
    return { authenticated: false };
  }));

  // --- Employees ------------------------------------------------------------
  // employees:list stays unauthenticated: the Kiosk tab needs it to render
  // the "simulate a finger" dropdown for the mock scanner. Real hardware
  // wouldn't need this endpoint at all (a physical sensor just reads
  // whichever finger is present) — this is a demo-only exposure of
  // names/codes, never fingerprint data. Everything else here is
  // admin-only.
  ipcMain.handle('employees:list', handler(() => employeeService.listActive()));

  ipcMain.handle(
    'employees:create',
    handler((_event, data) => employeeService.create(data), { auth: true })
  );

  ipcMain.handle(
    'employees:update',
    handler((_event, { employeeId, data }) =>
      employeeService.update(toPositiveInt(employeeId, 'employeeId'), data), { auth: true }
    )
  );

  ipcMain.handle(
    'employees:deactivate',
    handler((_event, employeeId) =>
      employeeService.deactivate(toPositiveInt(employeeId, 'employeeId')), { auth: true }
    )
  );

  ipcMain.handle(
    'employees:getTemplates',
    handler((_event, employeeId) =>
      employeeService.getTemplatesForEmployee(toPositiveInt(employeeId, 'employeeId')), { auth: true }
    )
  );

  // --- Registration (Create) --------------------------------------------
  // Registration is atomic: capture happens against the employee_code the
  // operator has typed (no employee row exists yet — see mockScanner.js),
  // and nothing is written to the DB until registration:complete runs.
  // Admin-only: this is how new employees enter the system.

  ipcMain.handle(
    'registration:captureFingerprint',
    handler(
      async (_event, { employeeCode }) =>
        scanner.capture({ simulateKey: toOptionalString(employeeCode, 'employeeCode') }),
      { auth: true }
    )
  );

  ipcMain.handle(
    'registration:complete',
    handler(
      async (_event, { employeeData, templates }) => {
        if (!Array.isArray(templates)) {
          throw new Error('templates must be an array.');
        }
        for (const t of templates) {
          if (!FINGER_POSITIONS.has(t?.fingerPosition)) {
            throw new Error('Invalid finger position.');
          }
          if (typeof t?.templateData !== 'string' || t.templateData.length === 0 || t.templateData.length > 20000) {
            throw new Error('Invalid fingerprint template data.');
          }
        }
        // Let errors (e.g. duplicate code, missing fingerprint) bubble up —
        // the renderer shows err.message to the operator.
        return employeeService.registerWithTemplates(employeeData, templates);
      },
      { auth: true }
    )
  );

  // --- Add an additional fingerprint to an EXISTING employee -------------
  ipcMain.handle(
    'enrollment:capture',
    handler(async (_event, { employeeId, fingerPosition }) => {
      const id = toPositiveInt(employeeId, 'employeeId');
      if (!FINGER_POSITIONS.has(fingerPosition)) {
        throw new Error('Invalid finger position.');
      }
      const employee = employeeService.getById(id);
      if (!employee) throw new Error('Employee not found.');
      const captured = await scanner.capture({ simulateKey: employee.employee_code });
      employeeService.addFingerprintTemplate(id, fingerPosition, captured.templateData);
      return captured;
    }, { auth: true })
  );

  // --- Attendance -----------------------------------------------------------
  // attendance:scan stays unauthenticated by design — this is the kiosk
  // clock-in/out flow every employee uses, not an admin action.
  ipcMain.handle('attendance:scan', handler(async (_event, { simulateKey } = {}) =>
    attendanceService.recordScan({ simulateKey: toOptionalString(simulateKey, 'simulateKey') })
  ));

  // Viewing history is admin-only (it's PII + an audit trail).
  ipcMain.handle(
    'attendance:recent',
    handler((_event, limit) => attendanceService.getRecentLogs(clampLimit(limit)), { auth: true })
  );

  ipcMain.handle(
    'attendance:timesheet',
    handler(
      (_event, { startDate, endDate, employeeId } = {}) =>
        attendanceService.getTimesheet({
          startDate: toOptionalDate(startDate, 'startDate'),
          endDate: toOptionalDate(endDate, 'endDate'),
          employeeId: employeeId ? toPositiveInt(employeeId, 'employeeId') : undefined,
        }),
      { auth: true }
    )
  );

  // --- Export / backup -------------------------------------------------
  // The renderer already has the exact rows it's displaying (it built the
  // CSV client-side); main.js's job is just to own the native save dialog
  // and the actual filesystem write, since the renderer has no fs access.
  ipcMain.handle(
    'export:csv',
    handler(async (_event, { suggestedName, content }) => {
      if (typeof content !== 'string' || content.length === 0) {
        throw new Error('Nothing to export.');
      }
      if (content.length > MAX_EXPORT_CHARS) {
        throw new Error('Export is too large.');
      }
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Export CSV',
        defaultPath: sanitizeFilename(suggestedName, 'export.csv'),
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (canceled || !filePath) return { canceled: true };
      fs.writeFileSync(filePath, content, 'utf8');
      return { canceled: false, filePath };
    }, { auth: true })
  );

  ipcMain.handle(
    'backup:create',
    handler(async () => {
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Backup Attendance Database',
        defaultPath: `attendance-backup-${new Date().toISOString().slice(0, 10)}.db`,
        filters: [{ name: 'SQLite Database', extensions: ['db'] }],
      });
      if (canceled || !filePath) return { canceled: true };
      // better-sqlite3's online backup API — safe to run against a live DB
      // in WAL mode, unlike a raw file copy which could grab a torn write.
      await db.backup(filePath);
      return { canceled: false, filePath };
    }, { auth: true })
  );
}

app.whenReady().then(async () => {
  db = getDb(app.getPath('userData'));

  scanner = createScanner(); // defaults to 'mock' unless SCANNER_DRIVER env var is set
  await scanner.initialize();

  employeeService = new EmployeeService(db);
  attendanceService = new AttendanceService(db, scanner, employeeService);
  authService = new AuthService(db);

  registerIpcHandlers();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  if (scanner) await scanner.disconnect();
});
