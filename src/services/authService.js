const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;
const MIN_PIN_LENGTH = 6;
const MAX_PIN_LENGTH = 64;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 10 * 60_000; // auto-lock after 10 minutes with no admin-gated activity

/**
 * Single shared admin credential (id=1), gating employee management,
 * registration, enrollment, and attendance-log viewing.
 *
 * This is the security boundary, not the renderer's login screen: main.js
 * calls requireAuth() before running any protected IPC handler, so a
 * compromised/buggy renderer can't skip the login just by not showing it.
 *
 * Session state is in-memory and per-process (resets on app restart) —
 * appropriate for a single-terminal kiosk, not a multi-user server.
 */
class AuthService {
  constructor(db) {
    this.db = db;
    this.authenticated = false;
    this.failedAttempts = 0;
    this.lockedUntil = 0;
    this.lastActivityAt = 0;
  }

  isConfigured() {
    return !!this.db.prepare('SELECT 1 FROM admin_credentials WHERE id = 1').get();
  }

  /**
   * Lazily expires the session on read — no background timer needed. Every
   * requireAuth() call both checks and refreshes this, so a session stays
   * alive as long as the admin keeps taking admin-gated actions.
   */
  isAuthenticated() {
    if (this.authenticated && Date.now() - this.lastActivityAt > IDLE_TIMEOUT_MS) {
      this.authenticated = false;
    }
    return this.authenticated;
  }

  setup(pin) {
    if (this.isConfigured()) {
      throw new Error('Admin PIN is already configured.');
    }
    this._validatePinShape(pin);

    const { hash, salt } = this._hash(pin);
    this.db
      .prepare('INSERT INTO admin_credentials (id, password_hash, salt) VALUES (1, ?, ?)')
      .run(hash, salt);
    this.authenticated = true;
    this.lastActivityAt = Date.now();
  }

  login(pin) {
    if (!this.isConfigured()) {
      throw new Error('Admin PIN has not been set up yet.');
    }
    if (Date.now() < this.lockedUntil) {
      const secondsLeft = Math.ceil((this.lockedUntil - Date.now()) / 1000);
      throw new Error(`Too many failed attempts. Try again in ${secondsLeft}s.`);
    }
    if (typeof pin !== 'string' || pin.length === 0) {
      this._recordFailure();
      throw new Error('Incorrect PIN.');
    }

    const row = this.db
      .prepare('SELECT password_hash, salt FROM admin_credentials WHERE id = 1')
      .get();
    const { hash } = this._hash(pin, row.salt);

    if (!this._timingSafeEqual(hash, row.password_hash)) {
      this._recordFailure();
      throw new Error('Incorrect PIN.');
    }

    this.failedAttempts = 0;
    this.authenticated = true;
    this.lastActivityAt = Date.now();
    return true;
  }

  logout() {
    this.authenticated = false;
  }

  /**
   * Throws if there is no authenticated (and not idle-expired) admin
   * session. Call at the top of every protected IPC handler — this also
   * refreshes the idle timer, so active use keeps the session alive.
   */
  requireAuth() {
    if (!this.isAuthenticated()) {
      throw new Error('Admin authentication required.');
    }
    this.lastActivityAt = Date.now();
  }

  _recordFailure() {
    this.failedAttempts += 1;
    if (this.failedAttempts >= MAX_FAILED_ATTEMPTS) {
      this.lockedUntil = Date.now() + LOCKOUT_MS;
      this.failedAttempts = 0;
    }
  }

  _validatePinShape(pin) {
    if (typeof pin !== 'string' || pin.length < MIN_PIN_LENGTH || pin.length > MAX_PIN_LENGTH) {
      throw new Error(`PIN must be between ${MIN_PIN_LENGTH} and ${MAX_PIN_LENGTH} characters.`);
    }
  }

  _hash(pin, saltHex) {
    const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
    const hash = crypto.scryptSync(pin, salt, SCRYPT_KEYLEN).toString('hex');
    return { hash, salt: salt.toString('hex') };
  }

  _timingSafeEqual(hexA, hexB) {
    const bufA = Buffer.from(hexA, 'hex');
    const bufB = Buffer.from(hexB, 'hex');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }
}

module.exports = { AuthService, IDLE_TIMEOUT_MS };
