/**
 * src/modules/secureStorage.test.js
 *
 * secureStorage.js branches on environment (Tauri desktop / Tauri Android /
 * plain browser) and caches migration-done flags + a derived legacy key at
 * module scope. Each test uses vi.resetModules() + a fresh dynamic import so
 * that env detection and module-level caches don't leak between cases.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args) => invokeMock(...args),
}));

async function freshModule() {
  vi.resetModules();
  return import("./secureStorage.js");
}

function setTauriEnv(isTauri) {
  if (isTauri) {
    window.__TAURI_INTERNALS__ = {};
  } else {
    delete window.__TAURI_INTERNALS__;
    delete window.__TAURI__;
  }
}

function setUserAgent(ua) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: ua,
    configurable: true,
  });
}

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  setTauriEnv(false);
  setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
});

afterEach(() => {
  setTauriEnv(false);
  setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
});

describe("browser fallback (no Tauri)", () => {
  it("round-trips a credential via encrypted localStorage", async () => {
    const { saveSecureCredential, getSecureCredential } = await freshModule();
    await saveSecureCredential("master_password", "s3cret");
    expect(await getSecureCredential("master_password")).toBe("s3cret");
  });

  it("stores the value encrypted, not in plaintext", async () => {
    const { saveSecureCredential } = await freshModule();
    await saveSecureCredential("master_password", "s3cret");
    const raw = localStorage.getItem("secure_master_password");
    expect(raw).not.toBe("s3cret");
    expect(raw).toBeTruthy();
  });

  it("returns null for a credential that was never saved", async () => {
    const { getSecureCredential } = await freshModule();
    expect(await getSecureCredential("nextcloud_credentials")).toBeNull();
  });

  it("deletes a credential", async () => {
    const { saveSecureCredential, getSecureCredential, deleteSecureCredential } =
      await freshModule();
    await saveSecureCredential("master_password", "s3cret");
    await deleteSecureCredential("master_password");
    expect(await getSecureCredential("master_password")).toBeNull();
  });

  it("does not call Tauri invoke in browser mode", async () => {
    const { saveSecureCredential, getSecureCredential } = await freshModule();
    await saveSecureCredential("master_password", "s3cret");
    await getSecureCredential("master_password");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("desktop path (Tauri, non-Android)", () => {
  beforeEach(() => setTauriEnv(true));

  it("saves via the save_credential command", async () => {
    invokeMock.mockResolvedValue(undefined);
    const { saveSecureCredential } = await freshModule();
    await saveSecureCredential("master_password", "s3cret");
    expect(invokeMock).toHaveBeenCalledWith("save_credential", {
      key: "master_password",
      value: "s3cret",
    });
  });

  it("gets via the get_credential command", async () => {
    invokeMock.mockResolvedValue("s3cret");
    const { getSecureCredential } = await freshModule();
    const result = await getSecureCredential("master_password");
    expect(invokeMock).toHaveBeenCalledWith("get_credential", { key: "master_password" });
    expect(result).toBe("s3cret");
  });

  it("deletes via the delete_credential command", async () => {
    invokeMock.mockResolvedValue(undefined);
    const { deleteSecureCredential } = await freshModule();
    await deleteSecureCredential("master_password");
    expect(invokeMock).toHaveBeenCalledWith("delete_credential", { key: "master_password" });
  });

  it("returns null instead of throwing when the keychain read fails", async () => {
    invokeMock.mockRejectedValue(new Error("keychain unavailable"));
    const { getSecureCredential } = await freshModule();
    await expect(getSecureCredential("master_password")).resolves.toBeNull();
  });

  it("migrates a legacy localStorage secret into the OS keychain on first read", async () => {
    // Seed a legacy-encrypted secret using the browser fallback first.
    setTauriEnv(false);
    const browserModule = await freshModule();
    await browserModule.saveSecureCredential("master_password", "legacy-secret");

    // Now switch to desktop/Tauri mode with the same localStorage state.
    setTauriEnv(true);
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "get_credential") return Promise.resolve(null); // nothing in keychain yet
      if (cmd === "save_credential") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });
    const desktopModule = await freshModule();
    await desktopModule.getSecureCredential("master_password");

    expect(invokeMock).toHaveBeenCalledWith("save_credential", {
      key: "master_password",
      value: "legacy-secret",
    });
    // Old localStorage entries are cleared once migration completes.
    expect(localStorage.getItem("secure_master_password")).toBeNull();
  });

  it("does not touch localStorage-based legacy secrets once already in the keychain", async () => {
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "get_credential") return Promise.resolve("already-there");
      return Promise.resolve(undefined);
    });
    const { getSecureCredential } = await freshModule();
    const result = await getSecureCredential("master_password");
    expect(result).toBe("already-there");
    expect(invokeMock).not.toHaveBeenCalledWith("save_credential", expect.anything());
  });
});

describe("Android path (Tauri + Android user agent)", () => {
  beforeEach(() => {
    setTauriEnv(true);
    setUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8)");
  });

  it("saves via the save_credential command (DeviceKeyPlugin)", async () => {
    invokeMock.mockImplementation((cmd) => {
      if (cmd === "get_credential") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });
    const { saveSecureCredential } = await freshModule();
    await saveSecureCredential("nextcloud_credentials", "androidsecret");
    expect(invokeMock).toHaveBeenCalledWith("save_credential", {
      key: "nextcloud_credentials",
      value: "androidsecret",
    });
  });

  it("gets via the get_credential command", async () => {
    invokeMock.mockResolvedValue("androidsecret");
    const { getSecureCredential } = await freshModule();
    const result = await getSecureCredential("nextcloud_credentials");
    expect(result).toBe("androidsecret");
  });

  it("deletes via the delete_credential command directly, without migration", async () => {
    invokeMock.mockResolvedValue(undefined);
    const { deleteSecureCredential } = await freshModule();
    await deleteSecureCredential("nextcloud_credentials");
    expect(invokeMock).toHaveBeenCalledWith("delete_credential", { key: "nextcloud_credentials" });
  });
});
