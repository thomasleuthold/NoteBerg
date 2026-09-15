/**
 * Handwriting-recognition configuration.
 *
 * Task-scoped only. Everything about *reaching* an AI service — provider,
 * endpoint, credential — lives in aiProvider.js and is shared with any other
 * AI-backed feature. What stays here is what recognition alone decides:
 *
 *   - the method (Windows Ink, or an AI vision model)
 *   - the model and, on Replicate, its version — recognition needs a *vision*
 *     model, which a summary feature would not, so the identifier is per task
 *   - the recognition prompt, image size, token cap and language hint
 *
 * The consequence worth stating: a configured provider does not mean recognition
 * can run, and recognition being set to Windows Ink does not mean the provider
 * is unconfigured. isRecognitionReady() joins the two halves.
 */

import { getSetting, setSetting } from "../storage.js";
import { getCentralSettings, getProviderConfig, isProviderConfigured } from "./aiProvider.js";

/** Recognition methods. */
export const METHOD_WINDOWS_INK = "windowsInk";
export const METHOD_AI = "ai";

/**
 * Language sentinel meaning "let the model work it out".
 *
 * The default, because a wrong language assertion is worse than none: a model
 * told the page is English will "correct" German words into English, which is
 * exactly the invention the prompt otherwise forbids.
 */
export const LANGUAGE_AUTO = "auto";

/**
 * Read the recognition configuration, joined with the active provider.
 *
 * Returns the provider fields too, flattened, because every consumer that runs a
 * recognition needs both halves and there is no useful state where it holds one
 * without the other. The split is a matter of where the values are *stored* and
 * who else may change them — not something call sites should have to reassemble.
 *
 * @returns {Promise<{
 *   method: string,
 *   provider: string,
 *   endpoint: string,
 *   apiKey: string,
 *   hasApiKey: boolean,
 *   model: string,
 *   replicateVersion: string,
 *   language: string,
 *   maxImageEdge: number,
 *   maxTokens: number,
 *   timeoutSeconds: number,
 *   systemPrompt: string,
 *   centrallyManaged: boolean,
 * }>}
 */
