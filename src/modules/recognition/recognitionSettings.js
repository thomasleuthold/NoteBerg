/**
 * Recognition backend configuration.
 *
 * Deliberately a thin layer over the existing key-value settings store: no UI
 * is required to configure a backend, so development and measurement (PLAN
 * Phase 3) are not blocked on the settings screen (PLAN Phase 5). Phase 5
 * builds a UI over these same keys — it adds discoverability, consent and
 * validation, not capability.
 *
 * The API key is the exception: it goes through secureStorage from the start,
 * so the settings UI later becomes a form over working storage rather than a
 * storage migration.
 */

import { getSecureCredential, saveSecureCredential } from "../secureStorage.js";
import { getSetting, setSetting } from "../storage.js";

/** Backend identifiers. */
export const BACKEND_SIDECAR = "sidecar";
export const BACKEND_OPENAI = "openai";
export const BACKEND_REPLICATE = "replicate";

/** Secure-storage key for the API key. Never stored via setSetting(). */
const API_KEY_CREDENTIAL = "recognition_api_key";

/**
 * Read the active recognition configuration.
 *
 * No backend is enabled by default on any platform: the sidecar is selected
 * automatically only because it resolves locally with no configuration and
 * sends nothing anywhere. An AI backend is used only when explicitly chosen
 * (DESIGN §6) — we never silently send strokes to an endpoint the user did not
 * pick.
 *
 * @returns {Promise<{
 *   backend: string,
 *   endpoint: string,
 *   model: string,
 *   apiKey: string,
 *   language: string,
 *   maxImageEdge: number,
 *   maxTokens: number,
 *   replicateVersion: string,
 *   systemPrompt: string,
 * }>}
 */
export async function getRecognitionConfig() {
  const backend = (await getSetting("recognition_backend")) || BACKEND_SIDECAR;
  return {
    backend,
    endpoint: (await getSetting("recognition_endpoint")) || "",
    model: (await getSetting("recognition_model")) || "",
    apiKey: (await getApiKey()) || "",
    language: (await getSetting("recognition_language")) || "en-US",
    // Longest edge of a rasterized band, in image pixels. The binding
    // constraint is legibility, not context size: downscaled handwriting is
    // where VL accuracy collapses (DESIGN §3.2). Measured per model in Phase 3.
    maxImageEdge: (await getSetting("recognition_max_image_edge")) ?? 1600,
    // Cap on the model's reply.
    //
    // Each word costs roughly 16 tokens once its box is included, so 1500 —
    // the original default — truncated at about 90 words, which a normal page
    // exceeds. Truncation is unrecoverable: the JSON cannot be parsed and the
    // whole note fails. 8000 covers ~500 words while still stopping a model
    // that loops instead of transcribing.
    maxTokens: (await getSetting("recognition_max_tokens")) ?? 8000,
    // Replicate community models are addressed by version hash; official models
    // can be run by owner/name alone. Empty means "run by name".
    replicateVersion: (await getSetting("recognition_replicate_version")) || "",
    // Custom system prompt. Empty means use the built-in default, so a user who
    // never touches this keeps getting improvements to it.
    systemPrompt: (await getSetting("recognition_system_prompt")) || "",
  };
}

/**
 * Persist backend configuration. Accepts a partial patch.
 * The API key is routed to secure storage, never to the plain settings store.
 *
 * @param {Object} patch
 */
export async function setRecognitionConfig(patch) {
  const map = {
    backend: "recognition_backend",
    endpoint: "recognition_endpoint",
    model: "recognition_model",
    language: "recognition_language",
    maxImageEdge: "recognition_max_image_edge",
    maxTokens: "recognition_max_tokens",
    replicateVersion: "recognition_replicate_version",
    systemPrompt: "recognition_system_prompt",
  };

  for (const [field, key] of Object.entries(map)) {
    if (patch[field] !== undefined) await setSetting(key, patch[field]);
  }

  if (patch.apiKey !== undefined) {
    await saveSecureCredential(API_KEY_CREDENTIAL, patch.apiKey);
  }
}

/** Read the stored API key, or "" when none is set. */
export async function getApiKey() {
  try {
    return (await getSecureCredential(API_KEY_CREDENTIAL)) || "";
  } catch (_e) {
    // Secure storage unavailable (e.g. locked, or not supported on platform)
    return "";
  }
}

/**
 * Whether an AI backend has enough configuration to be attempted.
 * A backend missing its configuration is treated as unconfigured rather than
 * broken: recognition silently no-ops, exactly as a missing sidecar does today.
 *
 * Requirements differ by provider — Replicate has a fixed host and authenticates
 * with a token, so it needs no endpoint URL but cannot run without the token.
 *
 * @param {Object} config - from getRecognitionConfig()
 * @returns {boolean}
 */
export function isAiConfigured(config) {
  if (config.backend === BACKEND_OPENAI) {
    return !!config.endpoint && !!config.model;
  }
  if (config.backend === BACKEND_REPLICATE) {
    return !!config.model && !!config.apiKey;
  }
  return false;
}

/** Whether a backend id is one of the AI providers. */
export function isAiBackend(backend) {
  return backend === BACKEND_OPENAI || backend === BACKEND_REPLICATE;
}
