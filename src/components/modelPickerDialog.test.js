/**
 * Covers the model picker dialog.
 *
 * Two requirements drive most of what follows.
 *
 * The first is that model names and descriptions are remote content. They come
 * from whatever server the user pointed the app at — including a local one that
 * anything on the machine can write to — so a name containing markup must stay
 * a name. The escaping tests assert on the parsed DOM rather than on a string,
 * because the question is what the browser does with it, not what it looks like.
 *
 * The second is that the dialog has to stay usable when the provider describes
 * almost nothing. A picker that shows a type dropdown with one option, or a
 * vision filter that empties the list, is worse than no picker: it implies the
 * catalog is missing something when the provider simply never said.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let listModelsMock;
let searchModelsMock;

vi.mock("../i18n/index.js", () => ({
  // Interpolating the values makes the count and error assertions meaningful
  // rather than just checking that some key was rendered.
  t: (key, vars) => (vars ? `${key}:${Object.values(vars).join(",")}` : key),
}));

vi.mock("../utils/icons.js", () => ({ getIcon: () => "<svg></svg>" }));

vi.mock("../modules/recognition/modelCatalog.js", async () => {
  const actual = await vi.importActual("../modules/recognition/modelCatalog.js");
  return {
    ...actual,
    listModels: (...args) => listModelsMock(...args),
    searchModels: (...args) => searchModelsMock(...args),
  };
});

/** A catalog entry with sensible defaults. */
const model = (overrides = {}) => ({
  id: "qwen/qwen3-vl-8b",
  name: "Qwen: Qwen3-VL 8B",
  description: "A multimodal model.",
  type: "image->text",
  capabilities: ["vision"],
  contextLength: 131072,
  version: "",
  ...overrides,
});

/** Open the picker and let its listing promise settle. */
async function open(models, opts = {}) {
  const { openModelPicker } = await import("./modelPickerDialog.js");
  const promise = openModelPicker({ provider: "openai", endpoint: "https://x/v1" }, opts);
  // Two ticks: one for the listModels promise, one for the .then that renders.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  return { promise, overlay: document.querySelector(".modal-overlay"), models };
}

beforeEach(() => {
  document.body.innerHTML = "";
  listModelsMock = vi.fn(async () => ({ outcome: "ok", models: [model()], truncated: false }));
  searchModelsMock = vi.fn(async () => ({ outcome: "ok", models: [], truncated: false }));
});

describe("listing models", () => {
  it("shows a row per model", async () => {
    listModelsMock = vi.fn(async () => ({
      outcome: "ok",
      models: [model(), model({ id: "openai/gpt-4o", name: "GPT-4o" })],
    }));

    const { overlay } = await open();
    expect(overlay.querySelectorAll(".model-row")).toHaveLength(2);
  });

  it("shows the id alongside the display name, since the id is what gets stored", async () => {
    // On OpenRouter the two differ, and a user picking by display name has no
    // other way to confirm what landed in the field.
    const { overlay } = await open();
    const row = overlay.querySelector(".model-row");

    expect(row.querySelector(".model-row__name").textContent).toBe("Qwen: Qwen3-VL 8B");
    expect(row.querySelector(".model-row__id").textContent).toBe("qwen/qwen3-vl-8b");
  });

  it("omits the redundant id line when it is the same as the name", async () => {
    // The local-server and Replicate case: repeating the identical string twice
    // per row is noise.
    listModelsMock = vi.fn(async () => ({
      outcome: "ok",
      models: [model({ id: "llama-3.1-8b", name: "llama-3.1-8b" })],
    }));

    const { overlay } = await open();
    expect(overlay.querySelector(".model-row__id")).toBeNull();
  });

  it("badges the declared capabilities", async () => {
    const { overlay } = await open();
    const badges = [...overlay.querySelectorAll(".model-badge")].map((el) => el.textContent);

    expect(badges).toContain("settings.modelPicker.caps.vision");
  });

  it("marks the currently configured model", async () => {
    // Someone opening the picker to change models needs to see what from.
    const { overlay } = await open(undefined, { currentModel: "qwen/qwen3-vl-8b" });

    expect(overlay.querySelector(".model-row").classList).toContain("model-row--current");
  });

  it("reports how many models are shown out of how many exist", async () => {
    listModelsMock = vi.fn(async () => ({
      outcome: "ok",
      models: [model(), model({ id: "b", name: "b" })],
    }));

    const { overlay } = await open();
    expect(overlay.querySelector(".model-picker__note").textContent).toContain("2,2");
  });

  it("says so when the listing is only a sample", async () => {
    // Replicate's catalog is walked to a page budget. Without this the user
    // concludes their model does not exist rather than that it was not fetched.
    listModelsMock = vi.fn(async () => ({ outcome: "ok", models: [model()], truncated: true }));

    const { overlay } = await open();
    expect(overlay.querySelector(".model-picker__note").textContent).toContain(
      "settings.modelPicker.truncated",
    );
  });
});

