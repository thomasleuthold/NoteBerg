/**
 * Covers the recognition half of the config split.
 *
 * The split exists so that "how handwriting is recognized" and "which AI service
 * this account can reach" are independent: configuring Windows Ink for
 * handwriting must not cost you model access for other features, and a
 * configured provider must not silently start recognizing handwriting.
 *
 * These tests are mostly about that independence, and about the join —
 * isRecognitionReady() — which is the only place the two halves are required to
 * hold at once.
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

async function load({ nextcloud = false } = {}) {
  vi.resetModules();
  vi.stubEnv("VITE_PLATFORM", nextcloud ? "nextcloud" : "tauri");
  return import("./recognitionSettings.js");
}

beforeEach(() => {
  settings = {};
  credentials = {};
  vi.stubGlobal("fetch", vi.fn());
});

describe("the method is independent of the provider", () => {
  it("defaults to Windows Ink, which sends nothing anywhere", async () => {
    // Handwriting must never leave the device on a configuration the user did
    // not choose (DESIGN §6).
    const { getRecognitionConfig, METHOD_WINDOWS_INK } = await load();
    expect((await getRecognitionConfig()).method).toBe(METHOD_WINDOWS_INK);
  });

  it("keeps a configured provider available while handwriting stays local", async () => {
    // The whole point of the split: choosing Windows Ink for handwriting must
    // not discard the model access other features depend on.
    settings.recognition_method = "windowsInk";
    settings.ai_provider = "openai";
    settings.ai_endpoint = "https://vision.example.com/v1";

    const { getRecognitionConfig } = await load();
    const config = await getRecognitionConfig();

    expect(config.method).toBe("windowsInk");
    expect(config.provider).toBe("openai");
    expect(config.endpoint).toBe("https://vision.example.com/v1");
  });

  it("does not start recognizing just because a provider exists", async () => {
    // The converse: configuring a provider for some other feature must not
    // silently opt handwriting into being uploaded.
    settings.ai_provider = "openai";
    settings.ai_endpoint = "https://vision.example.com/v1";
    settings.recognition_model = "vision";

    const { getRecognitionConfig, isRecognitionReady } = await load();

    expect(isRecognitionReady(await getRecognitionConfig())).toBe(false);
  });

  it("refuses to write provider fields, which have exactly one writer", async () => {
    // Two writers for one setting is how the pre-split config drifted.
    const { setRecognitionConfig } = await load();
    await setRecognitionConfig({ provider: "replicate", endpoint: "https://x/v1" });

    expect(settings.ai_provider).toBeUndefined();
    expect(settings.ai_endpoint).toBeUndefined();
  });
});

describe("the model is task-scoped", () => {
  it("keeps the model with recognition, not with the provider", async () => {
    // Recognition needs a *vision* model; a summary feature would need a text
    // model against the same provider. One shared model field cannot serve both.
    const { setRecognitionConfig } = await load();
    await setRecognitionConfig({ model: "owner/vision-model" });

    expect(settings.recognition_model).toBe("owner/vision-model");
  });

  it("keeps the model local even on Nextcloud", async () => {
    // Pre-split it was pushed server-side along with the endpoint, which it
    // never needed: it is a preference, not a server-relative address.
    const { setRecognitionConfig } = await load({ nextcloud: true });
    await setRecognitionConfig({ model: "owner/vision-model" });

    expect(settings.recognition_model).toBe("owner/vision-model");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps genuine per-device preferences local", async () => {
    const { setRecognitionConfig } = await load({ nextcloud: true });
    await setRecognitionConfig({ maxImageEdge: 2000, systemPrompt: "hi" });

    expect(settings.recognition_max_image_edge).toBe(2000);
    expect(settings.recognition_system_prompt).toBe("hi");
  });
});

describe("isRecognitionReady", () => {
  beforeEach(() => {
    settings.recognition_method = "ai";
    settings.ai_provider = "openai";
    settings.ai_endpoint = "https://vision.example.com/v1";
    settings.recognition_model = "vision";
  });

  it("accepts a complete configuration", async () => {
    const { getRecognitionConfig, isRecognitionReady } = await load();
    expect(isRecognitionReady(await getRecognitionConfig())).toBe(true);
  });

  it("refuses a reachable provider with no model to run on it", async () => {
    // Half-configured is not runnable, and must read as "not set up" rather
    // than failing mid-recognition.
    settings.recognition_model = "";

    const { getRecognitionConfig, isRecognitionReady } = await load();
    expect(isRecognitionReady(await getRecognitionConfig())).toBe(false);
  });

  it("refuses a model with no provider to run it on", async () => {
    settings.ai_provider = "";

    const { getRecognitionConfig, isRecognitionReady } = await load();
    expect(isRecognitionReady(await getRecognitionConfig())).toBe(false);
  });

  it("refuses when the method is not AI, however complete the provider is", async () => {
    settings.recognition_method = "windowsInk";

    const { getRecognitionConfig, isRecognitionReady } = await load();
    expect(isRecognitionReady(await getRecognitionConfig())).toBe(false);
  });
});

describe("language", () => {
  it("defaults to auto-detect rather than asserting a language", async () => {
    // A wrong assertion is worse than none: a model told the page is English
    // rewrites German words into English.
    const { getRecognitionConfig, LANGUAGE_AUTO } = await load();
    expect((await getRecognitionConfig()).language).toBe(LANGUAGE_AUTO);
  });

  it("stays with recognition, which is the feature that uses it", async () => {
    const { setRecognitionConfig } = await load();
    await setRecognitionConfig({ language: "de-DE" });
    expect(settings.recognition_language).toBe("de-DE");
  });
});

describe("central mode: the administrator's task settings", () => {
  /** A server reporting central mode with the given task settings. */
  function serverCentral(central) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          mode: "central",
          provider: "openai",
          endpoint: "https://ai.example.com/v1",
          hasApiKey: true,
          central,
        }),
      })),
    );
  }

  it("overrides the model this device holds", async () => {
    // The whole point of the mode: the run must use the administrator's model,
    // because it is the administrator's account paying for it.
    settings.recognition_model = "expensive/local-choice";
    serverCentral({ model: "admin/approved-model" });

    const { getRecognitionConfig } = await load({ nextcloud: true });
    const config = await getRecognitionConfig();

    expect(config.model).toBe("admin/approved-model");
    expect(config.centrallyManaged).toBe(true);
  });

  it("overrides the prompt and language too", async () => {
    settings.recognition_system_prompt = "my own prompt";
    settings.recognition_language = "de-DE";
    serverCentral({ model: "m", systemPrompt: "the admin prompt", language: "fr-FR" });

    const { getRecognitionConfig } = await load({ nextcloud: true });
    const config = await getRecognitionConfig();

    expect(config.systemPrompt).toBe("the admin prompt");
    expect(config.language).toBe("fr-FR");
  });

  it("takes the rendering settings from the administrator too", async () => {
    // These were per-device at first, on the reasoning that they tune how this
    // device talks to the service rather than which service. In practice that
    // left three editable fields in a form that was otherwise the
    // administrator's, which read as broken — so the whole configuration moved
    // across and the user's settings screen shows only the notice.
    settings.recognition_max_image_edge = 2400;
    settings.recognition_timeout_seconds = 300;
    serverCentral({ model: "m", maxImageEdge: 1200, timeoutSeconds: 90 });

    const { getRecognitionConfig } = await load({ nextcloud: true });
    const config = await getRecognitionConfig();

    expect(config.maxImageEdge).toBe(1200);
    expect(config.timeoutSeconds).toBe(90);
  });

  it("falls back to auto when the administrator set no language", async () => {
    settings.recognition_language = "de-DE";
    serverCentral({ model: "m" });

    const { getRecognitionConfig } = await load({ nextcloud: true });

    expect((await getRecognitionConfig()).language).toBe("auto");
  });

  it("leaves BYO mode reading local settings", async () => {
    // The mode is exclusive: a server reporting byo must not have its (absent)
    // central block override anything.
    settings.recognition_model = "my/own-model";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ mode: "byo", provider: "openai", endpoint: "https://x/v1" }),
      })),
    );

    const { getRecognitionConfig } = await load({ nextcloud: true });
    const config = await getRecognitionConfig();

    expect(config.model).toBe("my/own-model");
    expect(config.centrallyManaged).toBe(false);
  });

  it("is inert on the native builds, which have no administrator", async () => {
    // The regression that matters most: Windows and Android must not acquire a
    // server round trip, or a mode they cannot be in.
    settings.recognition_model = "my/own-model";

    const { getRecognitionConfig } = await load();
    const config = await getRecognitionConfig();

    expect(config.model).toBe("my/own-model");
    expect(config.centrallyManaged).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("treats a server predating the mode as BYO", async () => {
    // An older server reports no mode at all. Claiming central would render an
    // empty read-only form against settings that do not exist.
    settings.recognition_model = "my/own-model";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ provider: "openai", endpoint: "https://x/v1" }),
      })),
    );

    const { getRecognitionConfig } = await load({ nextcloud: true });

    expect((await getRecognitionConfig()).centrallyManaged).toBe(false);
  });
});

