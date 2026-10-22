// Secret storage for DW-shorts (plan §5.5 / §6.3).
//
// Two environments share the dashboard code:
//   - Web (self-host / cloud): no OS keychain. Secrets are kept in
//     localStorage, XOR + base64 obfuscated (the app's historical behavior).
//   - Desktop (Electron): the main process exposes `window.dwSecrets`, backed
//     by Electron safeStorage (macOS Keychain / Windows DPAPI). We write there
//     AND keep an encrypted localStorage copy as a fast synchronous cache, so
//     the many components that read a key during render don't need to await.
//
// On first launch in the desktop app, migrateSecretsIfNeeded() copies any
// pre-existing localStorage secrets into the keychain so upgrading users keep
// their keys. Web behavior is byte-for-byte unchanged.

const SECRET_KEY =
  import.meta.env.VITE_ENCRYPTION_KEY || "OpenShorts-Static-Salt-Change-Me";
const ENCRYPTION_PREFIX = "ENC:";

// Storage keys that hold secrets (vs. plain preferences). Centralized so
// migration and the vault mirror stay consistent.
export const SECRET_KEYS = [
  "gemini_key",
  "uploadPostKey_v3",
  "elevenLabsKey_v1",
  "falKey_v1",
  "deepseekKey_v1",
  "fishAudioKey_v1",
];

// --- XOR + Base64 obfuscation (kept for the web fallback / cache) ---
export const encrypt = (text) => {
  if (!text) return "";
  try {
    const xor = text
      .split("")
      .map((c, i) =>
        String.fromCharCode(
          c.charCodeAt(0) ^ SECRET_KEY.charCodeAt(i % SECRET_KEY.length)
        )
      )
      .join("");
    return ENCRYPTION_PREFIX + btoa(xor);
  } catch (e) {
    console.error("Encryption failed", e);
    return text;
  }
};

export const decrypt = (text) => {
  if (!text) return "";
  if (text.startsWith(ENCRYPTION_PREFIX)) {
    try {
      const raw = text.slice(ENCRYPTION_PREFIX.length);
      const xor = atob(raw);
      const result = xor
        .split("")
        .map((c, i) =>
          String.fromCharCode(
            c.charCodeAt(0) ^ SECRET_KEY.charCodeAt(i % SECRET_KEY.length)
          )
        )
        .join("");
      return result;
    } catch (e) {
      return "";
    }
  }
  // Backward compatibility: unprefixed value (e.g. old plain gemini_key).
  return text;
};

// True when running inside the Electron shell with the keychain bridge.
export const isVault = () =>
  typeof window !== "undefined" && !!window.dwSecrets;

// Synchronous read for render-time use. In the desktop app the encrypted
// localStorage cache is always kept fresh by setSecret, so this is accurate.
export const getSecretSync = (key) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? decrypt(raw) : "";
  } catch {
    return "";
  }
};

// Async read: prefer the keychain when present, fall back to the cache.
export const getSecret = async (key) => {
  if (isVault()) {
    try {
      const v = await window.dwSecrets.get(key);
      if (v) return v;
    } catch {
      /* fall through to cache */
    }
  }
  return getSecretSync(key);
};

// Write a secret. Mirrors to the keychain (desktop) and the encrypted
// localStorage cache (both environments). Pass an empty value to clear.
export const setSecret = async (key, value) => {
  if (value) {
    if (isVault()) {
      try {
        await window.dwSecrets.set(key, value);
      } catch (e) {
        console.error("keychain write failed", e);
      }
    }
    try {
      localStorage.setItem(key, encrypt(value));
    } catch {
      /* private mode: keychain still holds it */
    }
  } else {
    if (isVault()) {
      try {
        await window.dwSecrets.del(key);
      } catch {
        /* ignore */
      }
    }
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
};

export const clearSecret = (key) => setSecret(key, "");

// Copy any localStorage secrets into the keychain once, so a user upgrading
// from the web build into the desktop app keeps their keys. No-op on web.
export const migrateSecretsIfNeeded = async () => {
  if (!isVault()) return;
  for (const key of SECRET_KEYS) {
    let raw = null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      continue;
    }
    if (!raw) continue;
    const decoded = decrypt(raw);
    if (!decoded) continue;
    try {
      const existing = await window.dwSecrets.get(key);
      if (!existing) await window.dwSecrets.set(key, decoded);
    } catch {
      /* leave the localStorage copy in place */
    }
  }
};