describe("remote content is never markup", () => {
  it("renders a model name containing tags as text", async () => {
    listModelsMock = vi.fn(async () => ({
      outcome: "ok",
      models: [model({ name: "<img src=x onerror=alert(1)>", id: "evil/model" })],
    }));

    const { overlay } = await open();
    const nameEl = overlay.querySelector(".model-row__name");

    expect(nameEl.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(nameEl.querySelector("img")).toBeNull();
  });

  it("renders a description containing tags as text", async () => {
    listModelsMock = vi.fn(async () => ({
      outcome: "ok",
      models: [model({ description: "<script>alert(1)</script>" })],
    }));

    const { overlay } = await open();

    expect(overlay.querySelector(".model-row__desc").textContent).toBe("<script>alert(1)</script>");
    expect(overlay.querySelector("script")).toBeNull();
  });

  it("keeps a quote-laden id inside the row's data attribute", async () => {
    // The id round-trips through dataset to identify the picked row; a naive
    // interpolation would break the attribute here.
    listModelsMock = vi.fn(async () => ({
      outcome: "ok",
      models: [model({ id: 'a" onclick="alert(1)', name: "n" })],
    }));

    const { overlay } = await open();
    const row = overlay.querySelector(".model-row");

    expect(row.dataset.modelId).toBe('a" onclick="alert(1)');
    expect(row.hasAttribute("onclick")).toBe(false);
  });
});

describe("choosing a model", () => {
  it("resolves with the picked id", async () => {
    const { promise, overlay } = await open();
    overlay.querySelector(".model-row").click();

    await expect(promise).resolves.toEqual({ id: "qwen/qwen3-vl-8b", version: "" });
  });

  it("returns the version hash so a Replicate pick fills in both fields", async () => {
    // Without it, the picked community model fails at run time with "not found".
    listModelsMock = vi.fn(async () => ({
      outcome: "ok",
      models: [model({ id: "lucataco/qwen3-vl", name: "lucataco/qwen3-vl", version: "5c7d5dc" })],
    }));

    const { promise, overlay } = await open();
    overlay.querySelector(".model-row").click();

    await expect(promise).resolves.toEqual({ id: "lucataco/qwen3-vl", version: "5c7d5dc" });
  });

  it("closes the dialog once a model is chosen", async () => {
    const { promise, overlay } = await open();
    overlay.querySelector(".model-row").click();
    await promise;

    expect(document.querySelector(".modal-overlay")).toBeNull();
  });

  it("resolves with null when dismissed", async () => {
    const { promise, overlay } = await open();
    overlay.querySelector(".model-picker__cancel").click();

    await expect(promise).resolves.toBeNull();
  });

  it("dismisses on Escape", async () => {
    const { promise } = await open();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    await expect(promise).resolves.toBeNull();
    expect(document.querySelector(".modal-overlay")).toBeNull();
  });

  it("stops listening for Escape once closed, so it cannot close the next dialog", async () => {
    const { promise, overlay } = await open();
    overlay.querySelector(".model-picker__cancel").click();
    await promise;

    // Would throw on a resolve of an already-settled promise only if the
    // handler survived; the observable check is that nothing is re-added.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".modal-overlay")).toBeNull();
  });
});

describe("filtering", () => {
  const threeModels = [
    model(),
    model({ id: "openai/gpt-4o-mini", name: "GPT-4o mini", type: "text->text", capabilities: [] }),
    model({ id: "meta/llama-3", name: "Llama 3", type: "text->text", capabilities: [] }),
  ];

  it("narrows the list as the user types", async () => {
    listModelsMock = vi.fn(async () => ({ outcome: "ok", models: threeModels }));
    const { overlay } = await open();

    const search = overlay.querySelector(".model-picker__search");
    search.value = "qwen";
    search.dispatchEvent(new Event("input"));

    expect(overlay.querySelectorAll(".model-row")).toHaveLength(1);
  });

  it("updates the count to reflect the filter", async () => {
    listModelsMock = vi.fn(async () => ({ outcome: "ok", models: threeModels }));
    const { overlay } = await open();

    const search = overlay.querySelector(".model-picker__search");
    search.value = "qwen";
    search.dispatchEvent(new Event("input"));

    expect(overlay.querySelector(".model-picker__note").textContent).toContain("1,3");
  });

  it("says plainly when a filter matches nothing", async () => {
    listModelsMock = vi.fn(async () => ({ outcome: "ok", models: threeModels }));
    const { overlay } = await open();

    const search = overlay.querySelector(".model-picker__search");
    search.value = "nothing-matches-this";
    search.dispatchEvent(new Event("input"));

    expect(overlay.querySelector(".model-picker__empty")).not.toBeNull();
  });

  it("offers a type filter listing only the types present", async () => {
    listModelsMock = vi.fn(async () => ({ outcome: "ok", models: threeModels }));
    const { overlay } = await open();

    const options = [...overlay.querySelector(".model-picker__type").options].map((o) => o.value);
    expect(options).toEqual(["", "image->text", "text->text"]);
  });

  it("filters by type", async () => {
    listModelsMock = vi.fn(async () => ({ outcome: "ok", models: threeModels }));
    const { overlay } = await open();

    const select = overlay.querySelector(".model-picker__type");
    select.value = "text->text";
    select.dispatchEvent(new Event("change"));

    expect(overlay.querySelectorAll(".model-row")).toHaveLength(2);
  });

  it("filters to vision models when asked", async () => {
    listModelsMock = vi.fn(async () => ({ outcome: "ok", models: threeModels }));
    const { overlay } = await open();

    const toggle = overlay.querySelector(".model-picker__vision-only");
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));

    expect(overlay.querySelectorAll(".model-row")).toHaveLength(1);
  });

  it("does not filter to vision by default", async () => {
    // Only OpenRouter declares modalities. Defaulting the toggle on would show
    // an empty list for Replicate and every local server.
    listModelsMock = vi.fn(async () => ({ outcome: "ok", models: threeModels }));
    const { overlay } = await open();

    expect(overlay.querySelector(".model-picker__vision-only").checked).toBe(false);
    expect(overlay.querySelectorAll(".model-row")).toHaveLength(3);
  });
});

