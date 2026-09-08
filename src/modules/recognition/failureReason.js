/**
 * Classify a failed job's error into a short, translatable reason.
 *
 * The queue stores whatever message the backend threw (recognitionQueue.fail),
 * which is the right thing to keep — it names the setting to change and is what
 * a bug report needs. But it is a sentence, sometimes a paragraph with a
 * provider's JSON in it, and the job list has one short line per row. Rendering
 * it there produced a wall of text in which every failure looked alike.
 *
 * So the list shows a category and keeps the full message as the row's tooltip:
 * the reason is what tells a user whether to wait, check a setting, or look at
 * the network, and those are the only actions the list can prompt.
 *
 * Matched on message text because that is what there is. The backends throw
 * plain Errors with no code, and giving every throw site a typed error would
 * touch far more of the pipeline than the job list is worth. The matching is
 * therefore deliberately loose and ordered most-specific-first, with UNKNOWN as
 * the honest answer rather than a guess.
 */

/** The note changed after the job was queued, so its ink no longer matches. */
export const REASON_STALE = "stale";
/** The provider or model changed after the job was queued. */
export const REASON_BACKEND_CHANGED = "backendChanged";
/** The instance's own monthly allowance is spent (Nextcloud, admin-set). */
export const REASON_ALLOWANCE = "allowance";
/** The model did not answer within the configured timeout. */
export const REASON_TIMEOUT = "timeout";
/** Nothing answered at the configured address. */
export const REASON_UNREACHABLE = "unreachable";
/** The endpoint answered, but rejected the credential. */
export const REASON_AUTH = "auth";
/** The provider refused the request — quota, rate limit, or billing. */
export const REASON_QUOTA = "quota";
/** The model replied, but not with anything that could be parsed as words. */
export const REASON_BAD_RESPONSE = "badResponse";
/** Classified as nothing more specific. */
export const REASON_UNKNOWN = "unknown";

/**
 * Reduce a stored job error to one of the REASON_* constants.
 *
 * @param {string|null|undefined} error - `job.error`, a raw backend message
 * @returns {string} a REASON_* constant
 */
export function classifyFailure(error) {
  if (!error) return REASON_UNKNOWN;
  const text = String(error).toLowerCase();

  // Set by the queue itself rather than by a backend, so these are exact matches
  // and are checked first — they are the reasons that are not transport faults.
  if (text === "stale") return REASON_STALE;
  if (text === "backend-changed") return REASON_BACKEND_CHANGED;

  // This app's own allowance, not the provider's. Checked before the generic
  // quota rules below, which match on "429" and would otherwise classify it as
  // a provider rate limit — sending the user to look at an account that is
  // working perfectly well.
  if (text.includes("monthly recognition allowance")) return REASON_ALLOWANCE;

  // Before the generic status checks: a timeout arrives both as the client's
  // own message and as the Nextcloud proxy's 502, and the 502 would otherwise
  // be read as an unreachable endpoint. The distinction matters because the
  // remedies are opposite — raise the timeout, versus fix the address.
  if (
    text.includes("did not respond within") ||
    text.includes("timed out") ||
    text.includes("timeout")
  ) {
    return REASON_TIMEOUT;
  }

  if (text.includes("could not reach") || text.includes("networkerror")) {
    return REASON_UNREACHABLE;
  }

  // 401/402/403 and the phrasings providers wrap them in.
  if (
    text.includes("returned 401") ||
    text.includes("returned 403") ||
    text.includes("unauthorized") ||
    text.includes("invalid api key") ||
    text.includes("requires an api token")
  ) {
    return REASON_AUTH;
  }

  if (
    text.includes("returned 402") ||
    text.includes("returned 429") ||
    text.includes("rate limit") ||
    text.includes("quota") ||
    text.includes("insufficient")
  ) {
    return REASON_QUOTA;
  }

  // Everything the model got wrong once it did answer: an unparseable reply, a
  // truncated one, an empty one, or a refusal.
  if (
    text.includes("did not return the expected json") ||
    text.includes("did not return json") ||
    text.includes("no message content") ||
    text.includes("declined to transcribe") ||
    text.includes("token output limit")
  ) {
    return REASON_BAD_RESPONSE;
  }

  return REASON_UNKNOWN;
}
