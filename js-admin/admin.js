/**
 * Admin panel behaviour for the AI endpoint allowlist.
 *
 * A real script file rather than an inline <script>: Nextcloud serves admin
 * pages under a strict-dynamic CSP, so an inline block is blocked outright
 * unless it carries the request's nonce. Util::addScript() applies that nonce
 * for us, which is both simpler and harder to get wrong than reaching for the
 * nonce by hand.
 *
 * Not part of the Vite bundle: that build writes js/ and would wipe anything
 * hand-written there, and the app entry boots the whole note editor — far too
 * much to pull into a settings page holding one textarea.
 */
// The rule below assumes ES module semantics, where strict mode is automatic.
// This file is not a module: Util::addScript() emits a classic <script> for a
// .js file, and only the app's own entry gets module treatment because it
// resolves to .mjs. Without the directive this runs sloppy — an undeclared
// assignment would silently create a global rather than throwing.
//
// The rule's fix is marked "safe", so `biome check --write` strips the
// directive with no diagnostic in the output at all. Suppressed here rather
// than disabling the rule in biome.json, which would also stop it catching
// genuinely redundant directives in the module code under src/.
(function () {
  // biome-ignore lint/suspicious/noRedundantUseStrict: classic script, not a module — see above.
  "use strict";

  var textarea = document.getElementById("noteberg-allowed-endpoints");
  var replicate = document.getElementById("noteberg-allow-replicate");
  var saveBtn = document.getElementById("noteberg-admin-save");
  var status = document.getElementById("noteberg-admin-status");
  var summary = document.getElementById("noteberg-admin-current");

  if (!textarea || !saveBtn) return;

  function setStatus(text, isError) {
    status.textContent = text;
    // The "-text" variants, not --color-error/--color-success: those are NC's
    // pale badge-background tokens, and read as washed-out, low-contrast text
    // when used directly as a foreground color.
    status.style.color = isError ? "var(--color-error-text)" : "var(--color-success-text)";
  }

  /**
   * Bring the provider dropdown in line with the allowlist above.
   *
   * A provider the policy does not permit cannot run, so it is disabled rather
   * than silently selectable — the server would refuse the save, and an option
   * that fails after the fact is worse than one that is visibly unavailable.
   *
   * The stored provider is never removed, only labelled: a configuration made
   * before a policy change must stay visible rather than appear unset. That
   * mirrors what the per-user settings form does with a stored-but-no-longer-
   * permitted endpoint.
   *
   * @param {boolean} openAiUsable  at least one endpoint is listed
   * @param {boolean} replicateUsable  the Replicate switch is on
   */
  function syncProviderOptions(openAiUsable, replicateUsable) {
    var select = document.getElementById("noteberg-central-provider");
    if (!select) return;

    var usable = { openai: openAiUsable, replicate: replicateUsable };
    var labels = {
      openai: {
        ok: t("noteberg", "OpenAI-compatible"),
        no: t("noteberg", "OpenAI-compatible — no endpoints permitted yet"),
      },
      replicate: {
        ok: t("noteberg", "Replicate"),
        no: t("noteberg", "Replicate — not permitted above"),
      },
    };

    Array.prototype.forEach.call(select.options, function (option) {
      var which = option.getAttribute("data-requires");
      if (!which) return;
      var ok = !!usable[which];
      // The selected provider stays enabled even when no longer permitted, so
      // the form still round-trips what is actually stored. The save is what
      // refuses it, with a message naming the control at fault.
      option.disabled = !ok && !option.selected;
      option.textContent = ok ? labels[which].ok : labels[which].no;
    });
  }

  saveBtn.addEventListener("click", function () {
    saveBtn.disabled = true;
    setStatus(t("noteberg", "Saving…"), false);

    fetch(OC.generateUrl("/apps/noteberg/api/admin/endpoints"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "OCS-APIREQUEST": "true",
        requesttoken: OC.requestToken,
      },
      credentials: "same-origin",
      // Both controls travel together: the page saves one policy, and sending
      // half of it would let the stored state disagree with what is on screen.
      body: JSON.stringify({
        allowed_endpoints: textarea.value,
        allow_replicate: !!replicate?.checked,
      }),
    })
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, body: body };
        });
      })
      .then(function (r) {
        if (!r.ok) {
          setStatus(r.body?.error ? r.body.error : t("noteberg", "Could not save."), true);
          return;
        }

        // The Replicate switch counts alongside the listed endpoints: the line
        // this writes sits below both controls and summarises the whole policy.
        // Read from the server's reply rather than the checkbox, so it reports
        // what was actually stored.
        var n = (r.body.entries || []).length + (r.body.allowReplicate ? 1 : 0);
        summary.textContent =
          n === 0
            ? t("noteberg", "No endpoints permitted.")
            : n === 1
              ? t("noteberg", "1 endpoint permitted.")
              : t("noteberg", "{count} endpoints permitted.", { count: n });

        // The policy just changed, and the provider dropdown below is a view of
        // it: adding the first endpoint makes OpenAI-compatible selectable, and
        // clearing the list or the switch takes a provider away. Without this
        // the two halves of the page disagree until a reload, and an
        // administrator would reasonably read the stale dropdown as the truth.
        syncProviderOptions((r.body.entries || []).length > 0, !!r.body.allowReplicate);

        // Warnings are advisory: the save already happened. An admin may have a
        // reason to permit a link-local host, and the check cannot be complete
        // anyway — a name in a zone they control can resolve anywhere. Saying so
        // is more honest than refusing on a test that only catches the obvious
        // spelling.
        if (r.body.warnings?.length) {
          setStatus(r.body.warnings.join(" "), true);
        } else {
          setStatus(t("noteberg", "Saved."), false);
        }
      })
      .catch(function () {
        setStatus(t("noteberg", "Could not save."), true);
      })
      .then(function () {
        saveBtn.disabled = false;
      });
  });

  // ── Mode, central settings and the monthly cap ─────────────────────────────
  //
  // A second form on the same page, saved separately from the allowlist above:
  // the two answer different questions — what the server may reach, against who
  // pays and under what cap — and an administrator changes them at different
  // times. Combining them would mean every mode change re-submitted the
  // allowlist, and a partial save could leave the two disagreeing.

  var modeSave = document.getElementById("noteberg-mode-save");
  var modeStatus = document.getElementById("noteberg-mode-status");
  var centralFields = document.getElementById("noteberg-central-fields");
  var modeRadios = document.querySelectorAll('input[name="noteberg-ai-mode"]');

  function centralChosen() {
    // Array.prototype.forEach/some over a NodeList rather than an indexed loop:
    // `var` is function-scoped, so an index declared in a loop body leaks to the
    // whole function — and a callback registered inside such a loop closes over
    // the shared binding rather than the iteration's value.
    return Array.prototype.some.call(modeRadios, function (radio) {
      return radio.checked && radio.value === "central";
    });
  }

  // The `hidden` property rather than an inline style, matching how the server
  // renders the initial state. Mixing the two would leave a block that JS had
  // shown still carrying the attribute, or vice versa.
  Array.prototype.forEach.call(modeRadios, function (radio) {
    radio.addEventListener("change", function () {
      if (centralFields) centralFields.hidden = !centralChosen();
    });
  });

  // Replicate has no endpoint to choose: its host is compiled into the client
  // and filled in by the app. Showing the field would invite a value that is
  // never used. Mirrors the per-user settings form.
  var providerSelect = document.getElementById("noteberg-central-provider");
  var endpointRow = document.getElementById("noteberg-central-endpoint-row");

  if (providerSelect && endpointRow) {
    providerSelect.addEventListener("change", function () {
      endpointRow.hidden = providerSelect.value === "replicate";
    });
  }

  if (modeSave) {
    modeSave.addEventListener("click", function () {
      modeSave.disabled = true;
      modeStatus.textContent = t("noteberg", "Saving…");
      modeStatus.style.color = "";

      var key = document.getElementById("noteberg-central-key");
      var payload = {
        mode: centralChosen() ? "central" : "byo",
        monthlyLimit: Number(document.getElementById("noteberg-monthly-limit").value || 0),
        provider: document.getElementById("noteberg-central-provider").value,
        endpoint: document.getElementById("noteberg-central-endpoint").value,
        model: document.getElementById("noteberg-central-model").value,
        // Separate from the model, mirroring the client: Replicate builds the
        // request path from the two independently, so a community model
        // addressed by version would break if they were folded together.
        replicateVersion: document.getElementById("noteberg-central-version").value,
        language: document.getElementById("noteberg-central-language").value,
        // Sent even when empty — that is how an administrator clears a custom
        // prompt and goes back to the built-in default.
        systemPrompt: document.getElementById("noteberg-central-prompt").value,
        // Empty means "use the built-in default", which the server stores as 0
        // and the client reads back as a fallback. Number("") is 0, so an empty
        // field naturally carries that meaning without a special case.
        maxImageEdge: Number(document.getElementById("noteberg-central-image-edge").value || 0),
        maxTokens: Number(document.getElementById("noteberg-central-max-tokens").value || 0),
        timeoutSeconds: Number(document.getElementById("noteberg-central-timeout").value || 0),
      };
      // An untouched key field must not clear the stored one: the field is blank
      // whether or not a key is set, so sending "" would erase it on every save
      // that only changed the model.
      if (key?.value) payload.apiKey = key.value;

      fetch(OC.generateUrl("/apps/noteberg/api/admin/ai-mode"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "OCS-APIREQUEST": "true",
          requesttoken: OC.requestToken,
        },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      })
        .then(function (res) {
          return res.json().then(function (body) {
            return { ok: res.ok, body: body };
          });
        })
        .then(function (r) {
          if (!r.ok) {
            modeStatus.textContent =
              r.body?.error === "endpoint-not-permitted"
                ? t("noteberg", "That endpoint is not in the allowlist above.")
                : r.body?.error === "provider-not-permitted"
                  ? t("noteberg", "That provider is not permitted by the allowlist above.")
                  : t("noteberg", "Could not save.");
            modeStatus.style.color = "var(--color-error-text)";
            return;
          }
          // Clear the key field on success: leaving a secret in the DOM after it
          // has been stored serves nothing. The placeholder is server-rendered
          // from the stored key, so once a new one has been accepted it would
          // otherwise keep saying "Not set" until a reload — the field would
          // look empty in both senses right after being filled in. Only when a
          // key was actually sent: a save that changed the model alone leaves
          // the stored key, and its placeholder, exactly as they were.
          if (key) {
            if (payload.apiKey) key.placeholder = t("noteberg", "Configured — type to replace");
            key.value = "";
          }
          modeStatus.textContent = t("noteberg", "Saved.");
          modeStatus.style.color = "var(--color-success-text)";
        })
        .catch(function () {
          modeStatus.textContent = t("noteberg", "Could not save.");
          modeStatus.style.color = "var(--color-error-text)";
        })
        .then(function () {
          modeSave.disabled = false;
        });
    });
  }

  // ── AI usage ───────────────────────────────────────────────────────────────
  //
  // The table is server-rendered on load, so everything here is the month
  // picker: it swaps the body for another period's. Only this section reads
  // rather than writes, which is why it has no save button and no status line —
  // a failed fetch leaves the previous month on screen and says so in place of
  // the summary.

  var usagePeriod = document.getElementById("noteberg-usage-period");
  var usageRows = document.getElementById("noteberg-usage-rows");
  var usageSummary = document.getElementById("noteberg-usage-summary");
  var usageScroll = document.getElementById("noteberg-usage-scroll");

  /**
   * One row of the usage table.
   *
   * Built with createElement and textContent rather than an HTML string: a
   * display name is user-controlled text arriving from the server as JSON, and
   * innerHTML here would make the admin panel the place where one user's chosen
   * name runs as markup in another's browser. The server-rendered path escapes
   * through p() for the same reason.
   *
   * @param {{uid: string, displayName: string, units: number, deleted: boolean}} row
   */
  function usageRow(row) {
    var tr = document.createElement("tr");
    var dim = row.units === 0 ? "color:var(--color-text-maxcontrast);" : "";
    var cell = "padding:.5em .75em;border-top:1px solid var(--color-border);";
    var span;

    var name = document.createElement("td");
    name.setAttribute("style", cell + dim);
    name.textContent = row.displayName;

    // The uid alongside the name, which is not unique — mirrors usage-rows.php.
    var note = row.deleted ? t("noteberg", "deleted user") : row.uid;
    if (row.deleted || row.displayName !== row.uid) {
      span = document.createElement("span");
      span.setAttribute("style", "color:var(--color-text-maxcontrast);");
      span.textContent = ` (${note})`;
      name.appendChild(span);
    }

    var units = document.createElement("td");
    units.setAttribute("style", `${cell + dim}text-align:end;font-variant-numeric:tabular-nums;`);
    units.textContent = String(row.units);

    tr.appendChild(name);
    tr.appendChild(units);
    return tr;
  }

  function renderUsage(body) {
    var empty;
    var cell;

    usageRows.textContent = "";

    if (!body.rows.length) {
      empty = document.createElement("tr");
      cell = document.createElement("td");
      cell.colSpan = 2;
      cell.setAttribute("style", "padding:.75em;color:var(--color-text-maxcontrast);");
      cell.textContent = t("noteberg", "No users on this instance.");
      empty.appendChild(cell);
      usageRows.appendChild(empty);
    } else {
      body.rows.forEach(function (row) {
        usageRows.appendChild(usageRow(row));
      });
    }

    // Nothing here writes the month anywhere: the picker's own selection is
    // what names the period on screen, so the response's label is unused.

    // Mirrors usage-summary.php. The total is the period's, not the visible
    // rows', so a cut table still reports what was really spent.
    var summary =
      body.total === 1
        ? t("noteberg", "1 page sent this month.")
        : t("noteberg", "{count} pages sent this month.", { count: body.total });
    if (body.truncated) {
      summary +=
        " " +
        t("noteberg", "Showing the {shown} users with the most usage, of {total}.", {
          shown: body.rows.length,
          total: body.users,
        });
    }
    usageSummary.textContent = summary;

    // Back to the top: the previous month's scroll position means nothing in a
    // different month's list, and leaving it would open the new table part-way
    // down with its busiest users out of view.
    if (usageScroll) usageScroll.scrollTop = 0;
  }

  if (usagePeriod && usageRows && usageSummary) {
    usagePeriod.addEventListener("change", function () {
      // Disabled while in flight so a second change cannot land out of order:
      // two overlapping fetches would render whichever returned last, which is
      // not necessarily the month now selected.
      usagePeriod.disabled = true;

      fetch(
        OC.generateUrl("/apps/noteberg/api/admin/usage") +
          "?period=" +
          encodeURIComponent(usagePeriod.value),
        {
          headers: { "OCS-APIREQUEST": "true", requesttoken: OC.requestToken },
          credentials: "same-origin",
        },
      )
        .then(function (res) {
          if (!res.ok) throw new Error("usage");
          return res.json();
        })
        .then(renderUsage)
        .catch(function () {
          // The table still shows the previous month, so the message says the
          // load failed rather than implying the new month is empty — a table
          // of stale numbers under a new heading would be worse than an error.
          usageSummary.textContent = t("noteberg", "Could not load usage for that month.");
        })
        .then(function () {
          usagePeriod.disabled = false;
        });
    });
  }
})();
