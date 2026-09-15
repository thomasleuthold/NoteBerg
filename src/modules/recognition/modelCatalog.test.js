/**
 * Covers the model catalog.
 *
 * The requirement being tested is that one picker works against three listings
 * that agree on almost nothing: OpenRouter describes modalities, a local server
 * describes an id and nothing else, and Replicate describes neither but pages.
 * Most of what follows asserts that the two undescriptive cases degrade to a
 * usable list rather than to a table of blanks or to false capability claims.
 *
 * The mocks answer with real response shapes — captured from
 * https://openrouter.ai/api/v1/models and Replicate's documented listing — so a
 * change to the normalizer that breaks a real provider breaks a test.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let fetchMock;

vi.mock("./backends/backendTransport.js", () => ({
  getFetch: async () => fetchMock,
}));

const load = async () => {
  vi.resetModules();
  return import("./modelCatalog.js");
};

/** A canned HTTP response. */
const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/** An OpenRouter entry, shaped as the live API returns one. */
const openRouterModel = (overrides = {}) => ({
  id: "qwen/qwen3-vl-8b-instruct",
  canonical_slug: "qwen/qwen3-vl-8b-instruct",
  name: "Qwen: Qwen3-VL 8B Instruct",
  description: "A multimodal model.",
  context_length: 131072,
  architecture: {
    modality: "text+image->text",
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    tokenizer: "Qwen",
  },
  supported_parameters: ["max_tokens", "temperature", "tools"],
  ...overrides,
});

const OPENAI_CONFIG = { provider: "openai", endpoint: "https://openrouter.ai/api/v1" };
const REPLICATE_CONFIG = { provider: "replicate", apiKey: "r8_test" };

beforeEach(() => {
  fetchMock = vi.fn(async () => reply(200, { data: [openRouterModel()] }));
});

describe("reading an OpenAI-compatible listing", () => {
  it("asks the endpoint for its models without running one", async () => {
    // Browsing must cost nothing, for the same reason the connection check does.
    const { listModels } = await load();
    await listModels(OPENAI_CONFIG);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/models");
    expect(init.method).toBe("GET");
    expect(url).not.toContain("chat/completions");
    expect(init.body).toBeUndefined();
  });

  it("reports a vision model as image->text so the vision filter finds it", async () => {
    // The whole point of the type column: recognition needs a model that reads
    // images, and this is how the user is told which ones do.
    const { listModels, TYPE_IMAGE_TEXT, CAP_VISION } = await load();
    const result = await listModels(OPENAI_CONFIG);

    expect(result.models).toHaveLength(1);
    expect(result.models[0].type).toBe(TYPE_IMAGE_TEXT);
    expect(result.models[0].capabilities).toContain(CAP_VISION);
  });

  it("classifies a text-only model as text->text", async () => {
    fetchMock = vi.fn(async () =>
      reply(200, {
        data: [
          openRouterModel({
            id: "openai/gpt-4o-mini",
            architecture: {
              modality: "text->text",
              input_modalities: ["text"],
              output_modalities: ["text"],
            },
          }),
        ],
      }),
    );

    const { listModels, TYPE_TEXT_TEXT, CAP_VISION } = await load();
    const result = await listModels(OPENAI_CONFIG);

    expect(result.models[0].type).toBe(TYPE_TEXT_TEXT);
    expect(result.models[0].capabilities).not.toContain(CAP_VISION);
  });

  it("treats a model that both reads and writes images as image->text", async () => {
    // It can still transcribe a page, so hiding it behind the image-generation
    // type would hide it from the filter the user is most likely to apply.
    fetchMock = vi.fn(async () =>
      reply(200, {
        data: [
          openRouterModel({
            architecture: {
              modality: "text+image->text+image",
              input_modalities: ["text", "image"],
              output_modalities: ["text", "image"],
            },
          }),
        ],
      }),
    );

    const { listModels, TYPE_IMAGE_TEXT } = await load();
    const result = await listModels(OPENAI_CONFIG);
    expect(result.models[0].type).toBe(TYPE_IMAGE_TEXT);
  });

  it("classifies an image generator as text->image", async () => {
    fetchMock = vi.fn(async () =>
      reply(200, {
        data: [
          openRouterModel({
            id: "black-forest-labs/flux",
            architecture: {
              modality: "text->image",
              input_modalities: ["text"],
              output_modalities: ["image"],
            },
          }),
        ],
      }),
    );

    const { listModels, TYPE_TEXT_IMAGE } = await load();
    const result = await listModels(OPENAI_CONFIG);
    expect(result.models[0].type).toBe(TYPE_TEXT_IMAGE);
  });

  it("carries the capabilities the provider declared", async () => {
    fetchMock = vi.fn(async () =>
      reply(200, {
        data: [
          openRouterModel({
            architecture: {
              modality: "text+image+file+audio+video->text",
              input_modalities: ["text", "image", "file", "audio", "video"],
              output_modalities: ["text"],
            },
            supported_parameters: ["tools", "reasoning"],
          }),
        ],
      }),
    );

    const { listModels, CAP_AUDIO, CAP_FILES, CAP_REASONING, CAP_TOOLS, CAP_VIDEO, CAP_VISION } =
      await load();
    const [model] = (await listModels(OPENAI_CONFIG)).models;

    expect(model.capabilities).toEqual(
      expect.arrayContaining([
        CAP_VISION,
        CAP_AUDIO,
        CAP_VIDEO,
        CAP_FILES,
        CAP_TOOLS,
        CAP_REASONING,
      ]),
    );
  });
});

