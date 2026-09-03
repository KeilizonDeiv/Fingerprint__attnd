const MAX_FIELD_LENGTH = 100;

class EmployeeService {
  constructor(db) {
    this.db = db;
  }

  /**
   * Defense-in-depth: the renderer already trims/requires these fields, but
   * services must never trust the renderer — validate again here so a
   * malformed IPC call (or a future non-UI caller) can't write garbage or
   * oversized rows.
   */
  _validateFields({ employeeCode, firstName, lastName, department }) {
    const checkString = (value, name, { required }) => {
      if (value == null || value === '') {
        if (required) throw new Error(`${name} is required`);
        return;
      }
      if (typeof value !== 'string') {
        throw new Error(`${name} must be a string`);
      }
      if (value.length > MAX_FIELD_LENGTH) {
        throw new Error(`${name} must be ${MAX_FIELD_LENGTH} characters or fewer`);
      }
    };

    checkString(employeeCode, 'employeeCode', { required: true });
    checkString(firstName, 'firstName', { required: true });
    checkString(lastName, 'lastName', { required: true });
    checkString(department, 'department', { required: false });
  }

  /**
   * Atomic registration: create the employee AND save their captured
   * fingerprint template(s) in a single database transaction. If anything
   * fails (most commonly a duplicate employee_code), NOTHING is written —
   * you never end up with an employee row that has no fingerprint, or a
   * half-registered person. This is what "the create thing needs a
   * registration" means in practice: registration is one atomic operation,
   * not "add employee" then separately, optionally, "enroll a finger".
   *
   * @param {{employeeCode, firstName, lastName, department}} employeeData
   * @param {Array<{fingerPosition: string, templateData: string}>} templates
   *   Must contain at least one entry — enforced here, not just in the UI,
   *   because services should never trust the renderer to have validated.
   */
  registerWithTemplates(employeeData, templates) {
    if (!templates || templates.length === 0) {
      throw new Error('At least one fingerprint capture is required to register an employee.');
    }

    const run = this.db.transaction(() => {
      const employee = this.create(employeeData); // throws on duplicate employeeCode
      for (const t of templates) {
        this.addFingerprintTemplate(employee.id, t.fingerPosition, t.templateData);
      }
      return employee;
    });

    return run(); // better-sqlite3 auto-rolls-back the whole transaction if run() throws
  }

  update(employeeId, { employeeCode, firstName, lastName, department }) {
    const existing = this.getById(employeeId);
    if (!existing) {
      throw new Error('Employee not found.');
    }
    this._validateFields({
      employeeCode: employeeCode ?? existing.employee_code,
      firstName: firstName ?? existing.first_name,
      lastName: lastName ?? existing.last_name,
      department: department ?? existing.department,
    });
    this.db
      .prepare(
        `UPDATE employees
         SET employee_code = ?, first_name = ?, last_name = ?, department = ?
         WHERE id = ?`
      )
      .run(
        employeeCode ?? existing.employee_code,
        firstName ?? existing.first_name,
        lastName ?? existing.last_name,
        department ?? existing.department,
        employeeId
      );
    return this.getById(employeeId);
  }

  listActive() {
    return this.db
      .prepare('SELECT * FROM employees WHERE is_active = 1 ORDER BY last_name, first_name')
      .all();
  }

  getById(employeeId) {
    return this.db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
  }

  create({ employeeCode, firstName, lastName, department }) {
    this._validateFields({ employeeCode, firstName, lastName, department });
    try {
      const result = this.db
        .prepare(
          `INSERT INTO employees (employee_code, first_name, last_name, department)
           VALUES (?, ?, ?, ?)`
        )
        .run(employeeCode, firstName, lastName, department || null);
      return this.getById(result.lastInsertRowid);
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new Error(`Employee code "${employeeCode}" is already in use.`);
      }
      throw err;
    }
  }

  deactivate(employeeId) {
    // Soft delete — keep attendance history intact.
    this.db.prepare('UPDATE employees SET is_active = 0 WHERE id = ?').run(employeeId);
  }

  addFingerprintTemplate(employeeId, fingerPosition, templateData) {
    this.db
      .prepare(
        `INSERT INTO fingerprint_templates (employee_id, finger_position, template_data)
         VALUES (?, ?, ?)`
      )
      .run(employeeId, fingerPosition, templateData);
  }

  getAllTemplatesWithEmployee() {
    // Used at attendance time: pull every enrolled template so the scanner
    // adapter can match a live capture against all of them.
    return this.db
      .prepare(
        `SELECT ft.employee_id AS employeeId, ft.template_data AS templateData
         FROM fingerprint_templates ft
         JOIN employees e ON e.id = ft.employee_id
         WHERE e.is_active = 1`
      )
      .all();
  }

  /**
   * Metadata only — deliberately excludes template_data. Fingerprint
   * templates are biometric PII; nothing outside the DB/scanner-matching
   * path (see attendanceService.getAllTemplatesWithEmployee, used
   * internally, never sent over IPC) should ever see the raw encoded data.
   */
  getTemplatesForEmployee(employeeId) {
    return this.db
      .prepare(
        `SELECT id, employee_id, finger_position, enrolled_at
         FROM fingerprint_templates WHERE employee_id = ?`
      )
      .all(employeeId);
  }
}

module.exports = { EmployeeService };
