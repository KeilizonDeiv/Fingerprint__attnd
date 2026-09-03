const crypto = require('crypto');

/**
 * MockScanner — implements IFingerprintScanner without any hardware.
 *
 * Real biometric matching can't be faked meaningfully without a real sensor,
 * so this adapter takes an honest shortcut for development/testing: the UI
 * tells it which "person" is placing their finger via an opaque `simulateKey`
 * string (we use employee_code for this — see note below on why).
 *
 * Important: this is keyed by a KEY STRING, not a database employee id.
 * That matters for registration — a brand-new employee doesn't have a
 * database id yet at the moment their fingerprint is captured, exactly like
 * a real sensor: it reads a finger with no idea who owns it. The id only
 * gets attached afterward, when the template is saved to a row in the DB.
 * employee_code works as the key because the operator types/knows it before
 * the employee exists, and it's guaranteed unique (DB constraint).
 *
 * This means every OTHER layer of the app (DB, services, IPC, UI, the
 * registration and clock-in/out flows) is genuinely tested end to end
 * today, and swapping in real hardware later only means replacing this one
 * file — real hardware doesn't need any of this, it just returns a template
 * for whatever finger is physically present.
 */
class MockScanner {
  async initialize() {
    // Real adapters: open device handle / connect to local SDK service here.
    return Promise.resolve();
  }

  /**
   * @param {{ simulateKey?: string, simulateQuality?: number }} options
   *   Mock-only knobs, surfaced by the UI so a dev can drive the demo.
   *   Real adapters ignore/omit these and read the physical sensor instead.
   */
  async capture(options = {}) {
    // Simulate the ~1-2s a real sensor takes to read a finger.
    await new Promise((resolve) => setTimeout(resolve, 800));

    const { simulateKey = null, simulateQuality = 85 } = options;

    // Embed the key + a random salt so templates for the same "finger"
    // aren't byte-identical every time (real templates aren't either —
    // sensors never produce the exact same read twice).
    const salt = crypto.randomBytes(8).toString('hex');
    const payload = JSON.stringify({ key: simulateKey, salt });
    const templateData = Buffer.from(payload).toString('base64');

    return { templateData, quality: simulateQuality };
  }

  /**
   * @param {{templateData: string}} capturedTemplate
   * @param {Array<{employeeId: number, templateData: string}>} storedTemplates
   */
  async matchAgainstStored(capturedTemplate, storedTemplates) {
    const decoded = JSON.parse(
      Buffer.from(capturedTemplate.templateData, 'base64').toString('utf8')
    );

    if (decoded.key == null) return null;

    const hit = storedTemplates.find((t) => {
      const stored = JSON.parse(Buffer.from(t.templateData, 'base64').toString('utf8'));
      return stored.key === decoded.key;
    });

    if (!hit) return null;

    return { employeeId: hit.employeeId, score: 92.5 }; // mock confidence score
  }

  async disconnect() {
    return Promise.resolve();
  }
}

module.exports = { MockScanner };