describe("a server that describes nothing", () => {
  // LM Studio and Ollama report {id} and no more. They are the servers this app
  // was built around, so the picker has to stay usable with no metadata at all.
  const bareListing = { data: [{ id: "qwen2.5-vl-7b-instruct" }, { id: "llama-3.1-8b" }] };

  it("still lists the models", async () => {
    fetchMock = vi.fn(async () => reply(200, bareListing));
    const { listModels } = await load();
    const result = await listModels({ provider: "openai", endpoint: "http://localhost:1234/v1" });

    expect(result.models.map((model) => model.id)).toEqual([
      "qwen2.5-vl-7b-instruct",
      "llama-3.1-8b",
    ]);
  });

  it("falls back to the id as the display name", async () => {
    fetchMock = vi.fn(async () => reply(200, bareListing));
    const { listModels } = await load();
    const [model] = (await listModels({ provider: "openai", endpoint: "http://localhost:1234/v1" }))
      .models;

    expect(model.name).toBe("qwen2.5-vl-7b-instruct");
  });

  it("says the type is unknown rather than guessing text-only", async () => {
    // "qwen2.5-vl" is a vision model. Reporting it as text->text because the
    // server did not say so would steer the user away from a model that works.
    fetchMock = vi.fn(async () => reply(200, bareListing));
    const { listModels, TYPE_UNKNOWN } = await load();
    const [model] = (await listModels({ provider: "openai", endpoint: "http://localhost:1234/v1" }))
      .models;

    expect(model.type).toBe(TYPE_UNKNOWN);
    expect(model.capabilities).toEqual([]);
  });

  it("skips entries with no usable id rather than listing a blank row", async () => {
    fetchMock = vi.fn(async () => reply(200, { data: [{ id: "good" }, {}, { id: 42 }] }));
    const { listModels } = await load();
    const result = await listModels({ provider: "openai", endpoint: "http://localhost:1234/v1" });

    expect(result.models).toHaveLength(1);
    expect(result.models[0].id).toBe("good");
  });
});