describe("a provider that describes nothing", () => {
  // The local-server and Replicate case: ids only, no modalities.
  const bare = [
    model({ id: "a", name: "a", type: "unknown", capabilities: [], description: "" }),
    model({ id: "b", name: "b", type: "unknown", capabilities: [], description: "" }),
  ];

  it("hides a type filter that would filter nothing", async () => {
    listModelsMock = vi.fn(async () => ({ outcome: "ok", models: bare }));
    const { overlay } = await open();

    expect(overlay.querySelector(".model-picker__type").classList).toContain(
      "model-picker__hidden",
    );
  });

  it("hides the vision toggle when no model declares vision", async () => {
    // Ticking it would empty the list and explain nothing.
    listModelsMock = vi.fn(async () => ({ outcome: "ok", models: bare }));
    const { overlay } = await open();

    expect(overlay.querySelector(".model-picker__vision").classList).toContain(
      "model-picker__hidden",
    );
  });

  it("still lists the models and lets one be picked", async () => {
    listModelsMock = vi.fn(async () => ({ outcome: "ok", models: bare }));
    const { promise, overlay } = await open();

    expect(overlay.querySelectorAll(".model-row")).toHaveLength(2);
    overlay.querySelector(".model-row").click();
    await expect(promise).resolves.toEqual({ id: "a", version: "" });
  });

  it("keeps the search box, which is the filter that still works", async () => {
    listModelsMock = vi.fn(async () => ({ outcome: "ok", models: bare }));
    const { overlay } = await open();

    expect(overlay.querySelector(".model-picker__search").classList).not.toContain(
      "model-picker__hidden",
    );
  });
});

