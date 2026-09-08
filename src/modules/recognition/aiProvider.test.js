/**
 * Covers where AI provider configuration lives, which on Nextcloud is a
 * security property rather than a storage detail.
 *
 * The NC build has no secure browser storage — the fallback in secureStorage.js
 * encrypts with a constant compiled into the shipped bundle — so a provider
 * token kept there is readable by anything that can reach the origin's storage,
 * including an XSS in a different Nextcloud app. The endpoint is server-side for
 * a different reason: requests are issued by the Nextcloud server through the
 * proxy, so the URL must resolve in the server's frame of reference, not the
 * browser's.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let settings = {};
let credentials = {};

vi.mock("../storage.js", () => ({
  getSetting: async (key) => settings[key] ?? null,
  setSetting: async (key, value) => {
    settings[key] = value;
  },
}));

vi.mock("../secureStorage.js", () => ({
  getSecureCredential: async (key) => credentials[key] ?? null,
  saveSecureCredential: async (key, value) => {
    credentials[key] = value;
  },
  deleteSecureCredential: async (key) => {
    delete credentials[key];
  },
}));

let fetchMock;

/** Load the module as one of the two builds. */
async function load({ nextcloud = false } = {}) {
  vi.resetModules();
  vi.stubEnv("VITE_PLATFORM", nextcloud ? "nextcloud" : "tauri");
  return import("./aiProvider.js");
}

/** What the server reports for this user. */
function serverSays(config) {
  fetchMock.mockImplementation(async (_url, init) => ({
    ok: true,
    json: async () => (init?.method === "POST" ? { ...config, ...lastPosted() } : config),
  }));
}

function lastPosted() {
  const post = fetchMock.mock.calls.find(([, i]) => i?.method === "POST");
  return post ? JSON.parse(post[1].body) : {};
}

beforeEach(() => {
  settings = {};
  credentials = {};
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  globalThis.window = globalThis.window || {};
  window.OC = { requestToken: "tok", generateUrl: (p) => `/nc${p}` };
  serverSays({ provider: "", endpoint: "", hasApiKey: false });
});

describe("Nextcloud: provider configuration lives on the server", () => {
  it("reads the endpoint from the server, not from local storage", async () => {
    // A stale local copy must never win: it would point the server at a URL
    // resolved in the wrong frame of reference.
    settings.ai_endpoint = "http://stale.local/v1";
    serverSays({
      provider: "openai",
      endpoint: "https://vision.example.com/v1",
      hasApiKey: true,
    });

    const { getProviderConfig } = await load({ nextcloud: true });
    const config = await getProviderConfig();

    expect(config.endpoint).toBe("https://vision.example.com/v1");
    expect(config.provider).toBe("openai");
  });

  it("never exposes the API key to the browser", async () => {
    // The whole point of moving it: an XSS on the Nextcloud origin must not be
    // able to recover the token, so it is never sent here at all.
    serverSays({ provider: "replicate", endpoint: "", hasApiKey: true });

    const { getProviderConfig } = await load({ nextcloud: true });
    const config = await getProviderConfig();

    expect(config.apiKey).toBe("");
    expect(config.hasApiKey).toBe(true);
  });

  it("treats a server-held key as configured", async () => {
    // isProviderConfigured cannot check the value, so it must accept its
    // existence — otherwise recognition silently no-ops on a correct NC setup.
    serverSays({ provider: "replicate", endpoint: "", hasApiKey: true });

    const { getProviderConfig, isProviderConfigured } = await load({ nextcloud: true });

    expect(isProviderConfigured(await getProviderConfig())).toBe(true);
  });

  it("posts the API key to the server instead of storing it locally", async () => {
    const { setProviderConfig } = await load({ nextcloud: true });
    await setProviderConfig({ provider: "openai", apiKey: "sk-secret" });

    expect(lastPosted().api_key).toBe("sk-secret");
    // Not in either browser store.
    expect(credentials.ai_api_key).toBeUndefined();
    expect(JSON.stringify(settings)).not.toContain("sk-secret");
  });

  it("does not write server-side fields to local storage", async () => {
    // Two copies would drift, and the local one wins on read in the native
    // path — so a later refactor could silently resurrect the wrong value.
    const { setProviderConfig } = await load({ nextcloud: true });
    await setProviderConfig({ provider: "openai", endpoint: "https://x.example.com/v1" });

    expect(settings.ai_endpoint).toBeUndefined();
    expect(settings.ai_provider).toBeUndefined();
  });

  it("supplies Replicate's fixed endpoint, which the user never types", async () => {
    // The endpoint field is hidden for Replicate, but the proxy resolves every
    // request against a stored endpoint — without this the two disagree and
    // nothing works.
    const { setProviderConfig } = await load({ nextcloud: true });
    await setProviderConfig({ provider: "replicate" });

    expect(lastPosted().endpoint).toContain("api.replicate.com");
  });

  it("treats an unreachable server as unconfigured rather than failing", async () => {
    // AI features should no-op exactly as they do with nothing set up.
    fetchMock.mockRejectedValue(new Error("network"));

    const { getProviderConfig, isProviderConfigured } = await load({ nextcloud: true });

    expect(isProviderConfigured(await getProviderConfig())).toBe(false);
  });
});

