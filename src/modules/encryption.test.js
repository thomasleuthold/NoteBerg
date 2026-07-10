/**
 * src/modules/encryption.test.js
 * Exercises the real Web Crypto API (jsdom/Node provide crypto.subtle) rather
 * than mocking it, since this module's only job is to wrap PBKDF2/AES-GCM
 * correctly — mocking crypto would test nothing.
 */

import { describe, expect, it } from "vitest";
import {
  calculatePasswordStrength,
  decryptData,
  decryptObject,
  deriveKeyFromPassword,
  ENCRYPTION_CONFIG,
  encryptData,
  encryptObject,
  generateIV,
  generateSalt,
  getPasswordStrengthColor,
  getPasswordStrengthLabel,
  LEGACY_PBKDF2_ITERATIONS,
  testKey,
} from "./encryption.js";

describe("generateSalt / generateIV", () => {
  it("returns a 16-byte salt", () => {
    expect(generateSalt()).toBeInstanceOf(Uint8Array);
    expect(generateSalt().length).toBe(16);
  });

  it("returns a 12-byte IV", () => {
    expect(generateIV()).toBeInstanceOf(Uint8Array);
    expect(generateIV().length).toBe(12);
  });

  it("returns different values on each call", () => {
    const a = generateSalt();
    const b = generateSalt();
    expect(a).not.toEqual(b);
  });
});

describe("deriveKeyFromPassword", () => {
  it("derives a usable AES-GCM key", async () => {
    const salt = generateSalt();
    const key = await deriveKeyFromPassword("correct horse battery staple", salt);
    expect(key.algorithm.name).toBe("AES-GCM");
    expect(key.usages).toEqual(expect.arrayContaining(["encrypt", "decrypt"]));
  });

  it("derives the same key for the same password/salt/iterations", async () => {
    const salt = generateSalt();
    const keyA = await deriveKeyFromPassword("password", salt, 1000);
    const keyB = await deriveKeyFromPassword("password", salt, 1000);

    const plaintext = "same key check";
    const encrypted = await encryptData(plaintext, keyA);
    const decrypted = await decryptData(encrypted.data, encrypted.iv, keyB);
    expect(decrypted).toBe(plaintext);
  });

  it("derives a different key when the iteration count differs (legacy compatibility)", async () => {
    const salt = generateSalt();
    const keyDefault = await deriveKeyFromPassword("password", salt, LEGACY_PBKDF2_ITERATIONS);
    const keyOther = await deriveKeyFromPassword("password", salt, 1000);

    const encrypted = await encryptData("legacy check", keyDefault);
    await expect(decryptData(encrypted.data, encrypted.iv, keyOther)).rejects.toThrow();
  });

  it("uses the current PBKDF2_ITERATIONS default when none is passed", async () => {
    const salt = generateSalt();
    const withDefault = await deriveKeyFromPassword("password", salt);
    const withExplicit = await deriveKeyFromPassword(
      "password",
      salt,
      ENCRYPTION_CONFIG.PBKDF2_ITERATIONS,
    );

    const encrypted = await encryptData("default iterations check", withDefault);
    const decrypted = await decryptData(encrypted.data, encrypted.iv, withExplicit);
    expect(decrypted).toBe("default iterations check");
  });
});

describe("encryptData / decryptData", () => {
  it("round-trips a string", async () => {
    const key = await deriveKeyFromPassword("pw", generateSalt(), 1000);
    const encrypted = await encryptData("hello world", key);
    expect(await decryptData(encrypted.data, encrypted.iv, key)).toBe("hello world");
  });

  it("round-trips an object by stringifying it", async () => {
    const key = await deriveKeyFromPassword("pw", generateSalt(), 1000);
    const encrypted = await encryptData({ a: 1, b: "two" }, key);
    const decrypted = await decryptData(encrypted.data, encrypted.iv, key);
    expect(JSON.parse(decrypted)).toEqual({ a: 1, b: "two" });
  });

  it("produces a different ciphertext each time due to random IV", async () => {
    const key = await deriveKeyFromPassword("pw", generateSalt(), 1000);
    const first = await encryptData("same plaintext", key);
    const second = await encryptData("same plaintext", key);
    expect(first.data).not.toBe(second.data);
    expect(first.iv).not.toBe(second.iv);
  });

  it("fails to decrypt with the wrong key", async () => {
    const salt = generateSalt();
    const keyA = await deriveKeyFromPassword("pw-a", salt, 1000);
    const keyB = await deriveKeyFromPassword("pw-b", salt, 1000);
    const encrypted = await encryptData("secret", keyA);
    await expect(decryptData(encrypted.data, encrypted.iv, keyB)).rejects.toThrow(
      "Failed to decrypt data - incorrect password or corrupted data",
    );
  });

  it("fails to decrypt tampered ciphertext", async () => {
    const key = await deriveKeyFromPassword("pw", generateSalt(), 1000);
    const encrypted = await encryptData("secret", key);
    const tamperedBytes = atob(encrypted.data).split("");
    tamperedBytes[0] = tamperedBytes[0] === "A" ? "B" : "A";
    const tamperedData = btoa(tamperedBytes.join(""));

    await expect(decryptData(tamperedData, encrypted.iv, key)).rejects.toThrow();
  });
});

