/**
 * SecuGenScanner — reference adapter, NOT tested against real hardware.
 *
 * Included to show the actual integration pattern once you pick hardware:
 * most fingerprint vendors (SecuGen, and several others that copy this
 * model) ship a small local Windows service/daemon that exposes their SDK
 * over HTTP on localhost — because their SDKs are native C/C++ and this
 * lets any language talk to them without writing a native Node addon.
 *
 * SecuGen's is called "SGIBioSrv" / WebAPI, typically at
 * https://localhost:8443 once their driver + service is installed.
 *
 * To make this real:
 *   1. Install SecuGen's runtime + WebAPI service on the machine with the scanner.
 *   2. Confirm the exact endpoint/port/payload shape in their current SDK docs
 *      (these details change between SDK versions — don't trust this from memory).
 *   3. Replace the fetch calls below with the real endpoints.
 *   4. Swap SCANNER_DRIVER=secugen in your environment config.
 *
 * Nothing else in the app needs to change — that's the payoff of the
 * IFingerprintScanner abstraction.
 */
class SecuGenScanner {
  constructor(baseUrl = 'https://localhost:8443') {
    this.baseUrl = baseUrl;
  }

  async initialize() {
    // e.g. GET `${this.baseUrl}/SGIBioSrv/GetDeviceInfo` and confirm a device
    // is attached, throw a clear error if not.
    throw new Error(
      'SecuGenScanner is a reference stub — wire this up to your installed SDK/service before use.'
    );
  }

  async capture() {
    // e.g. GET `${this.baseUrl}/SGIBioSrv/GetTemplateEx?...`
    // returns a base64 template + quality score.
    throw new Error('Not implemented — see class comment.');
  }

  async matchAgainstStored(capturedTemplate, storedTemplates) {
    // Prefer the SDK's own match/verify call over comparing templates
    // yourself — vendor SDKs implement the actual biometric matching
    // algorithm (minutiae comparison, etc.); you should never try to
    // reimplement that.
    throw new Error('Not implemented — see class comment.');
  }

  async disconnect() {
    throw new Error('Not implemented — see class comment.');
  }
}

module.exports = { SecuGenScanner };
