/**
 * Model picker dialog.
 *
 * Turns the model listing every provider already exposes — the same request the
 * connection check makes — into something the user can choose from, instead of
 * a slug they have to find on a website and retype exactly.
 *
 * Two things it deliberately does *not* do:
 *
 *  - It does not replace the text field. The listing is not always complete
 *    (Replicate's is a sample; see modelCatalog.REPLICATE_MAX_PAGES) and not
 *    every server has one at all, so the field stays free text and this is a
 *    way to fill it in. A dropdown would have made an unlistable server
 *    unconfigurable.
 *  - It does not filter to vision models by default. Recognition needs one, but
 *    the type is only known where the provider describes it — OpenRouter does,
 *    Replicate and local servers do not — so defaulting to "vision only" would
 *    show an empty list for two providers out of three. The filter is offered,
 *    switched off, next to a count that says what it would hide.
 *
 * Typing means different things per provider, deliberately. Where the whole
 * listing is loaded, the search box filters it in the browser and that answer is
 * complete. Where it is a sample — Replicate — filtering the sample would report
 * "no matches" for a model the catalog does have, so the query goes to the
 * provider instead and the list is replaced by what it answers. The two are kept
 * behind one box because from the user's side it is one question; only the
 * status line below distinguishes them, and only because a searched result and a
 * filtered one are true of different populations.
 *
 * Model names and descriptions come from a remote server, so every one of them
 * is written with textContent rather than interpolated into innerHTML. The
 * static chrome is templated; the data never is.
 */

import { t } from "../i18n/index.js";
import {
  availableTypes,
  CAP_VISION,
  CATALOG_NOT_CONFIGURED,
  CATALOG_OK,
  CATALOG_UNAUTHORIZED,
  CATALOG_UNSUPPORTED,
  filterModels,
  listModels,
  searchModels,
  supportsServerSearch,
} from "../modules/recognition/modelCatalog.js";
import { getIcon } from "../utils/icons.js";

/**
 * How long to wait after a keystroke before searching the provider.
 *
 * Long enough that typing a model name is one request rather than twenty, short
 * enough that it still feels like the list is following the box.
 */
const SEARCH_DEBOUNCE_MS = 350;

/**
 * Message for an outcome that produced no list.
 *
 * Each one names what the user can do about it, because "failed" alone leaves
 * them re-pressing a button that cannot start working.
 *
 * @param {Object} result - from listModels()
 * @returns {string}
 */
function messageForOutcome(result) {
  switch (result.outcome) {
    case CATALOG_UNSUPPORTED:
      return t("settings.modelPicker.unsupported");
    case CATALOG_UNAUTHORIZED:
      return t("settings.modelPicker.unauthorized");
    case CATALOG_NOT_CONFIGURED:
      return t("settings.modelPicker.notConfigured");
    default:
      return t("settings.modelPicker.failed", {
        message: result.message || (result.status ? `HTTP ${result.status}` : ""),
      });
  }
}

/**
 * Build one row of the list.
 *
 * A <button> rather than a <div>: the row is a choice, and making it a real
 * button gets keyboard focus, Enter/Space activation and the accessible role
 * without reimplementing any of them.
 *
 * @param {Object} model - a catalog entry
 * @param {string} currentId - the model already configured, marked as such
 * @returns {HTMLButtonElement}
 */
