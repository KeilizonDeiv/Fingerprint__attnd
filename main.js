const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const { getDb } = require('./src/db/database');
const { createScanner } = require('./src/services/fingerprintScanner');
const { EmployeeService } = require('./src/services/employeeService');
const { AttendanceService } = require('./src/services/attendanceService');

let mainWindow;
let employeeService;
let attendanceService;
let scanner;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      // Security defaults: the renderer gets NO direct Node/filesystem/DB
      // access. Everything crosses through preload.js's whitelisted API.
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src/renderer/index.html'));
}

function registerIpcHandlers(db) {
  ipcMain.handle('employees:list', () => employeeService.listActive());

  ipcMain.handle('employees:create', (_event, data) => employeeService.create(data));

  ipcMain.handle('employees:update', (_event, { employeeId, data }) =>
    employeeService.update(employeeId, data)
  );

  ipcMain.handle('employees:deactivate', (_event, employeeId) =>
    employeeService.deactivate(employeeId)
  );

  ipcMain.handle('employees:getTemplates', (_event, employeeId) =>
    employeeService.getTemplatesForEmployee(employeeId)
  );

  // --- Registration (Create) --------------------------------------------
  // Registration is atomic: capture happens against the employee_code the
  // operator has typed (no employee row exists yet — see mockScanner.js),
  // and nothing is written to the DB until registration:complete runs.

  ipcMain.handle('registration:captureFingerprint', async (_event, { employeeCode }) => {
    return scanner.capture({ simulateKey: employeeCode });
  });

  ipcMain.handle('registration:complete', async (_event, { employeeData, templates }) => {
    // Let errors (e.g. duplicate code, missing fingerprint) bubble up —
    // the renderer shows err.message to the operator.
    return employeeService.registerWithTemplates(employeeData, templates);
  });

  // --- Add an additional fingerprint to an EXISTING employee -------------
  ipcMain.handle('enrollment:capture', async (_event, { employeeId, fingerPosition }) => {
    const employee = employeeService.getById(employeeId);
    if (!employee) throw new Error('Employee not found.');
    const captured = await scanner.capture({ simulateKey: employee.employee_code });
    employeeService.addFingerprintTemplate(employeeId, fingerPosition, captured.templateData);
    return captured;
  });

  ipcMain.handle('attendance:scan', async (_event, { simulateKey } = {}) =>
    attendanceService.recordScan({ simulateKey })
  );

  ipcMain.handle('attendance:recent', (_event, limit) => attendanceService.getRecentLogs(limit));
}

app.whenReady().then(async () => {
  const db = getDb(app.getPath('userData'));

  scanner = createScanner(); // defaults to 'mock' unless SCANNER_DRIVER env var is set
  await scanner.initialize();

  employeeService = new EmployeeService(db);
  attendanceService = new AttendanceService(db, scanner, employeeService);

  registerIpcHandlers(db);
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
