# Fingerprint Attendance System

Desktop (Electron) employee attendance app: clock in/out via fingerprint scan.
Built with a hardware-agnostic architecture — runs today with a mock scanner,
and takes one new file to plug in real hardware.

## Run it

```bash
npm install
npm start
```

Requires Node >= 22.12 (Electron 44's minimum). `npm install` compiles
`better-sqlite3` against Electron's Node ABI via `electron-builder
install-app-deps` — if you have multiple Node versions installed, make sure
the one active on your `PATH` satisfies that minimum, or `npm install` will
fall back to compiling from source and fail without the matching native
toolchain (Visual Studio "Desktop development with C++" workload on
Windows).

No fingerprint hardware needed to try it — the app ships with a mock scanner
(`SCANNER_DRIVER=mock`, the default). On the Kiosk tab you pick an employee
from a dropdown to simulate "their finger" on the sensor; everything else
(DB writes, IN/OUT toggling, match rejection) runs exactly as it would with
real hardware.

Data is stored locally only, in a SQLite file on disk (Electron's per-app
`userData` folder) — there is no network/cloud component. Nothing leaves
the machine.

## UI

The renderer is styled as an iOS-style app shell: a slim top bar, a fixed
bottom tab bar with icons, rounded cards, 44px touch targets, and automatic
light/dark mode (`prefers-color-scheme` — no toggle needed, it follows the
OS). No native window menu (`Menu.setApplicationMenu(null)` in `main.js`) —
this is a kiosk app, not a document editor.

It's responsive down to phone-width windows (`minWidth: 360` in
`main.js`): data tables collapse into a stacked card list below 640px via
CSS (`data-label` attributes on each `<td>` drive the label shown in that
view — see the table-rendering code in `app.js` for the pattern to follow
if you add another table).

## Admin access

Employee management, registration, adding fingerprints, and viewing
attendance history are admin-only. The Attendance Kiosk tab (clock in/out)
is open to everyone — that's the flow every employee uses day to day.

- **First run:** opening any admin tab (Register / Employees / Add
  Fingerprint / Recent Logs) prompts you to set a PIN (6+ characters). This
  happens once; the PIN is hashed with scrypt + a random salt and stored in
  the local SQLite DB (`admin_credentials` table) — never in plaintext.
- **Subsequent runs:** the same tabs prompt for the PIN. A session stays
  unlocked until you click **Lock** (top-right of the nav bar) or restart
  the app.
- **Failed attempts:** 5 wrong PINs locks out further attempts for 30
  seconds.
- **Enforcement:** the check happens in `main.js`/`authService.js` on the
  IPC handlers themselves (`requireAuth()`), not just by hiding UI — a
  compromised or modified renderer can't skip login by calling the
  underlying API directly.
- **Idle auto-lock:** a session expires after 10 minutes without an
  admin-gated action (`IDLE_TIMEOUT_MS` in `authService.js`) — re-enter the
  PIN to continue. The renderer polls every 30s so an idle session flips
  back to the login screen even if you never switch tabs.

## Timesheet & exports

- **Timesheet tab** turns raw IN/OUT scans into hours worked per employee
  per day — pick a date range (and optionally one employee), click
  Generate. Pairing logic lives in `attendanceService.getTimesheet()`: an
  overnight shift's hours land on the day it started, and a dangling IN
  with no matching OUT is reported as **incomplete** (0 hours, flagged —
  never guessed).
- **CSV export** — both the Timesheet and Recent Logs tabs have an Export
  CSV button. The renderer builds the CSV text from what's already on
  screen; `main.js` owns the native save dialog and the actual file write
  (the renderer has no filesystem access on its own).
- **Backup Database** button (Employees tab) uses better-sqlite3's online
  backup API (`db.backup()`), which is safe to run against a live DB in WAL
  mode — a raw file copy could otherwise catch a torn write mid-transaction.

## Employee CRUD

- **Create = Registration.** This is deliberately not a plain "add employee"
  form. Registration requires at least one captured fingerprint before it
  will save anything, and the employee row + fingerprint template(s) are
  written in a single database transaction (`registerWithTemplates` in
  `employeeService.js`) — if anything fails (e.g. a duplicate employee
  code), nothing is written at all. You never end up with a half-created
  employee that has no fingerprint on file.
- **Read** — Employees tab lists everyone active; Recent Logs shows
  attendance history.
- **Update** — Employees tab, Edit button, inline row editing.
- **Delete** — soft delete only (Deactivate button). Attendance logs
  reference employees by id, so hard-deleting would either orphan or
  destroy history; deactivated employees are excluded from attendance
  matching but their history stays intact.
- **Add Fingerprint tab** is separate from registration — it's for adding a
  *second* finger (backup) to someone already registered, not for creating
  new employees.

## Architecture

```
main.js                        Electron main process — wires everything together, IPC auth gating
preload.js                     Safe IPC bridge (renderer has zero direct Node access)
src/db/
  schema.sql                   employees, fingerprint_templates, attendance_logs, admin_credentials
  database.js                  SQLite connection (better-sqlite3, WAL mode)
src/services/
  fingerprintScanner.js        IFingerprintScanner contract + adapter factory
  adapters/
    mockScanner.js             Working, no-hardware adapter (default)
    secugenScanner.js          Reference stub for real SecuGen integration
  employeeService.js           Employee CRUD + template storage (validates all input)
  attendanceService.js         Capture -> match -> IN/OUT decision -> log -> timesheet aggregation
  authService.js               Admin PIN setup/login (scrypt hash, lockout, idle timeout)
src/renderer/                  Vanilla JS UI (no build step) — Kiosk / Employees / Enroll / Logs / Timesheet
test/
  services.test.js             node:test suite for the service layer (no Electron needed)
```

**Why this shape:**

- **Adapter pattern for the scanner.** Every fingerprint vendor (SecuGen,
  ZKTeco, DigitalPersona, ...) has a different SDK. Nothing outside
  `src/services/adapters/` should know which one you're using — services and
  UI only depend on the `capture()` / `matchAgainstStored()` contract. Adding
  real hardware later means writing one new adapter file, not touching the
  rest of the app.
- **Service layer has no Electron/SQL-specific code leaking into it** — it
  takes a `db` handle and a `scanner` instance as dependencies (constructor
  injection), which is also what made it possible to unit-test
  `attendanceService` in plain Node without spinning up Electron at all.
- **IPC boundary, not raw Node in the renderer.** `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`, plus a whitelisted `preload.js`
  API means a bug or injected content in the UI can't reach the filesystem
  or DB directly — standard Electron security practice, not optional
  hardening. The window also blocks in-app navigation and new-window
  creation (`will-navigate` / `setWindowOpenHandler`), and `index.html`
  ships a strict Content-Security-Policy with no `unsafe-inline`.
- **Auth is enforced at the IPC handler, not the UI.** `authService.js`
  gates employee management, registration, enrollment, and log-viewing
  handlers in `main.js` directly — the renderer's login screen is just UX;
  removing it wouldn't remove the protection.
- **All renderer-supplied strings are HTML-escaped before rendering**
  (`escapeHtml` in `app.js`). Employee names/codes/departments are
  operator-entered and stored in the DB, so they're rendered via
  `innerHTML` template strings elsewhere in the UI — without escaping, a
  stored value could execute as script the next time any tab renders it.
- **Attendance logs are append-only.** Never update/delete rows there in
  normal operation; it's your audit trail. Employee deactivation is a soft
  delete (`is_active` flag) for the same reason — you don't want IN/OUT
  history vanishing when someone leaves.

## Wiring up real hardware

1. Pick a scanner. SecuGen is a common, well-documented starting point —
   `secugenScanner.js` shows the integration pattern (most vendors run a
   local HTTP service exposing their native SDK; you call it from Node the
   same way you'd call any REST API).
2. Fill in that adapter's methods against the vendor's current SDK docs —
   don't trust endpoint details from this scaffold or from an LLM's memory,
   SDK versions change.
3. Register it in `fingerprintScanner.js`'s factory (a `zkteco` or
   `digitalpersona` case follows the same shape).
4. Set `SCANNER_DRIVER=secugen` (or your vendor) as an environment variable
   before `npm start`. Nothing else changes.

## Scaling out (if this grows beyond one kiosk)

This is built for a single-terminal, single-office setup (SQLite,
in-process). If you eventually need multiple attendance terminals writing to
one shared database, or a web dashboard for HR, that's the point to swap
SQLite for a client/server DB (Postgres) and put a small API server between
the kiosks and the database — the `employeeService`/`attendanceService`
layer barely changes, since it only talks to `db` through parameterized
queries already.

## Known gaps / next steps

- **Database is not encrypted at rest.** Employee PII and fingerprint
  templates live in a plain SQLite file
  (`<userData>/attendance.db`). `better-sqlite3` has no native encryption
  support; encrypting would mean migrating to an encrypted driver (e.g.
  `better-sqlite3-multiple-ciphers`) and managing a local key. For now this
  relies on OS-level disk encryption (BitLocker/FileVault) and physical
  security of the kiosk machine — treat the `userData` folder as sensitive
  and back it up/wipe it accordingly.
- **Single shared admin PIN**, not per-admin accounts — fine for a
  single-terminal kiosk with one or two admins; if this grows to multiple
  admins needing individual audit trails, that's the point to add real
  user accounts.
- No `.exe`/installer built yet — `electron-builder` is included in
  devDependencies; run `npx electron-builder` when ready to ship a Windows
  installer.
- Match threshold (`MATCH_THRESHOLD` in `attendanceService.js`) is a
  placeholder — real scanners return meaningfully different score ranges,
  tune this once you're on real hardware.
- Timesheet date-range filtering is by UTC calendar date while hour buckets
  are by local calendar date — see the comment on `getTimesheet()` in
  `attendanceService.js`. Not an issue for typical daytime shifts; could
  misattribute a shift within a couple hours of midnight UTC to the wrong
  side of a range filter.

## Tests

```bash
npm test
```

Runs `node --test` against `test/services.test.js` — no Electron process,
no mocks, a real temp SQLite DB per test. Covers auth (setup/login/lockout/
idle-expiry), employee field validation, atomic registration + rollback,
attendance IN/OUT + soft-delete history, and timesheet hour computation.