describe("when no list arrives", () => {
  it("tells the user to type the name when the server has no listing", async () => {
    listModelsMock = vi.fn(async () => ({ outcome: "unsupported", status: 404 }));
    const { overlay } = await open();

    expect(overlay.querySelector(".model-picker__note").textContent).toBe(
      "settings.modelPicker.unsupported",
    );
  });

  it("hides the filters when there is nothing to filter", async () => {
    // Controls that can only produce an empty list are dead ends.
    listModelsMock = vi.fn(async () => ({ outcome: "unsupported", status: 404 }));
    const { overlay } = await open();

    expect(overlay.querySelector(".model-picker__filters").classList).toContain(
      "model-picker__filters--hidden",
    );
  });

  it("names a rejected credential as such", async () => {
    listModelsMock = vi.fn(async () => ({ outcome: "unauthorized", status: 401 }));
    const { overlay } = await open();

    expect(overlay.querySelector(".model-picker__note").textContent).toBe(
      "settings.modelPicker.unauthorized",
    );
  });

  it("surfaces the underlying message when the endpoint is unreachable", async () => {
    listModelsMock = vi.fn(async () => ({
      outcome: "unreachable",
      message: "connection refused",
    }));
    const { overlay } = await open();

    expect(overlay.querySelector(".model-picker__note").textContent).toContain(
      "connection refused",
    );
  });

  it("stays open and dismissable after a failure", async () => {
    // The user still has to get out of the dialog they opened.
    listModelsMock = vi.fn(async () => ({ outcome: "failed", status: 500 }));
    const { promise, overlay } = await open();

    expect(overlay).not.toBeNull();
    overlay.querySelector(".model-picker__cancel").click();
    await expect(promise).resolves.toBeNull();
  });

  it("reports a thrown error rather than spinning on 'loading'", async () => {
    listModelsMock = vi.fn(async () => {
      throw new Error("boom");
    });
    const { overlay } = await open();

    expect(overlay.querySelector(".model-picker__note").textContent).toContain("boom");
  });
});

describe("the request", () => {
  it("passes the configuration through unchanged, including an unsaved key", async () => {
    const { openModelPicker } = await import("./modelPickerDialog.js");
    const config = { provider: "openai", endpoint: "https://x/v1", apiKey: "sk-typed" };
    openModelPicker(config, {});
    await Promise.resolve();

    expect(listModelsMock.mock.calls[0][0]).toEqual(config);
  });

  it("aborts an in-flight listing when the dialog is dismissed", async () => {
    // A slow provider must not resolve into a dialog that is no longer there.
    const { promise, overlay } = await open();
    const signal = listModelsMock.mock.calls[0][1].signal;

    expect(signal.aborted).toBe(false);
    overlay.querySelector(".model-picker__cancel").click();
    await promise;

    expect(signal.aborted).toBe(true);
  });
});