describe("reading Replicate's listing", () => {
  const replicatePage = (results, next = null) => reply(200, { results, next });

  const replicateModel = (name) => ({
    owner: "lucataco",
    name,
    description: `Runs ${name}.`,
    latest_version: { id: "5c7d5dc6dd8bf7" },
  });

  it("addresses the account listing rather than a prediction", async () => {
    fetchMock = vi.fn(async () => replicatePage([replicateModel("qwen3-vl-8b-instruct")]));
    const { listModels } = await load();
    await listModels(REPLICATE_CONFIG);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.replicate.com/v1/models");
    expect(init.method).toBe("GET");
    expect(url).not.toContain("predictions");
  });

  it("builds the owner/name reference the model field expects", async () => {
    fetchMock = vi.fn(async () => replicatePage([replicateModel("qwen3-vl-8b-instruct")]));
    const { listModels } = await load();
    const [model] = (await listModels(REPLICATE_CONFIG)).models;

    expect(model.id).toBe("lucataco/qwen3-vl-8b-instruct");
  });

  it("carries the version hash, so picking a community model fills in both fields", async () => {
    // Without the version, a picked community model fails at run time with
    // "not found" — the exact failure the picker exists to prevent.
    fetchMock = vi.fn(async () => replicatePage([replicateModel("qwen3-vl-8b-instruct")]));
    const { listModels } = await load();
    const [model] = (await listModels(REPLICATE_CONFIG)).models;

    expect(model.version).toBe("5c7d5dc6dd8bf7");
  });

  it("follows the cursor and merges the pages", async () => {
    fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        replicatePage([replicateModel("a")], "https://api.replicate.com/v1/models?cursor=x"),
      )
      .mockResolvedValueOnce(replicatePage([replicateModel("b")]));

    const { listModels } = await load();
    const result = await listModels(REPLICATE_CONFIG);

    expect(result.models.map((model) => model.id)).toEqual(["lucataco/a", "lucataco/b"]);
    expect(result.truncated).toBe(false);
  });

  it("stops after its page budget and reports the list as partial", async () => {
    // Replicate lists tens of thousands of public models. Walking all of them
    // would be hundreds of requests; the honest answer is a sample that says so.
    fetchMock = vi.fn(async () =>
      replicatePage([replicateModel("m")], "https://api.replicate.com/v1/models?cursor=next"),
    );

    const { listModels } = await load();
    const result = await listModels(REPLICATE_CONFIG);

    expect(result.truncated).toBe(true);
    expect(fetchMock.mock.calls.length).toBeLessThan(20);
  });

  it("refuses a cursor that points off the Replicate host", async () => {
    // `next` is chosen by the server. A cursor redirected elsewhere would carry
    // the API token with it.
    fetchMock = vi
      .fn()
      .mockResolvedValueOnce(replicatePage([replicateModel("a")], "https://evil.example/v1/models"))
      .mockResolvedValueOnce(replicatePage([replicateModel("b")]));

    const { listModels, CATALOG_UNREACHABLE } = await load();
    const result = await listModels(REPLICATE_CONFIG);

    expect(result.outcome).toBe(CATALOG_UNREACHABLE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not describe modalities it was never told about", async () => {
    fetchMock = vi.fn(async () => replicatePage([replicateModel("qwen3-vl-8b-instruct")]));
    const { listModels, TYPE_UNKNOWN } = await load();
    const [model] = (await listModels(REPLICATE_CONFIG)).models;

    // The name says "vl", but Replicate's listing does not, and a wrong badge is
    // worse than a missing one because the user acts on it.
    expect(model.type).toBe(TYPE_UNKNOWN);
    expect(model.capabilities).toEqual([]);
  });
});

