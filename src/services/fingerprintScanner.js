/**
 * IFingerprintScanner — the contract every scanner adapter must implement.
 *
 * This is the whole point of the abstraction: nothing outside this file's
 * adapters/ folder should ever know which vendor SDK is in play. Services
 * and UI code only ever talk to "a scanner" that satisfies this shape.
 *
 * Methods:
 *   initialize()                 -> Promise<void>
 *     Set up the connection to the device/local SDK service. Called once at
 *     app startup.
 *
 *   capture()                    -> Promise<{ templateData: string, quality: number }>
 *     Ask the device to read a finger placed on it right now and return an
 *     encoded template (base64 string) + a 0-100 quality score. Used both
 *     during enrollment and during a live attendance scan.
 *
 *   matchAgainstStored(capturedTemplate, storedTemplates)
 *                                 -> Promise<{ employeeId: number, score: number } | null>
 *     Compare a freshly captured template against a list of
 *     { employeeId, templateData } records and return the best match above
 *     a confidence threshold, or null if nobody matches. Real SDKs usually
 *     provide a native "match" or "verify" function — you should call THAT
 *     rather than reimplementing biometric matching yourself.
 *
 *   disconnect()                 -> Promise<void>
 */

const { MockScanner } = require('./adapters/mockScanner');
const { SecuGenScanner } = require('./adapters/secugenScanner');

/**
 * Factory: pick the adapter based on config. This is the ONLY place in the
 * app that should know adapter class names — everywhere else just receives
 * "a scanner" back.
 */
function createScanner(driverName = process.env.SCANNER_DRIVER || 'mock') {
  switch (driverName) {
    case 'mock':
      return new MockScanner();
    case 'secugen':
      return new SecuGenScanner();
    // case 'zkteco':
    //   return new ZkTecoScanner();   // add when hardware is chosen
    default:
      throw new Error(`Unknown scanner driver: ${driverName}`);
  }
}

module.exports = { createScanner };