describe("central mode: the rendering parameters", () => {
  /** A server reporting central mode with the given task settings. */
  function serverCentral(central) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ mode: "central", provider: "openai", central }),
      })),
    );
  }

  it("takes image size, token cap and timeout from the administrator", async () => {
    // These moved under central management with everything else: leaving three
    // fields editable in an otherwise fixed form was the confusing state.
    settings.recognition_max_image_edge = 2400;
    settings.recognition_max_tokens = 4000;
    settings.recognition_timeout_seconds = 300;
    serverCentral({ model: "m", maxImageEdge: 1200, maxTokens: 6000, timeoutSeconds: 90 });

    const { getRecognitionConfig } = await load({ nextcloud: true });
    const config = await getRecognitionConfig();

    expect(config.maxImageEdge).toBe(1200);
    expect(config.maxTokens).toBe(6000);
    expect(config.timeoutSeconds).toBe(90);
  });

  it("falls back to the built-in defaults when the administrator set none", async () => {
    // The server reports 0 for an unset numeric setting. A zero-pixel image or a
    // zero-token cap is the absence of a choice, not a choice — so `||` rather
    // than `??`, which would have accepted the 0.
    settings.recognition_max_image_edge = 2400;
    serverCentral({ model: "m", maxImageEdge: 0, maxTokens: 0, timeoutSeconds: 0 });

    const { getRecognitionConfig } = await load({ nextcloud: true });
    const config = await getRecognitionConfig();

    expect(config.maxImageEdge).toBe(1600);
    expect(config.maxTokens).toBe(8000);
    expect(config.timeoutSeconds).toBe(120);
  });

  it("leaves them per-device under BYO", async () => {
    settings.recognition_max_image_edge = 2400;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ mode: "byo", provider: "openai" }) })),
    );

    const { getRecognitionConfig } = await load({ nextcloud: true });

    expect((await getRecognitionConfig()).maxImageEdge).toBe(2400);
  });

  it("leaves them per-device on the native builds", async () => {
    settings.recognition_max_image_edge = 2400;

    const { getRecognitionConfig } = await load();

    expect((await getRecognitionConfig()).maxImageEdge).toBe(2400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("central mode implies the AI method", () => {
  function serverCentral(central, provider = "openai") {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          mode: "central",
          provider,
          endpoint: "https://ai.example.com/v1",
          hasApiKey: true,
          central,
        }),
      })),
    );
  }

  it("reports the AI method even though nothing is stored locally", async () => {
    // The reported bug: the method was read from local storage, defaulted to
    // windowsInk, and the settings screen offers no selector under central
    // administration — so isRecognitionReady() failed its first check and
    // recognition reported itself unconfigured while the provider, model and
    // credential were all present.
    serverCentral({ model: "admin/model" });

    const { getRecognitionConfig, isRecognitionReady, METHOD_AI } = await load({
      nextcloud: true,
    });
    const config = await getRecognitionConfig();

    expect(config.method).toBe(METHOD_AI);
    expect(isRecognitionReady(config)).toBe(true);
  });

  it("overrides a stored windowsInk left from before the switch", async () => {
    // A user configured for Windows Ink before the administrator switched to
    // central mode must not be stuck on a method that cannot run here.
    settings.recognition_method = "windowsInk";
    serverCentral({ model: "admin/model" });

    const { getRecognitionConfig, METHOD_AI } = await load({ nextcloud: true });

    expect((await getRecognitionConfig()).method).toBe(METHOD_AI);
  });

  it("is ready for Replicate, which carries no endpoint of the user's", async () => {
    serverCentral({ model: "lucataco/qwen3-vl", replicateVersion: "abc123" }, "replicate");

    const { getRecognitionConfig, isRecognitionReady } = await load({ nextcloud: true });

    expect(isRecognitionReady(await getRecognitionConfig())).toBe(true);
  });

  it("leaves the stored method alone under BYO", async () => {
    settings.recognition_method = "windowsInk";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ mode: "byo", provider: "openai" }) })),
    );

    const { getRecognitionConfig } = await load({ nextcloud: true });

    expect((await getRecognitionConfig()).method).toBe("windowsInk");
  });

  it("leaves the stored method alone on the native builds", async () => {
    settings.recognition_method = "windowsInk";

    const { getRecognitionConfig } = await load();

    expect((await getRecognitionConfig()).method).toBe("windowsInk");
  });
});