export async function getRecognitionConfig() {
  const provider = await getProviderConfig();
  // Nextcloud, central mode only: the administrator's task settings override
  // whatever this device holds. Layered here rather than at the call sites
  // because this is the one function every consumer reads its configuration
  // from, so a call site that missed the override would silently run under the
  // user's own model against the administrator's account.
  //
  // null on the native builds and in BYO mode, where the local values stand.
  const central = await getCentralSettings();

  return {
    // Windows Ink is the default only because it resolves locally with no
    // configuration and sends nothing anywhere. An AI method is used only when
    // explicitly chosen (DESIGN §6) — we never silently send strokes to a
    // service the user did not pick.
    //
    // Central mode is that choice, made by the administrator rather than the
    // user: they configured an AI provider for the instance, and the settings
    // screen offers no method selector because there is nothing left to pick —
    // the Windows sidecar does not exist on Nextcloud. Reading the local value
    // here left every user on the windowsInk default with no way to change it,
    // so isRecognitionReady() failed its first check and recognition reported
    // itself unconfigured while the provider and model were in fact present.
    //
    // Consent is unaffected: selectBackend() still checks it before anything is
    // sent, so an administrator cannot use this to bypass the disclosure.
    method: central ? METHOD_AI : (await getSetting("recognition_method")) || METHOD_WINDOWS_INK,

    ...provider,

    model: central ? central.model || "" : (await getSetting("recognition_model")) || "",
    // Replicate community models are addressed by version hash; official models
    // can be run by owner/name alone. Empty means "run by name".
    replicateVersion: central
      ? central.replicateVersion || ""
      : (await getSetting("recognition_replicate_version")) || "",
    language: central
      ? central.language || LANGUAGE_AUTO
      : (await getSetting("recognition_language")) || LANGUAGE_AUTO,
    // Longest edge of a rasterized band, in image pixels. The binding constraint
    // is legibility, not context size: downscaled handwriting is where VL
    // accuracy collapses (DESIGN §3.2). Measured per model in Phase 3.
    //
    // Central values are numeric, so `||` rather than `??`: the server reports 0
    // for an unset one, and a 0-pixel image or a 0-token cap is not a setting
    // anyone chose — it is the absence of one, and must fall back to the default.
    maxImageEdge: central
      ? central.maxImageEdge || 1600
      : ((await getSetting("recognition_max_image_edge")) ?? 1600),
    // Cap on the model's reply.
    //
    // Each word costs roughly 16 tokens once its box is included, so 1500 — the
    // original default — truncated at about 90 words, which a normal page
    // exceeds. Truncation is unrecoverable: the JSON cannot be parsed and the
    // whole note fails. 8000 covers ~500 words while still stopping a model that
    // loops instead of transcribing.
    maxTokens: central
      ? central.maxTokens || 8000
      : ((await getSetting("recognition_max_tokens")) ?? 8000),
    // How long to wait for one page before giving up, in seconds.
    //
    // Configurable because the range of legitimate answers is enormous: a hosted
    // model returns a page in a few seconds, a reasoning model routed through a
    // gateway can take several minutes, and a local model on CPU longer still.
    // Any fixed value is wrong for most of that range — too low fails working
    // setups, too high leaves a dead endpoint hanging.
    //
    // 120s covers hosted models comfortably, including the slow reasoning routes
    // that a 60s default cut off.
    timeoutSeconds: central
      ? central.timeoutSeconds || 120
      : ((await getSetting("recognition_timeout_seconds")) ?? 120),
    // Custom system prompt. Empty means use the built-in default, so a user who
    // never touches this keeps getting improvements to it.
    systemPrompt: central
      ? central.systemPrompt || ""
      : (await getSetting("recognition_system_prompt")) || "",
    // Whether the values above came from the administrator. Carried on the
    // config so the settings UI can render them read-only without asking a
    // second time, and so nothing downstream has to infer it.
    centrallyManaged: !!central,
  };
}

/**
 * Persist recognition configuration. Accepts a partial patch.
 *
 * Provider fields are deliberately not accepted here — they belong to
 * setProviderConfig(), so there is exactly one writer per setting.
 *
 * @param {Object} patch
 */
export async function setRecognitionConfig(patch) {
  // Deliberately does NOT consult the central-mode policy.
  //
  // A local write under central mode is already inert: getRecognitionConfig()
  // overrides the model, prompt and language from the server on every read, and
  // the server refuses a user's write outright. Filtering here as well would
  // add a network round trip to every settings save — including on the native
  // builds, which have no server to ask — to prevent a value that nothing reads.
  //
  // Writing settings is a local operation on every platform, and keeping it so
  // is what stops a save from failing when the server is briefly unreachable.
  const map = {
    method: "recognition_method",
    model: "recognition_model",
    replicateVersion: "recognition_replicate_version",
    language: "recognition_language",
    maxImageEdge: "recognition_max_image_edge",
    maxTokens: "recognition_max_tokens",
    timeoutSeconds: "recognition_timeout_seconds",
    systemPrompt: "recognition_system_prompt",
  };

  for (const [field, key] of Object.entries(map)) {
    if (patch[field] === undefined) continue;
    await setSetting(key, patch[field]);
  }
}

/**
 * Whether AI recognition has everything it needs to run.
 *
 * Both halves must hold: a reachable provider (aiProvider's business) and a
 * vision model to run on it (recognition's). Either missing is treated as
 * unconfigured rather than broken — recognition silently no-ops, exactly as a
 * missing sidecar does.
 *
 * @param {Object} config - from getRecognitionConfig()
 * @returns {boolean}
 */
export function isRecognitionReady(config) {
  if (!config || config.method !== METHOD_AI) return false;
  return isProviderConfigured(config) && !!config.model;
}

/** Whether the configured method routes through an AI provider. */
export function isAiMethod(method) {
  return method === METHOD_AI;
}
