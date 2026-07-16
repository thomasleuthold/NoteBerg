/**
 * src/modules/encryptedCredentials.test.js
 * Thin wrapper over encryption.js/masterPassword.js/storage.js, but the
 * app-locked guard on every function is security-relevant: if it's ever
 * accidentally removed, credentials/notes become readable without unlocking.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const encryptObject = vi.fn();
const decryptObject = vi.fn();
vi.mock("./encryption.js", () => ({
  encryptObject: (...args) => encryptObject(...args),
  decryptObject: (...args) => decryptObject(...args),
}));

const getEncryptionKey = vi.fn();
const isAppUnlocked = vi.fn();
vi.mock("./masterPassword.js", () => ({
  getEncryptionKey: (...args) => getEncryptionKey(...args),
  isAppUnlocked: (...args) => isAppUnlocked(...args),
}));

const getSetting = vi.fn();
const setSetting = vi.fn();
vi.mock("./storage.js", () => ({
  getSetting: (...args) => getSetting(...args),
  setSetting: (...args) => setSetting(...args),
}));

import {
  deleteEncryptedNote,
  deleteNextcloudCredentials,
  getEncryptedNote,
  getNextcloudCredentials,
  hasNextcloudCredentials,
  saveEncryptedNote,
  saveNextcloudCredentials,
} from "./encryptedCredentials.js";

beforeEach(() => {
  vi.clearAllMocks();
  isAppUnlocked.mockReturnValue(true);
  getEncryptionKey.mockReturnValue({ type: "key" });
});

describe("app-locked guard", () => {
  it("saveNextcloudCredentials throws when locked, without touching storage", async () => {
    isAppUnlocked.mockReturnValue(false);
    await expect(saveNextcloudCredentials({ user: "a" })).rejects.toThrow("App is locked");
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("getNextcloudCredentials throws when locked, without reading storage", async () => {
    isAppUnlocked.mockReturnValue(false);
    await expect(getNextcloudCredentials()).rejects.toThrow("App is locked");
    expect(getSetting).not.toHaveBeenCalled();
  });

  it("deleteNextcloudCredentials throws when locked", async () => {
    isAppUnlocked.mockReturnValue(false);
    await expect(deleteNextcloudCredentials()).rejects.toThrow("App is locked");
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("saveEncryptedNote throws when locked", async () => {
    isAppUnlocked.mockReturnValue(false);
    await expect(saveEncryptedNote("n1", { a: 1 })).rejects.toThrow("App is locked");
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("getEncryptedNote throws when locked", async () => {
    isAppUnlocked.mockReturnValue(false);
    await expect(getEncryptedNote("n1")).rejects.toThrow("App is locked");
    expect(getSetting).not.toHaveBeenCalled();
  });

  it("deleteEncryptedNote throws when locked", async () => {
    isAppUnlocked.mockReturnValue(false);
    await expect(deleteEncryptedNote("n1")).rejects.toThrow("App is locked");
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("hasNextcloudCredentials does NOT require unlock (existence check only)", async () => {
    isAppUnlocked.mockReturnValue(false);
    getSetting.mockResolvedValue({ data: "x" });
    await expect(hasNextcloudCredentials()).resolves.toBe(true);
  });
});

describe("Nextcloud credentials round trip", () => {
  it("encrypts credentials with the current key and saves under the expected setting key", async () => {
    encryptObject.mockResolvedValue({ data: "enc", iv: "iv", version: 1 });
    await saveNextcloudCredentials({ user: "alice" });

    expect(encryptObject).toHaveBeenCalledWith({ user: "alice" }, { type: "key" });
    expect(setSetting).toHaveBeenCalledWith("encrypted_nextcloud_credentials", {
      data: "enc",
      iv: "iv",
      version: 1,
    });
  });

  it("returns null when no credentials are stored", async () => {
    getSetting.mockResolvedValue(null);
    const result = await getNextcloudCredentials();
    expect(result).toBeNull();
    expect(decryptObject).not.toHaveBeenCalled();
  });

  it("decrypts and returns stored credentials", async () => {
    getSetting.mockResolvedValue({ data: "enc", iv: "iv" });
    decryptObject.mockResolvedValue({ user: "alice" });

    const result = await getNextcloudCredentials();
    expect(result).toEqual({ user: "alice" });
  });

  it("propagates decryption errors (e.g. wrong key)", async () => {
    getSetting.mockResolvedValue({ data: "enc", iv: "iv" });
    decryptObject.mockRejectedValue(new Error("bad key"));
    await expect(getNextcloudCredentials()).rejects.toThrow("bad key");
  });

  it("deletes credentials by writing null", async () => {
    await deleteNextcloudCredentials();
    expect(setSetting).toHaveBeenCalledWith("encrypted_nextcloud_credentials", null);
  });
});

describe("hasNextcloudCredentials", () => {
  it("returns true when a stored value is present", async () => {
    getSetting.mockResolvedValue({ data: "enc" });
    expect(await hasNextcloudCredentials()).toBe(true);
  });

  it("returns false when nothing is stored", async () => {
    getSetting.mockResolvedValue(null);
    expect(await hasNextcloudCredentials()).toBe(false);
  });

  it("returns false (not throw) when storage read fails", async () => {
    getSetting.mockRejectedValue(new Error("db error"));
    expect(await hasNextcloudCredentials()).toBe(false);
  });
});

describe("encrypted note storage", () => {
  it("saves a note under a per-note setting key", async () => {
    encryptObject.mockResolvedValue({ data: "enc", iv: "iv" });
    await saveEncryptedNote("note-1", { title: "hi" });
    expect(setSetting).toHaveBeenCalledWith("encrypted_note_note-1", { data: "enc", iv: "iv" });
  });

  it("returns null for a note with nothing stored", async () => {
    getSetting.mockResolvedValue(null);
    expect(await getEncryptedNote("note-1")).toBeNull();
  });

  it("decrypts and returns stored note data", async () => {
    getSetting.mockResolvedValue({ data: "enc", iv: "iv" });
    decryptObject.mockResolvedValue({ title: "hi" });
    expect(await getEncryptedNote("note-1")).toEqual({ title: "hi" });
  });

  it("deletes a note by writing null under its per-note key", async () => {
    await deleteEncryptedNote("note-1");
    expect(setSetting).toHaveBeenCalledWith("encrypted_note_note-1", null);
  });
});