describe("searching a provider whose listing is a sample", () => {
  /**
   * Open the picker against Replicate, whose browse listing is capped, so the
   * search box queries the provider instead of filtering what was loaded.
   */
  async function openReplicate() {
    const { openModelPicker } = await import("./modelPickerDialog.js");
    const promise = openModelPicker({ provider: "replicate", apiKey: "r8_test" }, {});
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    return { promise, overlay: document.querySelector(".modal-overlay") };
  }

  /** Type into the search box and let the debounce and its request settle. */
  async function type(overlay, value) {
    const input = overlay.querySelector(".model-picker__search");
    input.value = value;
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(400);
    await Promise.resolve();
    await Promise.resolve();
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks the provider instead of filtering the loaded sample", async () => {
    // The bug this fixes: the loaded page does not contain the model, so a
    // client-side filter reports "no matches" for a model that does exist.
    listModelsMock = vi.fn(async () => ({
      outcome: "ok",
      models: [model({ id: "lucataco/something-else", name: "lucataco/something-else" })],
      truncated: true,
    }));
    searchModelsMock = vi.fn(async () => ({
      outcome: "ok",
      models: [model({ id: "lucataco/deep-in-the-catalog", name: "lucataco/deep-in-the-catalog" })],
      truncated: false,
    }));

    const { overlay } = await openReplicate();
    await type(overlay, "deep");

    expect(searchModelsMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "replicate" }),
      "deep",
      expect.anything(),
    );
    const rows = [...overlay.querySelectorAll(".model-row")];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("deep-in-the-catalog");
  });

  it("sends one request for a burst of keystrokes", async () => {
    const { overlay } = await openReplicate();
    const input = overlay.querySelector(".model-picker__search");

    for (const value of ["q", "qw", "qwe", "qwen"]) {
      input.value = value;
      input.dispatchEvent(new Event("input"));
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(400);
    await Promise.resolve();

    expect(searchModelsMock).toHaveBeenCalledTimes(1);
    expect(searchModelsMock.mock.calls[0][1]).toBe("qwen");
  });

  it("restores the browse listing when the query is cleared", async () => {
    listModelsMock = vi.fn(async () => ({
      outcome: "ok",
      models: [model({ id: "lucataco/browsed", name: "lucataco/browsed" })],
      truncated: true,
    }));
    searchModelsMock = vi.fn(async () => ({
      outcome: "ok",
      models: [model({ id: "lucataco/searched", name: "lucataco/searched" })],
      truncated: false,
    }));

    const { overlay } = await openReplicate();
    await type(overlay, "searched");
    expect(overlay.querySelector(".model-row").textContent).toContain("searched");

    await type(overlay, "");
    expect(overlay.querySelector(".model-row").textContent).toContain("browsed");
    // Clearing must not cost a request; the listing is already in hand.
    expect(searchModelsMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the picker usable when the beta search endpoint fails", async () => {
    // The endpoint is in beta. If it goes away the picker must degrade to
    // filtering the loaded sample, not present an error instead of a list.
    listModelsMock = vi.fn(async () => ({
      outcome: "ok",
      models: [
        model({ id: "lucataco/qwen-vl", name: "lucataco/qwen-vl" }),
        model({ id: "lucataco/other", name: "lucataco/other" }),
      ],
      truncated: true,
    }));
    searchModelsMock = vi.fn(async () => ({ outcome: "unreachable", message: "down" }));

    const { overlay } = await openReplicate();
    await type(overlay, "qwen");

    const rows = [...overlay.querySelectorAll(".model-row")];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("qwen-vl");
    expect(overlay.querySelector(".model-picker__note").textContent).toContain("searchFailed");
  });

  it("does not re-filter searched results against the query text", async () => {
    // The provider ranked this hit on a description or tag the client never
    // sees. Re-running the local text filter would drop it.
    searchModelsMock = vi.fn(async () => ({
      outcome: "ok",
      models: [model({ id: "lucataco/handwriting-ocr", name: "lucataco/handwriting-ocr" })],
      truncated: false,
    }));

    const { overlay } = await openReplicate();
    await type(overlay, "transcribe notes");

    expect(overlay.querySelectorAll(".model-row")).toHaveLength(1);
  });

  it("does not claim the catalog is partial once it has been searched", async () => {
    // The browse warning says the list is a sample. After a search that is no
    // longer what is being shown, so repeating it would be false.
    listModelsMock = vi.fn(async () => ({ outcome: "ok", models: [model()], truncated: true }));
    searchModelsMock = vi.fn(async () => ({ outcome: "ok", models: [model()], truncated: false }));

    const { overlay } = await openReplicate();
    const note = overlay.querySelector(".model-picker__note");
    expect(note.textContent).toContain("truncated");

    await type(overlay, "qwen");
    expect(note.textContent).not.toContain("modelPicker.truncated");
    expect(note.textContent).toContain("searched");
  });

  it("ignores a slow reply overtaken by a later query", async () => {
    // Without sequencing, a slow "qw" landing after a fast "qwen3" leaves the
    // list showing neither what was typed nor what was asked for.
    const replies = {
      qw: { outcome: "ok", models: [model({ id: "stale", name: "stale" })], truncated: false },
      qwen3: { outcome: "ok", models: [model({ id: "fresh", name: "fresh" })], truncated: false },
    };
    let resolveSlow;
    searchModelsMock = vi.fn((_config, query) =>
      query === "qw"
        ? new Promise((r) => {
            resolveSlow = () => r(replies.qw);
          })
        : Promise.resolve(replies.qwen3),
    );

    const { overlay } = await openReplicate();
    const input = overlay.querySelector(".model-picker__search");

    input.value = "qw";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(400);

    await type(overlay, "qwen3");
    resolveSlow();
    await Promise.resolve();
    await Promise.resolve();

    expect(overlay.querySelector(".model-row").textContent).toContain("fresh");
  });

  it("filters locally for a provider whose listing arrives whole", async () => {
    vi.useRealTimers();
    listModelsMock = vi.fn(async () => ({
      outcome: "ok",
      models: [model({ id: "a/one", name: "a/one" }), model({ id: "b/two", name: "b/two" })],
      truncated: false,
    }));

    const { overlay } = await open();
    const input = overlay.querySelector(".model-picker__search");
    input.value = "two";
    input.dispatchEvent(new Event("input"));

    expect(searchModelsMock).not.toHaveBeenCalled();
    expect(overlay.querySelectorAll(".model-row")).toHaveLength(1);
  });
});

