/**
 * Covers the destination check that confines recognition requests to the
 * user's configured endpoint. The Tauri allowlist permits any https host and
 * any localhost port (DESIGN §8), so this is the check that actually matters —
 * these tests assert it cannot be bypassed by the usual URL tricks.
 */

import { describe, expect, it } from "vitest";
import {
  assertAllowedDestination,
  isAllowedDestination,
  normalizeEndpoint,
  validateEndpoint,
} from "./endpointValidation.js";

describe("validateEndpoint", () => {
  it("accepts https endpoints", () => {
    expect(validateEndpoint("https://api.openai.com/v1").valid).toBe(true);
  });

  it("accepts plain http on loopback, where nothing crosses a network", () => {
    expect(validateEndpoint("http://localhost:1234/v1").valid).toBe(true);
    expect(validateEndpoint("http://127.0.0.1:11434/v1").valid).toBe(true);
  });

  it("rejects plain http to a remote host, which would expose ink and the API key", () => {
    const result = validateEndpoint("http://ai.example.com/v1");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("insecure-remote");
  });

  it("rejects non-http protocols", () => {
    expect(validateEndpoint("file:///etc/passwd").valid).toBe(false);
    expect(validateEndpoint("ftp://example.com/v1").valid).toBe(false);
  });

  it("rejects values that are not URLs at all", () => {
    expect(validateEndpoint("").valid).toBe(false);
    expect(validateEndpoint("not a url").valid).toBe(false);
    expect(validateEndpoint(null).valid).toBe(false);
  });
});

describe("isAllowedDestination", () => {
  const endpoint = "https://api.openai.com/v1";

  it("allows the endpoint itself and paths beneath it", () => {
    expect(isAllowedDestination("https://api.openai.com/v1", endpoint)).toBe(true);
    expect(isAllowedDestination("https://api.openai.com/v1/chat/completions", endpoint)).toBe(true);
  });

  it("refuses a different host", () => {
    expect(isAllowedDestination("https://evil.example.com/v1/chat/completions", endpoint)).toBe(
      false,
    );
  });

  it("refuses a different port on the same host", () => {
    expect(isAllowedDestination("https://api.openai.com:8443/v1", endpoint)).toBe(false);
  });

  it("refuses a protocol downgrade", () => {
    expect(isAllowedDestination("http://api.openai.com/v1", endpoint)).toBe(false);
  });

  it("refuses a sibling path that merely shares a prefix", () => {
    // "/v1-evil" starts with "/v1" as a string but is not beneath it.
    expect(isAllowedDestination("https://api.openai.com/v1-evil/chat", endpoint)).toBe(false);
  });

  it("refuses a foreign URL that embeds the endpoint in its query", () => {
    expect(
      isAllowedDestination(`https://evil.example.com/?target=${endpoint}/chat`, endpoint),
    ).toBe(false);
  });

  it("refuses userinfo tricks that look like the configured host", () => {
    expect(isAllowedDestination("https://api.openai.com@evil.example.com/v1/chat", endpoint)).toBe(
      false,
    );
  });

  it("treats a trailing slash on the endpoint as equivalent", () => {
    expect(
      isAllowedDestination("https://api.openai.com/v1/chat", "https://api.openai.com/v1/"),
    ).toBe(true);
  });

  it("allows any path when the endpoint has no path component", () => {
    expect(isAllowedDestination("http://localhost:1234/v1/chat", "http://localhost:1234")).toBe(
      true,
    );
  });

  it("refuses when the configured endpoint is itself invalid", () => {
    // An insecure remote endpoint must not become reachable just because the
    // request URL happens to match it.
    expect(isAllowedDestination("http://ai.example.com/v1/chat", "http://ai.example.com/v1")).toBe(
      false,
    );
  });
});

describe("assertAllowedDestination", () => {
  it("throws loudly rather than returning false, so a call site cannot ignore it", () => {
    expect(() =>
      assertAllowedDestination("https://evil.example.com/v1", "https://api.openai.com/v1"),
    ).toThrow(/Refusing to send/);
  });

  it("does not throw for a permitted destination", () => {
    expect(() =>
      assertAllowedDestination("https://api.openai.com/v1/chat", "https://api.openai.com/v1"),
    ).not.toThrow();
  });
});

describe("normalizeEndpoint", () => {
  it("adds the missing version segment to a bare server root", () => {
    // The concrete bug this fixes: LM Studio serves /v1/chat/completions, and a
    // stored "http://localhost:1234" produced a POST to /chat/completions,
    // which the server answered 200 with a non-JSON body.
    expect(normalizeEndpoint("http://localhost:1234")).toBe("http://localhost:1234/v1");
  });

  it("leaves a correct base URL untouched", () => {
    expect(normalizeEndpoint("http://localhost:1234/v1")).toBe("http://localhost:1234/v1");
  });

  it("strips a trailing slash", () => {
    expect(normalizeEndpoint("http://localhost:1234/v1/")).toBe("http://localhost:1234/v1");
  });

  it("strips a full route the user pasted from the server's own log", () => {
    expect(normalizeEndpoint("http://localhost:1234/v1/chat/completions")).toBe(
      "http://localhost:1234/v1",
    );
  });

  it("preserves a non-default path rather than forcing /v1 onto it", () => {
    // Reverse proxies mount OpenAI-compatible APIs under arbitrary prefixes.
    expect(normalizeEndpoint("https://gw.example.com/openai/v1")).toBe(
      "https://gw.example.com/openai/v1",
    );
  });

  it("drops a query string and fragment, which are not part of a base URL", () => {
    expect(normalizeEndpoint("http://localhost:1234/v1?x=1#frag")).toBe("http://localhost:1234/v1");
  });

  it("returns unparseable input unchanged, leaving rejection to validateEndpoint", () => {
    expect(normalizeEndpoint("not a url")).toBe("not a url");
  });

  it("produces a value that then passes the destination check", () => {
    const normalized = normalizeEndpoint("http://localhost:1234");
    expect(isAllowedDestination(`${normalized}/chat/completions`, normalized)).toBe(true);
  });
});
