# Fingerprint Attendance System

Desktop (Electron) employee attendance app: clock in/out via fingerprint scan.
Built with a hardware-agnostic architecture — runs today with a mock scanner,
and takes one new file to plug in real hardware.

## Run it

```bash
npm install
npm start
```

No fingerprint hardware needed to try it — the app ships with a mock scanner
(`SCANNER_DRIVER=mock`, the default). On the Kiosk tab you pick an employee
from a dropdown to simulate "their finger" on the sensor; everything else
(DB writes, IN/OUT toggling, match rejection) runs exactly as it would with
real hardware.

Data is stored locally only, in a SQLite file on disk (Electron's per-app
`userData` folder) — there is no network/cloud component. Nothing leaves
the machine.

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
main.js                        Electron main process — wires everything together
preload.js                     Safe IPC bridge (renderer has zero direct Node access)
src/db/
  schema.sql                   employees, fingerprint_templates, attendance_logs
  database.js                  SQLite connection (better-sqlite3, WAL mode)
src/services/
  fingerprintScanner.js        IFingerprintScanner contract + adapter factory
  adapters/
    mockScanner.js             Working, no-hardware adapter (default)
    secugenScanner.js          Reference stub for real SecuGen integration
  employeeService.js           Employee CRUD + template storage
  attendanceService.js         Capture -> match -> IN/OUT decision -> log
src/renderer/                  Vanilla JS UI (no build step) — Kiosk / Employees / Enroll / Logs
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
- **IPC boundary, not raw Node in the renderer.** `contextIsolation: true` +
  a whitelisted `preload.js` API means a bug or injected content in the UI
  can't reach the filesystem or DB directly — standard Electron security
  practice, not optional hardening.
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

- No authentication/admin login on the Employees tab yet — anyone with
  physical access to the app can add/deactivate employees. Add one before
  any real deployment.
- No `.exe`/installer built yet — `electron-builder` is included in
  devDependencies; run `npx electron-builder` when ready to ship a Windows
  installer.
- Match threshold (`MATCH_THRESHOLD` in `attendanceService.js`) is a
  placeholder — real scanners return meaningfully different score ranges,
  tune this once you're on real hardware.
