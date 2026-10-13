/**
 * src/components/backupModals.test.js
 *
 * The backup password dialog is the one place a typo can silently produce an
 * unreadable archive, so what it refuses matters as much as what it returns.
 * The mode dialog decides how much choice the user faces and what the restore
 * planner receives.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../i18n/index.js", () => ({
  t: (key, opts) => (opts ? `${key}:${JSON.stringify(opts)}` : key),
}));

import {
  showBackupPasswordDialog,
  showReplaceAllBlockedDialog,
  showRestoreCompleteDialog,
  showRestoreConfirmDialog,
  showRestoreModeDialog,
  showRestorePasswordPrompt,
} from "./backupModals.js";

const flush = () => new Promise((r) => setTimeout(r, 250));
const overlay = () => document.getElementById("modal-overlay");
const type = (selector, value) => {
  const el = overlay().querySelector(selector);
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const click = (selector) => overlay().querySelector(selector).click();
const errorText = () => overlay().querySelector(".modal-error").textContent;

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("showBackupPasswordDialog", () => {
  const strong = "Tr0ub4dor&3-horse";

  it("returns the password once both fields agree", async () => {
    const result = showBackupPasswordDialog();
    type("#backup-password", strong);
    type("#backup-password-confirm", strong);
    click(".modal-confirm");
    await flush();
    expect(await result).toEqual({ password: strong });
    expect(overlay()).toBeNull();
  });

  it("offers no hint field: a helpful hint is a leak, and it would sit unencrypted in the archive", () => {
    showBackupPasswordDialog();
    expect(overlay().querySelector("#backup-password-hint")).toBeNull();
    expect(overlay().querySelectorAll("input")).toHaveLength(2);
  });

  it("refuses a mismatched confirm field and stays open", async () => {
    const result = showBackupPasswordDialog();
    type("#backup-password", strong);
    type("#backup-password-confirm", `${strong}x`);
    click(".modal-confirm");
    await flush();
    expect(errorText()).toBe("auth.errors.mismatch");
    expect(overlay()).not.toBeNull();
    click(".modal-cancel");
    expect(await result).toBeNull();
  });

  it("refuses short and weak passwords", async () => {
    const result = showBackupPasswordDialog();
    type("#backup-password", "short");
    type("#backup-password-confirm", "short");
    click(".modal-confirm");
    expect(errorText()).toBe("auth.errors.tooShort");

    type("#backup-password", "aaaaaaaa");
    type("#backup-password-confirm", "aaaaaaaa");
    click(".modal-confirm");
    expect(errorText()).toBe("auth.errors.tooWeak");

    // Would pass the master-password floor (30); the archive can be attacked
    // offline with a fixed, weak KDF, so the backup floor is higher.
    type("#backup-password", "abcdefghij");
    type("#backup-password-confirm", "abcdefghij");
    click(".modal-confirm");
    expect(errorText()).toBe("auth.errors.tooWeak");
    click(".modal-cancel");
    expect(await result).toBeNull();
  });

  it("shows the strength meter, the unrecoverable warning and the independence note", () => {
    showBackupPasswordDialog();
    expect(overlay().querySelector(".warning-box").innerHTML).toContain("backup.password.warning");
    expect(overlay().textContent).toContain("backup.password.independentNote");
    type("#backup-password", strong);
    expect(overlay().querySelector("#backup-strength-fill").style.width).not.toBe("");
    expect(overlay().querySelector("#backup-password").getAttribute("autocomplete")).toBe(
      "new-password",
    );
  });

  it("resolves null on Escape", async () => {
    const result = showBackupPasswordDialog();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await result).toBeNull();
  });
});

describe("showRestorePasswordPrompt", () => {
  it("re-prompts with an incorrect-password line and returns the new attempt", async () => {
    const result = showRestorePasswordPrompt({ wrong: true });
    expect(errorText()).toBe("backup.restore.wrongPassword");
    type("#restore-password", "second try");
    overlay()
      .querySelector("#restore-password")
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(await result).toBe("second try");
  });

  it("does not submit an empty password", async () => {
    const result = showRestorePasswordPrompt();
    click(".modal-confirm");
    await flush();
    expect(overlay()).not.toBeNull();
    click(".modal-cancel");
    expect(await result).toBeNull();
  });
});

describe("showRestoreConfirmDialog", () => {
  const manifest = { createdAt: 1, appVersion: "0.5.42" };

  it("asks one question on an empty device", async () => {
    const scan = { hasLocalData: false, counts: { notes: 340, notebooks: 12 } };
    const result = showRestoreConfirmDialog({ scan, manifest });
    expect(overlay().textContent).toContain(
      'backup.restore.confirmEmpty:{"notes":340,"notebooks":12}',
    );
    click(".modal-confirm");
    expect(await result).toBe(true);
  });

  it("says nothing will be replaced when local data exists without conflicts", async () => {
    const scan = { hasLocalData: true, counts: { notes: 3, notebooks: 1 } };
    const result = showRestoreConfirmDialog({ scan, manifest });
    expect(overlay().textContent).toContain("backup.restore.confirmNoConflicts");
    click(".modal-cancel");
    expect(await result).toBe(false);
  });
});

describe("showRestoreModeDialog", () => {
  const manifest = { createdAt: 1, appVersion: "0.5.42" };
  const scan = {
    counts: { conflicts: 2, localNewer: 1, backupNewer: 1, newNotes: 5, notes: 7, notebooks: 1 },
    conflicts: [
      {
        id: "a",
        title: "Alpha",
        backupNewer: true,
        local: { modified: 1 },
        backup: { modified: 2 },
      },
      {
        id: "b",
        title: "<i>Beta</i>",
        backupNewer: false,
        local: { modified: 3 },
        backup: { modified: 2 },
      },
    ],
  };

  it("pre-selects prefer-backup and defaults each decision to the newer side", async () => {
    const result = showRestoreModeDialog({ scan, manifest });
    expect(overlay().querySelector("input[name=restore-mode]:checked").value).toBe("preferBackup");
    click(".modal-confirm");
    expect(await result).toEqual({ mode: "preferBackup", decisions: { a: "backup", b: "local" } });
  });

  it("returns the chosen mode", async () => {
    const result = showRestoreModeDialog({ scan, manifest });
    const radio = overlay().querySelector("input[value=replaceAll]");
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
    click(".modal-confirm");
    expect((await result).mode).toBe("replaceAll");
  });

  it("review is only meaningful for prefer-backup", () => {
    showRestoreModeDialog({ scan, manifest });
    const review = () => overlay().querySelector("#restore-review-btn");
    expect(review().disabled).toBe(false);
    const radio = overlay().querySelector("input[value=missing]");
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
    expect(review().disabled).toBe(true);
  });

  it("lets the user flip individual notes and all at once in the review list", async () => {
    const result = showRestoreModeDialog({ scan, manifest });
    click("#restore-review-btn");
    const items = () => [...overlay().querySelectorAll(".restore-review__item")];
    expect(items()).toHaveLength(2);
    // Titles are escaped, never rendered as markup.
    expect(overlay().querySelector(".restore-review__title i")).toBeNull();
    expect(overlay().textContent).toContain("<i>Beta</i>");

    items()[0].querySelector('[data-choice="local"]').click();
    expect(items()[0].querySelector('[data-choice="local"]').getAttribute("aria-pressed")).toBe(
      "true",
    );

    click('[data-bulk="backup"]');
    expect(
      items().every(
        (i) => i.querySelector('[data-choice="backup"]').getAttribute("aria-pressed") === "true",
      ),
    ).toBe(true);

    click("#restore-back-btn");
    expect(overlay().querySelector("input[name=restore-mode]")).not.toBeNull();
    click(".modal-confirm");
    expect(await result).toEqual({ mode: "preferBackup", decisions: { a: "backup", b: "backup" } });
  });

  it("resolves null when cancelled", async () => {
    const result = showRestoreModeDialog({ scan, manifest });
    click(".modal-cancel");
    expect(await result).toBeNull();
  });
});

describe("showReplaceAllBlockedDialog", () => {
  it("offers the disconnect inline and reports the choice", async () => {
    const yes = showReplaceAllBlockedDialog();
    expect(overlay().textContent).toContain("backup.restore.replaceAllNcBlocked");
    click(".modal-confirm");
    expect(await yes).toBe(true);

    const no = showReplaceAllBlockedDialog();
    click(".modal-cancel");
    expect(await no).toBe(false);
  });
});

describe("showRestoreCompleteDialog", () => {
  const base = {
    total: 10,
    restored: 8,
    skipped: 2,
    replaced: 0,
    notebooksCreated: 1,
    notebooksRestored: 0,
    cancelled: false,
  };

  it("offers the recycle bin only when something was displaced, and opens it", async () => {
    const onOpenRecycleBin = vi.fn();
    const plain = showRestoreCompleteDialog(base, { onOpenRecycleBin });
    expect(overlay().querySelector("#restore-open-bin-btn")).toBeNull();
    click(".modal-confirm");
    await plain;

    const displaced = showRestoreCompleteDialog({ ...base, replaced: 3 }, { onOpenRecycleBin });
    expect(overlay().textContent).toContain("backup.done.restoreReplacedHint");
    click("#restore-open-bin-btn");
    await displaced;
    expect(onOpenRecycleBin).toHaveBeenCalledTimes(1);
  });

  it("explains a cancelled restore as resumable", async () => {
    const result = showRestoreCompleteDialog({ ...base, cancelled: true, restored: 4 });
    expect(overlay().querySelector(".modal-title").textContent).toBe(
      "backup.done.restoreCancelledTitle",
    );
    expect(overlay().textContent).toContain(
      'backup.done.restoreCancelledMsg:{"restored":4,"total":10}',
    );
    click(".modal-confirm");
    await result;
  });
});
