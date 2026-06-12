/**
 * src/modules/masterPassword.test.js
 * PBKDF2 iteration-count compatibility: new setups use the current (raised)
 * iteration default, while unlock derives the key with the count stored in the
 * user's encryption_config — otherwise existing users could never unlock again.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./encryption.js", () => ({
  ENCRYPTION_CONFIG: { PBKDF2_ITERATIONS: 600000 },
  LEGACY_PBKDF2_ITERATIONS: 100000,
  deriveKeyFromPassword: vi.fn().mockResolvedValue({ type: "secret" }),
  encryptData: vi.fn().mockResolvedValue({ data: "enc", iv: "iv" }),
  decryptData: vi.fn().mockResolvedValue("master_password_verification"),
  generateSalt: vi.fn(() => new Uint8Array(16)),
}));

vi.mock("./secureStorage.js", () => ({
  saveSecureCredential: vi.fn().mockResolvedValue(undefined),
  getSecureCredential: vi.fn().mockResolvedValue(null),
}));

const settings = new Map();
vi.mock("./storage.js", () => ({
  getSetting: vi.fn((key) => Promise.resolve(settings.get(key) ?? null)),
  setSetting: vi.fn((key, value) => {
    settings.set(key, value);
    return Promise.resolve();
  }),
}));

import { deriveKeyFromPassword } from "./encryption.js";
import { lockApp, setupMasterPassword, unlockApp } from "./masterPassword.js";

const SALT_B64 = btoa(String.fromCharCode(...new Uint8Array(16)));

beforeEach(() => {
  settings.clear();
  vi.clearAllMocks();
  lockApp();
});

describe("setupMasterPassword", () => {
  it("stores the current (raised) iteration count in the config", async () => {
    await setupMasterPassword("correct horse battery");

    const config = settings.get("encryption_config");
    expect(config.iterations).toBe(600000);
  });
});

describe("unlockApp iteration compatibility", () => {
  it("derives the key with the iteration count stored in the config", async () => {
    settings.set("encryption_config", { version: 1, salt: SALT_B64, iterations: 100000 });
    settings.set("password_test", { data: "enc", iv: "iv" });

    const ok = await unlockApp("pw");

    expect(ok).toBe(true);
    expect(deriveKeyFromPassword).toHaveBeenCalledWith("pw", expect.anything(), 100000);
  });

  it("falls back to the legacy count when the config has no iterations field", async () => {
    settings.set("encryption_config", { version: 1, salt: SALT_B64 });
    settings.set("password_test", { data: "enc", iv: "iv" });

    await unlockApp("pw");

    expect(deriveKeyFromPassword).toHaveBeenCalledWith("pw", expect.anything(), 100000);
  });

  it("uses the raised count for configs created by new setups", async () => {
    settings.set("encryption_config", { version: 1, salt: SALT_B64, iterations: 600000 });
    settings.set("password_test", { data: "enc", iv: "iv" });

    await unlockApp("pw");

    expect(deriveKeyFromPassword).toHaveBeenCalledWith("pw", expect.anything(), 600000);
  });
});