describe("native builds", () => {
  it("reads the provider and endpoint from local storage", async () => {
    settings.ai_provider = "openai";
    settings.ai_endpoint = "http://localhost:1234/v1";

    const { getProviderConfig } = await load();
    const config = await getProviderConfig();

    expect(config.endpoint).toBe("http://localhost:1234/v1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the API key in secure storage, where the OS protects it", async () => {
    settings.ai_provider = "replicate";
    credentials["ai_api_key:replicate"] = "r8_token";

    const { getProviderConfig } = await load();
    const config = await getProviderConfig();

    expect(config.apiKey).toBe("r8_token");
    expect(config.hasApiKey).toBe(true);
  });

  it("saves the API key through secure storage, not to the server", async () => {
    const { setProviderConfig } = await load();
    await setProviderConfig({ provider: "replicate", apiKey: "r8_new" });

    expect(credentials["ai_api_key:replicate"]).toBe("r8_new");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never hands one provider the credential belonging to another", async () => {
    // The failure this prevents: a Replicate token was configured, the user
    // switched to an OpenAI-compatible endpoint, and the r8_... token was sent
    // there — the endpoint rejecting a credential the user never entered for it.
    // The key field is blank whether or not a key is stored, so nothing on
    // screen revealed the carry-over.
    settings.ai_provider = "openai";
    settings.ai_endpoint = "https://openrouter.ai/api/v1";
    credentials["ai_api_key:replicate"] = "r8_token";

    const { getProviderConfig } = await load();
    const config = await getProviderConfig();

    expect(config.apiKey).toBe("");
    expect(config.hasApiKey).toBe(false);
  });

  it("keeps both providers' keys usable across a switch", async () => {
    // Deleting the outgoing provider's key on switch would also stop the
    // carry-over, but destroys a working credential for a user comparing the
    // two. Separate slots mean switching back finds the key still there.
    settings.ai_provider = "openai";
    credentials["ai_api_key:replicate"] = "r8_token";
    credentials["ai_api_key:openai"] = "sk-or-v1-token";

    const { getProviderConfig } = await load();
    expect((await getProviderConfig()).apiKey).toBe("sk-or-v1-token");

    settings.ai_provider = "replicate";
    const { getProviderConfig: afterSwitch } = await load();
    expect((await afterSwitch()).apiKey).toBe("r8_token");
  });

  it("files a key under the provider the same save establishes", async () => {
    // A save that switches provider and sets a key in one step must store the
    // key against the provider it was typed for, not the outgoing one.
    settings.ai_provider = "replicate";

    const { setProviderConfig } = await load();
    await setProviderConfig({ provider: "openai", apiKey: "sk-or-v1-new" });

    expect(credentials["ai_api_key:openai"]).toBe("sk-or-v1-new");
    expect(credentials["ai_api_key:replicate"]).toBeUndefined();
  });
});

describe("the administrator's endpoint allowlist", () => {
  it("reports the endpoints the server permits", async () => {
    serverSays({
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      hasApiKey: true,
      allowedEndpoints: ["https://api.openai.com/v1", "http://model.lan:8080"],
    });
    const { getAllowedEndpoints } = await load({ nextcloud: true });

    expect(await getAllowedEndpoints()).toEqual([
      "https://api.openai.com/v1",
      "http://model.lan:8080",
    ]);
  });

  it("treats an empty list as permitting nothing", async () => {
    // Deny by default. The settings UI reads this to disable the endpoint
    // field and say so, rather than showing an empty dropdown that looks broken.
    serverSays({ provider: "", endpoint: "", hasApiKey: false, allowedEndpoints: [] });
    const { getAllowedEndpoints } = await load({ nextcloud: true });

    expect(await getAllowedEndpoints()).toEqual([]);
  });

  it("denies rather than assumes when the server does not report a list at all", async () => {
    // A server predating the allowlist. Inferring "unrestricted" from a missing
    // field would fail open on a version mismatch — the one direction a security
    // control must never fail.
    serverSays({ provider: "openai", endpoint: "https://api.openai.com/v1", hasApiKey: true });
    const { getAllowedEndpoints } = await load({ nextcloud: true });

    expect(await getAllowedEndpoints()).toEqual([]);
  });

  it("reports whether the built-in Replicate provider is permitted", async () => {
    serverSays({ provider: "", endpoint: "", hasApiKey: false, allowReplicate: true });
    const { isReplicateAllowed } = await load({ nextcloud: true });

    expect(await isReplicateAllowed()).toBe(true);
  });

  it("denies Replicate by default and when the server does not report the switch", async () => {
    // Replicate is a fixed host the app supplies, not a URL a user typed, so the
    // administrator's decision is a switch rather than a list entry. It denies
    // by default like the list, and a server predating it is treated as denying
    // — never as permitting.
    serverSays({ provider: "", endpoint: "", hasApiKey: false });
    const { isReplicateAllowed } = await load({ nextcloud: true });

    expect(await isReplicateAllowed()).toBe(false);
  });

  it("permits Replicate on the native builds, which have no administrator", async () => {
    const { isReplicateAllowed } = await load({ nextcloud: false });

    expect(await isReplicateAllowed()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is empty on the native builds, which have no administrator", async () => {
    // Not a denial: the native builds check destinations client-side
    // (endpointValidation.js) and render a free text field. Callers branch on
    // the build, so this empty array is never read as "nothing is allowed".
    const { getAllowedEndpoints } = await load({ nextcloud: false });

    expect(await getAllowedEndpoints()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports what the account has spent and what it is allowed", async () => {
    // Read in both modes: usage is a fact about what the account did, and a cap
    // is equally meaningful against a user's own provider account. The numbers
    // are what let a refusal be explained as an allowance rather than shown as
    // an unexplained failure.
    serverSays({
      provider: "openai",
      endpoint: "https://ai.example.com/v1",
      hasApiKey: true,
      quota: { used: 12, limit: 50, period: "2026-09" },
    });
    const { getQuota } = await load({ nextcloud: true });

    expect(await getQuota()).toEqual({ used: 12, limit: 50, period: "2026-09" });
  });

  it("reports an unlimited allowance as a zero cap, not as an absent one", async () => {
    // 0 means unlimited, matching AiPolicy::LIMIT_UNLIMITED. Distinct from null
    // below: the server did report, and what it reported is "no cap applies" —
    // which under BYO is every instance.
    serverSays({
      provider: "openai",
      endpoint: "https://ai.example.com/v1",
      hasApiKey: true,
      quota: { used: 3, limit: 0, period: "2026-09" },
    });
    const { getQuota } = await load({ nextcloud: true });

    expect(await getQuota()).toEqual({ used: 3, limit: 0, period: "2026-09" });
  });

  it("reports nothing rather than zero when the server does not account at all", async () => {
    // A server predating usage accounting reports no quota block. Inventing
    // {used: 0} from that would claim an allowance was measured and found
    // untouched, which is a different statement from "this is not tracked here".
    serverSays({ provider: "openai", endpoint: "https://ai.example.com/v1", hasApiKey: true });
    const { getQuota } = await load({ nextcloud: true });

    expect(await getQuota()).toBeNull();
  });

  it("is null on the native builds, which have no server to account for spend", async () => {
    const { getQuota } = await load({ nextcloud: false });

    expect(await getQuota()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a refused endpoint as a named failure, not a status code", async () => {
    // The server rejects an endpoint outside the allowlist. The dropdown makes
    // this normally unreachable, so when it does happen the policy was narrowed
    // while the form was open — and the UI has to be able to say that rather
    // than showing "403".
    fetchMock.mockImplementation(async (_url, init) => {
      if (init?.method === "POST") {
        return { ok: false, status: 403, json: async () => ({ error: "endpoint-not-permitted" }) };
      }
      return { ok: true, json: async () => ({ provider: "", endpoint: "", hasApiKey: false }) };
    });
    const { setProviderConfig } = await load({ nextcloud: true });

    await expect(
      setProviderConfig({ provider: "openai", endpoint: "https://evil.example/v1" }),
    ).rejects.toMatchObject({ code: "endpoint-not-permitted" });
  });
});

describe("isProviderConfigured", () => {
  it("does not require a credential for an OpenAI-compatible endpoint", async () => {
    // A local model server (LM Studio, Ollama) needs no token; demanding one
    // would refuse a working setup.
    const { isProviderConfigured } = await load();
    expect(isProviderConfigured({ provider: "openai", endpoint: "http://localhost:1234/v1" })).toBe(
      true,
    );
  });

  it("requires an endpoint for OpenAI, which has no default host", async () => {
    const { isProviderConfigured } = await load();
    expect(isProviderConfigured({ provider: "openai", endpoint: "" })).toBe(false);
  });

  it("requires a token for Replicate, which cannot run without one", async () => {
    const { isProviderConfigured } = await load();
    expect(isProviderConfigured({ provider: "replicate", apiKey: "" })).toBe(false);
    expect(isProviderConfigured({ provider: "replicate", apiKey: "r8_x" })).toBe(true);
  });

  it("treats an unset provider as unconfigured", async () => {
    const { isProviderConfigured } = await load();
    expect(isProviderConfigured({ provider: "", endpoint: "https://x/v1" })).toBe(false);
    expect(isProviderConfigured(null)).toBe(false);
  });
});

describe("a failed server-config read is not cached", () => {
  it("retries on the next call rather than staying unconfigured all session", async () => {
    // A cached failure had the same lifetime as a cached success, so one
    // transient error — the instance still booting, a dropped connection —
    // disabled AI recognition for the whole session on a working instance.
    let attempt = 0;
    fetchMock.mockImplementation(async () => {
      attempt++;
      if (attempt === 1) throw new Error("network down");
      return {
        ok: true,
        json: async () => ({
          provider: "openai",
          endpoint: "https://vision.example.com/v1",
          hasApiKey: true,
        }),
      };
    });

    const { getProviderConfig } = await load({ nextcloud: true });

    const first = await getProviderConfig();
    expect(first.provider).toBe("");

    const second = await getProviderConfig();
    expect(second.provider).toBe("openai");
    expect(second.endpoint).toBe("https://vision.example.com/v1");
  });

  it("still caches a successful read, so a run does not refetch per band", async () => {
    serverSays({ provider: "openai", endpoint: "https://vision.example.com/v1" });
    const { getProviderConfig } = await load({ nextcloud: true });

    await getProviderConfig();
    await getProviderConfig();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("an administrator's policy change reaches an open tab", () => {
  it("reports the new mode once the cache is invalidated", async () => {
    // The server config is cached for the session so a recognition run does not
    // refetch it per page. That cache is what made an admin change invisible to
    // an already-open tab: the settings screen re-read a copy taken earlier, so
    // closing and reopening settings changed nothing and only a full page
    // reload helped. Invalidating is what the settings screen and the
    // foreground handler now do before reading.
    let mode = "byo";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ mode, provider: "openai", central: { model: "m" } }),
      })),
    );

    const { isCentrallyManaged, invalidateProviderCache } = await load({ nextcloud: true });

    expect(await isCentrallyManaged()).toBe(false);

    // The administrator switches to central mode in another tab.
    mode = "central";

    // Without invalidation the cached copy still answers.
    expect(await isCentrallyManaged()).toBe(false);

    invalidateProviderCache();
    expect(await isCentrallyManaged()).toBe(true);
  });

  it("is inert on the native builds, which have no server policy", async () => {
    const { isCentrallyManaged } = await load();

    expect(await isCentrallyManaged()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
