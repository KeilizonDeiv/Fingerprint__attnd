const MATCH_THRESHOLD = 70; // minimum confidence score to accept a match; tune per scanner

/**
 * SQLite's `datetime('now')` (see schema.sql) stores UTC as
 * "YYYY-MM-DD HH:MM:SS" with no timezone marker. `new Date(ts)` on that
 * string is misparsed as *local* time by JS engines (it's not a
 * recognized ISO format) — silently shifting every timestamp by the
 * machine's UTC offset. Mark it UTC explicitly before parsing.
 */
function parseDbTimestamp(ts) {
  return new Date(`${ts.replace(' ', 'T')}Z`);
}

class AttendanceService {
  constructor(db, scanner, employeeService) {
    this.db = db;
    this.scanner = scanner;
    this.employeeService = employeeService;
  }

  /**
   * Full "someone just placed a finger on the kiosk" flow:
   * capture -> match -> decide IN or OUT -> log it.
   *
   * @param {{simulateKey?: string}} captureOptions - passed through to
   *   scanner.capture(); only meaningful for the mock adapter (see
   *   mockScanner.js) — real adapters ignore it and read the sensor.
   */
  async recordScan(captureOptions = {}) {
    const captured = await this.scanner.capture(captureOptions);

    if (captured.quality < 40) {
      return { status: 'POOR_QUALITY', message: 'Scan quality too low, please try again.' };
    }

    const storedTemplates = this.employeeService.getAllTemplatesWithEmployee();
    const match = await this.scanner.matchAgainstStored(captured, storedTemplates);

    if (!match || match.score < MATCH_THRESHOLD) {
      return { status: 'NO_MATCH', message: 'Fingerprint not recognized.' };
    }

    const employee = this.employeeService.getById(match.employeeId);
    if (!employee) {
      return { status: 'NO_MATCH', message: 'Matched employee record not found.' };
    }

    const eventType = this._nextEventType(employee.id);
    this._insertLog(employee.id, eventType, match.score);

    return {
      status: 'OK',
      employee,
      eventType,
      score: match.score,
      timestamp: new Date().toISOString(),
    };
  }

  /** Employees alternate IN/OUT automatically based on their last event. */
  _nextEventType(employeeId) {
    const last = this.db
      .prepare(
        `SELECT event_type FROM attendance_logs
         WHERE employee_id = ? ORDER BY timestamp DESC LIMIT 1`
      )
      .get(employeeId);
    return !last || last.event_type === 'OUT' ? 'IN' : 'OUT';
  }

  _insertLog(employeeId, eventType, score) {
    this.db
      .prepare(
        `INSERT INTO attendance_logs (employee_id, event_type, match_score)
         VALUES (?, ?, ?)`
      )
      .run(employeeId, eventType, score);
  }

  /**
   * Pairs IN/OUT events into worked sessions and buckets them by the local
   * calendar date of the IN event — an overnight shift's hours land
   * entirely on the day it started. This is the "attendance history" data
   * turned into what payroll actually needs: hours per employee per day.
   *
   * A dangling IN with no following OUT (still clocked in, or an operator
   * forgot to scan out) is reported with `incomplete: true` and doesn't
   * count toward hours — better to under-report and flag it than silently
   * guess an end time.
   *
   * @param {{startDate?: string, endDate?: string, employeeId?: number}} filters
   *   startDate/endDate are inclusive 'YYYY-MM-DD' strings filtered by
   *   *UTC* calendar date (SQLite's date() function), while rows are
   *   *bucketed* by local calendar date — for typical daytime shifts these
   *   agree, but a shift within a few hours of midnight UTC could in
   *   principle fall just outside a UTC-day range filter while still
   *   landing in an in-range local date bucket, or vice versa. Not worth
   *   the added complexity of two parallel date systems for a
   *   single-timezone kiosk; worth knowing if reports look off near a
   *   range boundary.
   */
  getTimesheet({ startDate, endDate, employeeId } = {}) {
    const conditions = [];
    const params = [];
    if (startDate) {
      conditions.push('date(al.timestamp) >= date(?)');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('date(al.timestamp) <= date(?)');
      params.push(endDate);
    }
    if (employeeId) {
      conditions.push('al.employee_id = ?');
      params.push(employeeId);
    }

    const rows = this.db
      .prepare(
        `SELECT al.employee_id AS employeeId, al.event_type AS eventType, al.timestamp AS timestamp,
                e.employee_code AS employeeCode, e.first_name AS firstName, e.last_name AS lastName
         FROM attendance_logs al
         JOIN employees e ON e.id = al.employee_id
         ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY al.employee_id, al.timestamp`
      )
      .all(...params);

    const byEmployee = new Map();
    for (const row of rows) {
      if (!byEmployee.has(row.employeeId)) byEmployee.set(row.employeeId, []);
      byEmployee.get(row.employeeId).push(row);
    }

    const dayKey = (date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

    const days = new Map(); // `${employeeId}|${dateKey}` -> aggregate

    const ensureDay = (log, inAt) => {
      const key = `${log.employeeId}|${dayKey(inAt)}`;
      if (!days.has(key)) {
        days.set(key, {
          employeeId: log.employeeId,
          employeeCode: log.employeeCode,
          firstName: log.firstName,
          lastName: log.lastName,
          date: dayKey(inAt),
          ms: 0,
          firstIn: inAt,
          lastOut: null,
          incomplete: false,
        });
      }
      return days.get(key);
    };

    for (const logs of byEmployee.values()) {
      let pendingIn = null;
      for (const log of logs) {
        if (log.eventType === 'IN') {
          pendingIn = log; // a second IN with no OUT in between just replaces the pending one
        } else if (log.eventType === 'OUT' && pendingIn) {
          const inAt = parseDbTimestamp(pendingIn.timestamp);
          const outAt = parseDbTimestamp(log.timestamp);
          const entry = ensureDay(pendingIn, inAt);
          entry.ms += outAt.getTime() - inAt.getTime();
          if (inAt < entry.firstIn) entry.firstIn = inAt;
          if (!entry.lastOut || outAt > entry.lastOut) entry.lastOut = outAt;
          pendingIn = null;
        }
      }
      if (pendingIn) {
        const inAt = parseDbTimestamp(pendingIn.timestamp);
        ensureDay(pendingIn, inAt).incomplete = true;
      }
    }

    return [...days.values()]
      .map((d) => ({
        employeeId: d.employeeId,
        employeeCode: d.employeeCode,
        firstName: d.firstName,
        lastName: d.lastName,
        date: d.date,
        hours: Math.round((d.ms / 3600000) * 100) / 100,
        firstIn: d.firstIn.toISOString(),
        lastOut: d.lastOut ? d.lastOut.toISOString() : null,
        incomplete: d.incomplete,
      }))
      .sort((a, b) => (a.date === b.date ? a.employeeCode.localeCompare(b.employeeCode) : a.date.localeCompare(b.date)));
  }

  getRecentLogs(limit = 50) {
    return this.db
      .prepare(
        `SELECT al.*, e.first_name, e.last_name, e.employee_code
         FROM attendance_logs al
         JOIN employees e ON e.id = al.employee_id
         ORDER BY al.timestamp DESC
         LIMIT ?`
      )
      .all(limit);
  }
}

module.exports = { AttendanceService };
