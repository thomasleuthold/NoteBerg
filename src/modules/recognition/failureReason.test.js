/**
 * Covers the failure classifier behind the job list's short reason.
 *
 * The messages here are the ones the backends and the Nextcloud proxy actually
 * throw, copied from their throw sites rather than invented — a classifier
 * tested against paraphrases of its own regexes would pass while failing on
 * every real error.
 */

import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  REASON_ALLOWANCE,
  REASON_AUTH,
  REASON_BACKEND_CHANGED,
  REASON_BAD_RESPONSE,
  REASON_QUOTA,
  REASON_STALE,
  REASON_TIMEOUT,
  REASON_UNKNOWN,
  REASON_UNREACHABLE,
} from "./failureReason.js";

describe("classifyFailure", () => {
  it("reads the queue's own staleness marker", () => {
    expect(classifyFailure("stale")).toBe(REASON_STALE);
  });

  it("classifies the client-side timeout", () => {
    // openAiBackend.js, when its own AbortController fires.
    expect(
      classifyFailure(
        "The model did not respond within 120 seconds. Raise Recognition timeout, or use a faster model.",
      ),
    ).toBe(REASON_TIMEOUT);
  });

  it("classifies the Nextcloud proxy's timeout, which arrives as a 502", () => {
    // The reported failure. This must not read as "unreachable": the remedies
    // are opposite — raise the timeout, versus go and fix the address.
    expect(
      classifyFailure(
        'Recognition proxy returned 502: {"error":"The recognition endpoint did not respond within 55 seconds. Raise Recognition timeout, use a faster model, or reduce Max image size."}',
      ),
    ).toBe(REASON_TIMEOUT);
  });

  it("classifies an unreachable endpoint", () => {
    expect(
      classifyFailure(
        'Recognition proxy returned 502: {"error":"Could not reach the recognition endpoint."}',
      ),
    ).toBe(REASON_UNREACHABLE);
  });

  it("classifies a browser-level network failure", () => {
    // What a dead endpoint looks like on the native builds, where there is no
    // proxy to turn it into a status code.
    expect(classifyFailure("TypeError: NetworkError when attempting to fetch resource.")).toBe(
      REASON_UNREACHABLE,
    );
  });

  it("classifies a rejected credential", () => {
    expect(classifyFailure("Recognition API returned 401: Invalid API key")).toBe(REASON_AUTH);
    expect(classifyFailure("Replicate requires an API token. Add it in settings.")).toBe(
      REASON_AUTH,
    );
  });

  it("classifies quota and rate limiting", () => {
    expect(classifyFailure("Recognition API returned 429: rate limit exceeded")).toBe(REASON_QUOTA);
    expect(classifyFailure("Recognition API returned 402: insufficient credits")).toBe(
      REASON_QUOTA,
    );
  });

  it("classifies a model that answered but not usably", () => {
    expect(classifyFailure("Model did not return the expected JSON. It replied: sure!")).toBe(
      REASON_BAD_RESPONSE,
    );
    expect(
      classifyFailure("Recognition endpoint returned no message content (finish_reason: stop)."),
    ).toBe(REASON_BAD_RESPONSE);
    expect(classifyFailure("Model declined to transcribe the image: policy")).toBe(
      REASON_BAD_RESPONSE,
    );
  });

  it("admits when it does not know rather than guessing", () => {
    // A wrong category is worse than none: it sends the user to fix something
    // that is not broken.
    expect(classifyFailure("Something entirely unexpected happened")).toBe(REASON_UNKNOWN);
    expect(classifyFailure("failed")).toBe(REASON_UNKNOWN);
  });

  it("treats a missing error as unknown rather than throwing", () => {
    // job.error is null on a job that has not failed, and the renderer must not
    // crash the whole list on one odd row.
    expect(classifyFailure(null)).toBe(REASON_UNKNOWN);
    expect(classifyFailure(undefined)).toBe(REASON_UNKNOWN);
    expect(classifyFailure("")).toBe(REASON_UNKNOWN);
  });

  it("does not mistake a stale marker inside a longer message", () => {
    // "stale" is the queue's exact marker, not a substring to hunt for: a
    // provider message mentioning stale data is a different failure.
    expect(classifyFailure("Recognition API returned 400: stale request signature")).not.toBe(
      REASON_STALE,
    );
  });
});

describe("queue-set reasons", () => {
  it("classifies a backend mismatch as its own reason", () => {
    // Set by the queue rather than thrown by a backend, so it is an exact
    // match — and must not fall through to the generic "Failed" line.
    expect(classifyFailure("backend-changed")).toBe(REASON_BACKEND_CHANGED);
  });
});

describe("the instance's own allowance", () => {
  it("is distinguished from a provider's rate limit", () => {
    // Both arrive as a 429, but the remedies are opposite: one is the
    // administrator's monthly cap, the other is the provider's throttle. A user
    // told to check their provider account when the app itself refused would
    // look everywhere except at the setting that stopped them.
    const ours =
      "Your monthly recognition allowance is used up. It resets at the start of next month, " +
      "or your Nextcloud administrator can raise it.";
    expect(classifyFailure(ours)).toBe(REASON_ALLOWANCE);
  });

  it("leaves a genuine provider rate limit classified as quota", () => {
    expect(classifyFailure("Recognition API returned 429: rate limit exceeded")).toBe(REASON_QUOTA);
  });
});