describe("encryptObject / decryptObject", () => {
  it("round-trips an object and stamps version 1", async () => {
    const key = await deriveKeyFromPassword("pw", generateSalt(), 1000);
    const encrypted = await encryptObject({ foo: "bar", n: 42 }, key);
    expect(encrypted.version).toBe(1);
    expect(await decryptObject(encrypted, key)).toEqual({ foo: "bar", n: 42 });
  });
});

describe("testKey", () => {
  it("returns true for a valid key", async () => {
    const key = await deriveKeyFromPassword("pw", generateSalt(), 1000);
    expect(await testKey(key)).toBe(true);
  });

  it("returns false for a non-key value instead of throwing", async () => {
    expect(await testKey(null)).toBe(false);
  });
});

describe("calculatePasswordStrength", () => {
  it("returns 0 for an empty password", () => {
    expect(calculatePasswordStrength("")).toBe(0);
    expect(calculatePasswordStrength(undefined)).toBe(0);
  });

  it("scores a long mixed-character password as strong", () => {
    expect(calculatePasswordStrength("Tr0ub4dor&3xtraLong!")).toBeGreaterThanOrEqual(80);
  });

  it("penalizes all-numeric passwords", () => {
    const allNumbers = calculatePasswordStrength("123456789012");
    const mixed = calculatePasswordStrength("abc123XYZ!@#");
    expect(allNumbers).toBeLessThan(mixed);
  });

  it("penalizes all-letter passwords", () => {
    const allLetters = calculatePasswordStrength("abcdefghijkl");
    const mixed = calculatePasswordStrength("abc123XYZ!@#");
    expect(allLetters).toBeLessThan(mixed);
  });

  it("penalizes repeated characters", () => {
    const repeated = calculatePasswordStrength("aaaAAA1!");
    const varied = calculatePasswordStrength("qpzXYZ1!");
    expect(repeated).toBeLessThan(varied);
  });

  it("never returns below 0 or above 100", () => {
    expect(calculatePasswordStrength("a")).toBeGreaterThanOrEqual(0);
    expect(calculatePasswordStrength("a".repeat(200))).toBeLessThanOrEqual(100);
  });
});

describe("getPasswordStrengthLabel", () => {
  it("labels bands correctly", () => {
    expect(getPasswordStrengthLabel(0)).toBe("Weak");
    expect(getPasswordStrengthLabel(29)).toBe("Weak");
    expect(getPasswordStrengthLabel(30)).toBe("Fair");
    expect(getPasswordStrengthLabel(59)).toBe("Fair");
    expect(getPasswordStrengthLabel(60)).toBe("Good");
    expect(getPasswordStrengthLabel(79)).toBe("Good");
    expect(getPasswordStrengthLabel(80)).toBe("Strong");
    expect(getPasswordStrengthLabel(100)).toBe("Strong");
  });
});

describe("getPasswordStrengthColor", () => {
  it("maps bands to colors matching the label bands", () => {
    expect(getPasswordStrengthColor(0)).toBe("#ef4444");
    expect(getPasswordStrengthColor(30)).toBe("#f59e0b");
    expect(getPasswordStrengthColor(60)).toBe("#eab308");
    expect(getPasswordStrengthColor(80)).toBe("#22c55e");
  });
});

describe("ENCRYPTION_CONFIG", () => {
  it("exposes the expected constants", () => {
    expect(ENCRYPTION_CONFIG).toMatchObject({
      SALT_LENGTH: 16,
      IV_LENGTH: 12,
      KEY_LENGTH: 256,
      ALGORITHM: "AES-GCM",
      KEY_DERIVATION: "PBKDF2",
      HASH: "SHA-256",
      VERSION: 1,
    });
  });
});