function buildRow(model, currentId) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "model-row";
  row.dataset.modelId = model.id;
  if (model.id === currentId) row.classList.add("model-row--current");

  const header = document.createElement("div");
  header.className = "model-row__header";

  const name = document.createElement("span");
  name.className = "model-row__name";
  name.textContent = model.name;
  header.appendChild(name);

  const type = document.createElement("span");
  type.className = "model-row__type";
  type.textContent = t(`settings.modelPicker.types.${model.type}`);
  header.appendChild(type);

  row.appendChild(header);

  // The id is what actually goes into the field, so it is always shown — for
  // OpenRouter it differs from the display name, and picking by name alone
  // would leave the user unable to confirm what was stored.
  if (model.id !== model.name) {
    const id = document.createElement("code");
    id.className = "model-row__id";
    id.textContent = model.id;
    row.appendChild(id);
  }

  if (model.capabilities.length) {
    const caps = document.createElement("div");
    caps.className = "model-row__caps";
    for (const cap of model.capabilities) {
      const badge = document.createElement("span");
      // Vision is the capability recognition actually requires, so it is the one
      // badge that is coloured rather than neutral.
      badge.className = `model-badge${cap === CAP_VISION ? " model-badge--vision" : ""}`;
      badge.textContent = t(`settings.modelPicker.caps.${cap}`);
      caps.appendChild(badge);
    }
    row.appendChild(caps);
  }

  if (model.description) {
    const desc = document.createElement("p");
    desc.className = "model-row__desc";
    desc.textContent = model.description;
    row.appendChild(desc);
  }

  return row;
}

/**
 * Open the picker and resolve with the model the user chose.
 *
 * @param {Object} config - provider configuration, as getRecognitionConfig()
 *   returns it; may carry an unsaved endpoint/key the user just typed.
 * @param {{currentModel?: string}} [opts]
 * @returns {Promise<{id: string, version: string}|null>} null when dismissed
 */