describe("outcomes when no list arrives", () => {
  it("reports a missing listing as unsupported, not as a failure", async () => {
    // A server that routes completions fine may simply not implement /models.
    // Calling that "broken" would send the user chasing a working setup.
    fetchMock = vi.fn(async () => reply(404, {}));
    const { listModels, CATALOG_UNSUPPORTED } = await load();

    expect((await listModels(OPENAI_CONFIG)).outcome).toBe(CATALOG_UNSUPPORTED);
  });

  it("reports a rejected credential as unauthorized", async () => {
    fetchMock = vi.fn(async () => reply(401, {}));
    const { listModels, CATALOG_UNAUTHORIZED } = await load();

    expect((await listModels(REPLICATE_CONFIG)).outcome).toBe(CATALOG_UNAUTHORIZED);
  });

  it("reports a 200 that is not a listing as unsupported", async () => {
    // A captive portal or a proxy landing page answers 200 with HTML.
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    }));
    const { listModels, CATALOG_UNSUPPORTED } = await load();

    expect((await listModels(OPENAI_CONFIG)).outcome).toBe(CATALOG_UNSUPPORTED);
  });

  it("reports a JSON body with no array as unsupported", async () => {
    fetchMock = vi.fn(async () => reply(200, { object: "list" }));
    const { listModels, CATALOG_UNSUPPORTED } = await load();

    expect((await listModels(OPENAI_CONFIG)).outcome).toBe(CATALOG_UNSUPPORTED);
  });

  it("reports a dead endpoint as unreachable", async () => {
    fetchMock = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const { listModels, CATALOG_UNREACHABLE } = await load();
    const result = await listModels(OPENAI_CONFIG);

    expect(result.outcome).toBe(CATALOG_UNREACHABLE);
    expect(result.message).toContain("connection refused");
  });

  it("does not call out when nothing is configured", async () => {
    const { listModels, CATALOG_NOT_CONFIGURED } = await load();

    expect((await listModels({})).outcome).toBe(CATALOG_NOT_CONFIGURED);
    expect((await listModels({ provider: "openai", endpoint: "" })).outcome).toBe(
      CATALOG_NOT_CONFIGURED,
    );
    expect((await listModels({ provider: "replicate" })).outcome).toBe(CATALOG_NOT_CONFIGURED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("browses on a Nextcloud instance, where the server holds the key", async () => {
    // hasApiKey without apiKey is the normal NC state: the proxy attaches the
    // credential. Treating it as unconfigured would disable browsing there.
    fetchMock = vi.fn(async () => reply(200, { results: [], next: null }));
    const { listModels, CATALOG_OK } = await load();
    const result = await listModels({ provider: "replicate", hasApiKey: true });

    expect(result.outcome).toBe(CATALOG_OK);
    // No Authorization header: the browser has no key to send, and an empty
    // bearer would read as a bug in the proxy's logs.
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});

describe("credentials", () => {
  it("sends an unsaved key, so a user can browse before committing", async () => {
    const { listModels } = await load();
    await listModels({ ...OPENAI_CONFIG, apiKey: "sk-typed-just-now" });

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer sk-typed-just-now");
  });
});

describe("filtering", () => {
  const catalog = [
    {
      id: "qwen/qwen3-vl-8b",
      name: "Qwen: Qwen3-VL 8B",
      description: "Multimodal.",
      type: "image->text",
      capabilities: ["vision"],
    },
    {
      id: "openai/gpt-4o-mini",
      name: "OpenAI: GPT-4o mini",
      description: "Fast text model.",
      type: "text->text",
      capabilities: [],
    },
    {
      id: "lucataco/qwen2-audio",
      name: "lucataco/qwen2-audio",
      description: "Speech understanding.",
      type: "unknown",
      capabilities: [],
    },
  ];

  it("matches a typed brand across id and display name alike", async () => {
    // The user types "qwen"; one model carries it in the id, another in a
    // display name shaped "Qwen: ...". Both must come back.
    const { filterModels } = await load();
    const found = filterModels(catalog, { query: "qwen" });

    expect(found.map((model) => model.id)).toEqual(["qwen/qwen3-vl-8b", "lucataco/qwen2-audio"]);
  });

  it("is case-insensitive", async () => {
    const { filterModels } = await load();
    expect(filterModels(catalog, { query: "QWEN" })).toHaveLength(2);
  });

  it("narrows on each further word rather than widening", async () => {
    // An OR across terms would return most of a several-hundred-model catalog,
    // which is the opposite of what typing a second word is for.
    const { filterModels } = await load();
    const found = filterModels(catalog, { query: "qwen audio" });

    expect(found.map((model) => model.id)).toEqual(["lucataco/qwen2-audio"]);
  });

  it("searches the description too", async () => {
    const { filterModels } = await load();
    expect(filterModels(catalog, { query: "speech" }).map((model) => model.id)).toEqual([
      "lucataco/qwen2-audio",
    ]);
  });

  it("filters by type", async () => {
    const { filterModels } = await load();
    expect(filterModels(catalog, { type: "text->text" }).map((model) => model.id)).toEqual([
      "openai/gpt-4o-mini",
    ]);
  });

  it("combines a type filter with a search term", async () => {
    const { filterModels } = await load();
    expect(filterModels(catalog, { query: "qwen", type: "image->text" })).toHaveLength(1);
  });

  it("keeps only declared vision models when asked", async () => {
    const { filterModels } = await load();
    expect(filterModels(catalog, { visionOnly: true }).map((model) => model.id)).toEqual([
      "qwen/qwen3-vl-8b",
    ]);
  });

  it("returns everything when no filter is set", async () => {
    const { filterModels } = await load();
    expect(filterModels(catalog, {})).toHaveLength(3);
    expect(filterModels(catalog)).toHaveLength(3);
  });
});

describe("the type filter's options", () => {
  it("offers only types the catalog actually contains", async () => {
    // A dropdown listing four categories that all return nothing reads as a
    // broken filter — which is the normal case for a local server.
    const { availableTypes } = await load();

    expect(availableTypes([{ type: "unknown" }, { type: "unknown" }])).toEqual(["unknown"]);
  });

  it("orders vision models first, since that is what recognition needs", async () => {
    const { availableTypes } = await load();

    expect(availableTypes([{ type: "text->text" }, { type: "image->text" }])).toEqual([
      "image->text",
      "text->text",
    ]);
  });

  it("handles an empty catalog", async () => {
    const { availableTypes } = await load();
    expect(availableTypes([])).toEqual([]);
    expect(availableTypes()).toEqual([]);
  });
});

describe("searching Replicate's catalog", () => {
  /**
   * A search hit, shaped as GET /v1/search returns one: the model nested beside
   * its relevance metadata, rather than at the top level as the listing has it.
   * Captured from the endpoint's published schema (schemas_search_response).
   */
  const searchHit = (name) => ({
    metadata: {
      generated_description: `A longer blurb about ${name}.`,
      score: 1.38,
      tags: ["image-to-text"],
    },
    model: {
      owner: "lucataco",
      name,
      description: `Runs ${name}.`,
      latest_version: { id: "5c7d5dc6dd8bf7" },
      run_count: 4304274,
      url: `https://replicate.com/lucataco/${name}`,
      visibility: "public",
    },
  });

  const searchReply = (models, extra = {}) =>
    reply(200, { query: "qwen", models, collections: [], pages: [], ...extra });

  it("asks the provider rather than filtering what was already loaded", async () => {
    fetchMock = vi.fn(async () => searchReply([searchHit("qwen3-vl-8b-instruct")]));
    const { searchModels } = await load();
    await searchModels(REPLICATE_CONFIG, "qwen vl");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("https://api.replicate.com/v1/search");
    expect(url).toContain("query=qwen%20vl");
    expect(init.method).toBe("GET");
  });

  it("finds a model that the capped browse listing never reached", async () => {
    // The whole point of the feature: this model is not in the first pages of
    // the listing, so only a server-side query can return it.
    fetchMock = vi.fn(async () => searchReply([searchHit("obscure-vision-model")]));
    const { searchModels } = await load();
    const result = await searchModels(REPLICATE_CONFIG, "obscure");

    expect(result.models.map((m) => m.id)).toEqual(["lucataco/obscure-vision-model"]);
  });

  it("carries the version hash, so a searched pick can be run", async () => {
    // Without it a community model fails at prediction time with "not found" —
    // the exact failure the picker exists to prevent.
    fetchMock = vi.fn(async () => searchReply([searchHit("qwen3-vl-8b-instruct")]));
    const { searchModels } = await load();
    const result = await searchModels(REPLICATE_CONFIG, "qwen");

    expect(result.models[0].version).toBe("5c7d5dc6dd8bf7");
  });

  it("ignores matched collections and docs pages, which cannot be picked", async () => {
    fetchMock = vi.fn(async () =>
      searchReply([searchHit("qwen3-vl-8b-instruct")], {
        collections: [{ name: "Image editing", slug: "image-editing" }],
        pages: [{ name: "Getting started", href: "/docs/guides" }],
      }),
    );
    const { searchModels } = await load();
    const result = await searchModels(REPLICATE_CONFIG, "qwen");

    expect(result.models).toHaveLength(1);
  });

  it("does not send a request for an empty query", async () => {
    fetchMock = vi.fn(async () => searchReply([]));
    const { searchModels } = await load();
    const result = await searchModels(REPLICATE_CONFIG, "   ");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.models).toEqual([]);
  });

  it("reports a rejected key rather than an empty catalog", async () => {
    fetchMock = vi.fn(async () => reply(401, {}));
    const { searchModels, CATALOG_UNAUTHORIZED } = await load();

    expect((await searchModels(REPLICATE_CONFIG, "qwen")).outcome).toBe(CATALOG_UNAUTHORIZED);
  });

  it("reports a failure instead of throwing, so the picker can fall back", async () => {
    fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    const { searchModels, CATALOG_UNREACHABLE } = await load();
    const result = await searchModels(REPLICATE_CONFIG, "qwen");

    expect(result.outcome).toBe(CATALOG_UNREACHABLE);
    expect(result.message).toContain("network down");
  });

  it("flags a full page of hits as possibly incomplete", async () => {
    fetchMock = vi.fn(async () =>
      searchReply(Array.from({ length: 50 }, (_v, i) => searchHit(`model-${i}`))),
    );
    const { searchModels } = await load();

    expect((await searchModels(REPLICATE_CONFIG, "a")).truncated).toBe(true);
  });

  it("does not claim truncation when the whole answer fits", async () => {
    fetchMock = vi.fn(async () => searchReply([searchHit("qwen3-vl-8b-instruct")]));
    const { searchModels } = await load();

    expect((await searchModels(REPLICATE_CONFIG, "qwen")).truncated).toBe(false);
  });

  it("refuses to search a provider whose listing is already complete", async () => {
    // An OpenAI-compatible listing arrives whole, so filtering it locally is the
    // complete answer and a round trip would only be a slower way to get it.
    fetchMock = vi.fn(async () => searchReply([]));
    const { searchModels, supportsServerSearch, CATALOG_UNSUPPORTED } = await load();

    expect(supportsServerSearch(OPENAI_CONFIG)).toBe(false);
    expect((await searchModels(OPENAI_CONFIG, "qwen")).outcome).toBe(CATALOG_UNSUPPORTED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("needs a key before it will search", async () => {
    const { searchModels, CATALOG_NOT_CONFIGURED } = await load();
    const result = await searchModels({ provider: "replicate" }, "qwen");

    expect(result.outcome).toBe(CATALOG_NOT_CONFIGURED);
  });
});
