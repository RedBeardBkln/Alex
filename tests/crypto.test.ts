import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, encrypt, sha256Hex } from "@/lib/crypto";

const key = randomBytes(32).toString("base64");

describe("crypto", () => {
  it("round-trips", () => {
    const secret = "ya29.a0-example-token";
    const enc = encrypt(secret, key);
    expect(enc).not.toContain(secret);
    expect(decrypt(enc, key)).toBe(secret);
  });

  it("uses a fresh IV each time", () => {
    expect(encrypt("x", key)).not.toBe(encrypt("x", key));
  });

  it("rejects a wrong key", () => {
    const enc = encrypt("secret", key);
    expect(() => decrypt(enc, randomBytes(32).toString("base64"))).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    const [v, iv, tag, ct] = encrypt("secret", key).split(".");
    const flipped = Buffer.from(ct!, "base64url");
    flipped[0]! ^= 1;
    expect(() => decrypt([v, iv, tag, flipped.toString("base64url")].join("."), key)).toThrow();
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => encrypt("x", randomBytes(16).toString("base64"))).toThrow();
  });

  it("hashes deterministically", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