describe("a slow browse listing and a fast search", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not replace search results with the listing that arrives after them", async () => {
    // Not a narrow window: Replicate's browse listing pages through the catalog
    // (REPLICATE_MAX_PAGES sequential round trips) while a search is a single
    // one, so the search landing first is the expected ordering. The listing
    // used to render unconditionally on arrival, wiping out the results the
    // user had already typed for.
    let releaseListing;
    listModelsMock = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseListing = resolve;
        }),
    );
    searchModelsMock = vi.fn(async () => ({
      outcome: "ok",
      models: [model({ id: "lucataco/searched", name: "lucataco/searched" })],
      truncated: false,
    }));

    const { openModelPicker } = await import("./modelPickerDialog.js");
    openModelPicker({ provider: "replicate", apiKey: "r8_test" }, {});
    await Promise.resolve();
    const overlay = document.querySelector(".modal-overlay");

    // The user types while the listing is still in flight.
    const input = overlay.querySelector(".model-picker__search");
    input.value = "searched";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(400);
    await Promise.resolve();

    expect(overlay.querySelector(".model-row").textContent).toContain("searched");

    // Now the browse listing finally arrives.
    releaseListing({
      outcome: "ok",
      models: [model({ id: "lucataco/browsed", name: "lucataco/browsed" })],
      truncated: true,
    });
    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    await Promise.resolve();

    const rows = [...overlay.querySelectorAll(".model-row")];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("searched");
  });

  it("still restores the browse listing when the query is cleared afterwards", async () => {
    // The listing must still be recorded as the browse view even though it was
    // not rendered on arrival — otherwise clearing the box blanks the dialog.
    let releaseListing;
    listModelsMock = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseListing = resolve;
        }),
    );
    searchModelsMock = vi.fn(async () => ({
      outcome: "ok",
      models: [model({ id: "lucataco/searched", name: "lucataco/searched" })],
      truncated: false,
    }));

    const { openModelPicker } = await import("./modelPickerDialog.js");
    openModelPicker({ provider: "replicate", apiKey: "r8_test" }, {});
    await Promise.resolve();
    const overlay = document.querySelector(".modal-overlay");
    const input = overlay.querySelector(".model-picker__search");

    input.value = "searched";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(400);
    await Promise.resolve();

    releaseListing({
      outcome: "ok",
      models: [model({ id: "lucataco/browsed", name: "lucataco/browsed" })],
      truncated: true,
    });
    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();

    input.value = "";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(400);
    await Promise.resolve();

    expect(overlay.querySelector(".model-row").textContent).toContain("browsed");
  });
});
