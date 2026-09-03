const { contextBridge, ipcRenderer } = require('electron');

// Whitelisted API surface — the renderer can ONLY call these named
// functions. It never gets ipcRenderer itself, so a compromised/buggy
// renderer can't invoke arbitrary IPC channels.
contextBridge.exposeInMainWorld('api', {
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
});
