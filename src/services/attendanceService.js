const MATCH_THRESHOLD = 70; // minimum confidence score to accept a match; tune per scanner

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