export function openModelPicker(config, opts = {}) {
  return new Promise((resolve) => {
    const currentId = opts.currentModel || "";

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-dialog model-picker" role="dialog" aria-modal="true"
           aria-label="${t("settings.modelPicker.title")}">
        <div class="modal-header">
          <h3 class="modal-title">${t("settings.modelPicker.title")}</h3>
          <button class="modal-close" aria-label="${t("licenses.close")}">
            ${getIcon("x", 24)}
          </button>
        </div>
        <div class="modal-body">
          <div class="model-picker__filters">
            <input
              type="search"
              class="model-picker__search setting-control"
              autocomplete="off"
              spellcheck="false"
              placeholder="${t("settings.modelPicker.searchPlaceholder")}"
              aria-label="${t("settings.modelPicker.searchPlaceholder")}"
            />
            <select class="model-picker__type setting-control"
                    aria-label="${t("settings.modelPicker.typeFilter")}">
              <option value="">${t("settings.modelPicker.allTypes")}</option>
            </select>
            <label class="model-picker__vision">
              <input type="checkbox" class="model-picker__vision-only" />
              <span>${t("settings.modelPicker.visionOnly")}</span>
            </label>
          </div>
          <p class="model-picker__note" role="status"></p>
          <div class="model-picker__list"></div>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary model-picker__cancel">
            ${t("settings.modelPicker.cancel")}
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const searchInput = overlay.querySelector(".model-picker__search");
    const typeSelect = overlay.querySelector(".model-picker__type");
    const visionToggle = overlay.querySelector(".model-picker__vision-only");
    const filtersRow = overlay.querySelector(".model-picker__filters");
    const note = overlay.querySelector(".model-picker__note");
    const list = overlay.querySelector(".model-picker__list");

    let models = [];
    let truncated = false;
    let settled = false;
    // The listing loaded at open, kept so clearing the search box restores the
    // browse view without a second round trip.
    let browseModels = [];
    let browseTruncated = false;
    // Whether `models` came from a provider search rather than the listing.
    let searched = false;
    // Rises with every search dispatched; a reply carrying an older number is
    // discarded. Without it a slow request for "qw" can land after a fast one
    // for "qwen3-vl" and leave the list showing neither what was typed nor what
    // was asked for.
    let searchSeq = 0;
    let searchTimer = null;
    // Aborts an in-flight listing when the dialog closes, so a slow provider
    // cannot resolve into a dialog that is no longer on screen.
    const abort = new AbortController();

    const close = (result) => {
      if (settled) return;
      settled = true;
      abort.abort();
      // A keystroke just before closing would otherwise fire its search into a
      // dialog that is no longer on screen.
      clearTimeout(searchTimer);
      document.removeEventListener("keydown", keyHandler);
      overlay.remove();
      resolve(result);
    };

    const keyHandler = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(null);
    };
    document.addEventListener("keydown", keyHandler);

    overlay.querySelector(".modal-close")?.addEventListener("click", () => close(null));
    overlay.querySelector(".model-picker__cancel")?.addEventListener("click", () => close(null));

    // A drag that starts inside the dialog and ends on the overlay — selecting
    // a model id, most likely — must not be read as a click outside it.
    let mousedownOnOverlay = false;
    overlay.addEventListener("mousedown", (event) => {
      mousedownOnOverlay = event.target === overlay;
    });
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay && mousedownOnOverlay) close(null);
    });

    const setNote = (text) => {
      note.textContent = text;
    };

    /** Re-render the list for the current filter state. */
    const render = () => {
      // A server-searched list is already the answer to the query, so re-running
      // the text filter over it would be a second, stricter match the provider
      // did not make — dropping hits it ranked on a description or a tag this
      // side never saw. The type and vision filters still apply: those describe
      // the model, not the query.
      const visible = searched
        ? filterModels(models, { type: typeSelect.value, visionOnly: visionToggle.checked })
        : filterModels(models, {
            query: searchInput.value,
            type: typeSelect.value,
            visionOnly: visionToggle.checked,
          });

      list.replaceChildren();

      if (!visible.length) {
        const empty = document.createElement("p");
        empty.className = "model-picker__empty";
        empty.textContent = t("settings.modelPicker.noMatches");
        list.appendChild(empty);
      } else {
        const fragment = document.createDocumentFragment();
        for (const model of visible) fragment.appendChild(buildRow(model, currentId));
        list.appendChild(fragment);
      }

      const counted = t("settings.modelPicker.count", {
        shown: visible.length,
        total: models.length,
      });
      // The truncation warning travels with the count rather than appearing
      // once at load: it stays true while the user filters, and a filtered view
      // of a partial list is exactly where "why isn't my model here" happens.
      //
      // A searched list gets a different warning, because the browse one would
      // be false: these results came from the whole catalog, so "showing only
      // part of the catalog" is exactly what is no longer the case. What can
      // still be true is that the query matched more than one page of hits.
      const warning = searched
        ? truncated
          ? t("settings.modelPicker.searchTruncated")
          : t("settings.modelPicker.searched")
        : truncated
          ? t("settings.modelPicker.truncated")
          : "";
      setNote(warning ? `${counted} ${warning}` : counted);
    };

    // Choosing a row is what the dialog is for, so it resolves immediately —
    // there is no second confirmation step to get wrong. Delegated, so rows
    // rebuilt by the filter need no rebinding.
    list.addEventListener("click", (event) => {
      const row = event.target.closest(".model-row");
      if (!row) return;
      const model = models.find((candidate) => candidate.id === row.dataset.modelId);
      if (model) close({ id: model.id, version: model.version || "" });
    });

    // The box filters a loaded list for most providers and queries the catalog
    // for Replicate. Saying which it does is the difference between "my model
    // isn't in this list" and "my model isn't in this provider".
    if (supportsServerSearch(config)) {
      const placeholder = t("settings.modelPicker.searchAllPlaceholder");
      searchInput.placeholder = placeholder;
      searchInput.setAttribute("aria-label", placeholder);
    }

    setNote(t("settings.modelPicker.loading"));

    listModels(config, { signal: abort.signal })
      .then((result) => {
        if (settled) return;

        if (result.outcome !== CATALOG_OK) {
          // Nothing to filter, so the controls would only offer dead ends.
          filtersRow.classList.add("model-picker__filters--hidden");
          setNote(messageForOutcome(result));
          return;
        }

        models = result.models ?? [];
        truncated = !!result.truncated;
        browseModels = models;
        browseTruncated = truncated;

        for (const type of availableTypes(models)) {
          const option = document.createElement("option");
          option.value = type;
          option.textContent = t(`settings.modelPicker.types.${type}`);
          typeSelect.appendChild(option);
        }
        // A type filter with one entry filters nothing — every model would be in
        // it. That is the normal case for Replicate and local servers.
        if (typeSelect.options.length <= 2) typeSelect.classList.add("model-picker__hidden");
        // Same reasoning for the vision toggle: where no model declares its
        // modalities, ticking it empties the list and explains nothing.
        if (!models.some((model) => model.capabilities.includes(CAP_VISION))) {
          visionToggle.closest(".model-picker__vision")?.classList.add("model-picker__hidden");
        }

        // Only render the browse listing if it is still what the user is asking
        // to see. Where the listing is a paged sample it takes several sequential
        // round trips (modelCatalog.REPLICATE_MAX_PAGES) while a search is a
        // single one, so a search dispatched while this was in flight routinely
        // lands *first* — and rendering here would then replace the user's search
        // results with the full catalog they had already typed past.
        //
        // Tested on searchSeq rather than on `searched`, so a search that is
        // dispatched but not yet returned also holds this back: otherwise the
        // browse list flashes up only to be replaced a moment later.
        //
        // The filter controls and browseModels above are populated either way —
        // they describe the provider's catalog rather than the current query, and
        // clearing the search box has to restore a real browse view.
        if (searchSeq === 0) {
          render();
          searchInput.focus();
        }
      })
      .catch((err) => {
        if (settled) return;
        filtersRow.classList.add("model-picker__filters--hidden");
        setNote(t("settings.modelPicker.failed", { message: err?.message || String(err) }));
      });

    /**
     * Ask the provider about the current query, then show what it answers.
     *
     * Only reached for a provider whose listing is a sample. An empty box means
     * there is no query to ask about, so the browse listing comes back rather
     * than an empty result — clearing the search must restore the view it
     * replaced, not blank the dialog.
     */
    const runServerSearch = async () => {
      const query = searchInput.value.trim();
      const seq = ++searchSeq;

      if (!query) {
        models = browseModels;
        truncated = browseTruncated;
        searched = false;
        render();
        return;
      }

      setNote(t("settings.modelPicker.searching"));

      const result = await searchModels(config, query, { signal: abort.signal });
      // Closed while in flight, or overtaken by a later keystroke.
      if (settled || seq !== searchSeq) return;

      if (result.outcome !== CATALOG_OK) {
        // The search endpoint is in beta, so it failing must not take the picker
        // with it: fall back to filtering the listing already loaded. That is a
        // narrower answer than the user asked for, so it is labelled as one
        // rather than presented as the catalog's reply.
        models = browseModels;
        truncated = browseTruncated;
        searched = false;
        render();
        setNote(`${note.textContent} ${t("settings.modelPicker.searchFailed")}`);
        return;
      }

      models = result.models ?? [];
      truncated = !!result.truncated;
      searched = true;
      render();
    };

    // Debounced, because this one goes over the network on every keystroke.
    const onSearchInput = supportsServerSearch(config)
      ? () => {
          clearTimeout(searchTimer);
          searchTimer = setTimeout(runServerSearch, SEARCH_DEBOUNCE_MS);
        }
      : render;

    searchInput.addEventListener("input", onSearchInput);
    // Enter searches at once rather than waiting out the debounce, for the user
    // who typed a full model name and expects it to be looked up now.
    searchInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || !supportsServerSearch(config)) return;
      event.preventDefault();
      clearTimeout(searchTimer);
      runServerSearch();
    });
    typeSelect.addEventListener("change", render);
    visionToggle.addEventListener("change", render);
  });
}
