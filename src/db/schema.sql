-- Employees are the source of truth for who exists in the system.
CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_code TEXT UNIQUE NOT NULL,   -- e.g. company ID number, human-facing
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    department TEXT,
    is_active INTEGER NOT NULL DEFAULT 1, -- soft delete: never hard-delete attendance history
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A person can enroll more than one finger (backup finger is standard practice
-- in case of injury/dirt/bad reads), so this is one-to-many against employees.
CREATE TABLE IF NOT EXISTS fingerprint_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    finger_position TEXT NOT NULL,        -- e.g. 'right_index', 'left_thumb'
    template_data TEXT NOT NULL,          -- vendor-specific encoded template (base64), NEVER a raw image
    enrolled_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only log. Never update/delete rows here in normal operation —
-- attendance records are effectively an audit trail.
CREATE TABLE IF NOT EXISTS attendance_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    event_type TEXT NOT NULL CHECK (event_type IN ('IN', 'OUT')),
    method TEXT NOT NULL DEFAULT 'fingerprint', -- keep room for 'manual', 'rfid', etc.
    match_score REAL,                     -- confidence score from the scanner, for audit/tuning
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_attendance_employee_time
    ON attendance_logs(employee_id, timestamp);

CREATE INDEX IF NOT EXISTS idx_templates_employee
    ON fingerprint_templates(employee_id);

-- Single shared admin credential (id fixed at 1 — one admin per kiosk).
-- Gates employee management, registration, enrollment, and log viewing at
-- the IPC boundary (see authService.js / main.js requireAuth wrapper), not
-- just in the renderer UI.
CREATE TABLE IF NOT EXISTS admin_credentials (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
