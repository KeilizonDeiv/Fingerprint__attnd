const { contextBridge, ipcRenderer } = require('electron');

// Whitelisted API surface — the renderer can ONLY call these named
// functions. It never gets ipcRenderer itself, so a compromised/buggy
// renderer can't invoke arbitrary IPC channels.
contextBridge.exposeInMainWorld('api', {
  // Admin auth — gates employee management, registration, enrollment, and
  // log viewing. Enforced in main.js at the IPC boundary, not just here.
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authSetup: (pin) => ipcRenderer.invoke('auth:setup', { pin }),
  authLogin: (pin) => ipcRenderer.invoke('auth:login', { pin }),
  authLogout: () => ipcRenderer.invoke('auth:logout'),

  listEmployees: () => ipcRenderer.invoke('employees:list'),
  updateEmployee: (employeeId, data) => ipcRenderer.invoke('employees:update', { employeeId, data }),
  deactivateEmployee: (id) => ipcRenderer.invoke('employees:deactivate', id),
  getTemplates: (employeeId) => ipcRenderer.invoke('employees:getTemplates', employeeId),

  // Registration (Create): capture fingerprint(s) against the in-progress
  // form's employee code, then complete registration atomically.
  captureRegistrationFingerprint: (employeeCode) =>
    ipcRenderer.invoke('registration:captureFingerprint', { employeeCode }),
  completeRegistration: (employeeData, templates) =>
    ipcRenderer.invoke('registration:complete', { employeeData, templates }),

  // Add an extra fingerprint to an employee who's already registered.
  captureEnrollment: (employeeId, fingerPosition) =>
    ipcRenderer.invoke('enrollment:capture', { employeeId, fingerPosition }),

  scanAttendance: (simulateKey) => ipcRenderer.invoke('attendance:scan', { simulateKey }),

  recentAttendance: (limit) => ipcRenderer.invoke('attendance:recent', limit),
  getTimesheet: (params) => ipcRenderer.invoke('attendance:timesheet', params),

  // Main process owns the native save dialog + filesystem write; the
  // renderer only ever hands over already-built text content.
  exportCsv: (suggestedName, content) => ipcRenderer.invoke('export:csv', { suggestedName, content }),
  createBackup: () => ipcRenderer.invoke('backup:create'),
});
