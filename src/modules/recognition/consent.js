/**
 * Consent for sending handwriting to a recognition backend.
 *
 * Privacy-first is a product pillar, and sending handwriting to a third party is
 * in direct tension with it. The resolution is informed, explicit, per-host
 * consent — never a default, and never implied by having configured a backend
 * (DESIGN §6).
 *
 * Consent is recorded against the destination *host* rather than a flag, so
 * pointing recognition at somewhere new asks again: agreeing to send ink to a
 * model on your own machine is not agreement to send it to a cloud API.
 *
 * Loopback destinations need no consent. Nothing leaves the device, so there is
 * no disclosure to make, and prompting for one would train users to dismiss the
 * dialog that matters.
 */

import { getSetting, setSetting } from "../storage.js";
import { REPLICATE_HOST } from "./backends/replicateBackend.js";
import { BACKEND_REPLICATE } from "./recognitionSettings.js";

/** Hosts that never leave the device, so never need consent. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Setting key holding the host the user last consented to. */
const CONSENT_KEY = "recognition_consent_host";

/**
 * The host handwriting would be sent to, or null when it stays on the device.
 *
 * @param {Object} config - from getRecognitionConfig()
 * @returns {string|null} hostname, or null for a local or unconfigured backend
 */
export function destinationHost(config) {
  // Replicate has a fixed host and is always remote; there is no local variant.
  if (config?.backend === BACKEND_REPLICATE) return REPLICATE_HOST;

  try {
    const { hostname } = new URL(config?.endpoint);
    return LOCAL_HOSTS.has(hostname) ? null : hostname;
  } catch (_e) {
    // Not a usable endpoint: nothing can be sent, so there is nothing to consent to.
    return null;
  }
}

/**
 * Whether handwriting may be sent under the current configuration.
 *
 * @param {Object} config - from getRecognitionConfig()
 * @returns {Promise<boolean>}
 */
export async function hasConsent(config) {
  const host = destinationHost(config);
  if (host === null) return true;
  return (await getSetting(CONSENT_KEY)) === host;
}

/**
 * Record consent for the current destination.
 *
 * @param {Object} config - from getRecognitionConfig()
 */
export async function grantConsent(config) {
  const host = destinationHost(config);
  if (host !== null) await setSetting(CONSENT_KEY, host);
}

/** Forget any recorded consent, so the next remote run asks again. */
export async function revokeConsent() {
  await setSetting(CONSENT_KEY, "");
}
