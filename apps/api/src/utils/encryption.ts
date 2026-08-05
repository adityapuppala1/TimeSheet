/**
 * Field-level encryption at rest for admin-entered secrets stored in the database — the
 * IMAP mailbox password (EmailIntakeSettings.imapPassword) and, going forward, BYOK LLM
 * provider API keys (GlobalAISettings.apiKey). Both were previously stored as plain text,
 * the same tradeoff most of this app's "admin types in a credential" features accepted —
 * this closes that gap without changing the admin-facing UX at all (the value is still
 * masked as a boolean in every API response; only the storage layer changes).
 *
 * AES-256-GCM: authenticated encryption, so a tampered ciphertext fails to decrypt rather
 * than silently returning garbage. The key comes from `ENCRYPTION_KEY` (32 random bytes,
 * hex-encoded) — a single workspace-wide key is enough here since these are server-only
 * secrets the application itself needs to read back (unlike a password hash, which never
 * needs to be reversed), not a per-user encryption scheme.
 */
import crypto from "node:crypto";
import { env } from "../config/env.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // NIST-recommended IV length for GCM

function getKey(): Buffer {
  return Buffer.from(env.ENCRYPTION_KEY, "hex");
}

/** Encrypts a plaintext secret. Output format: `<iv>:<authTag>:<ciphertext>`, all hex. */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/** Reverses `encryptSecret`. Throws if the payload is malformed or the auth tag doesn't match (tampered/wrong key). */
export function decryptSecret(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 3) throw new Error("Malformed encrypted payload");
  const [ivHex, tagHex, dataHex] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]);
  return decrypted.toString("utf8");
}
