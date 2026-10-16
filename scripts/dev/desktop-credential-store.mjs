#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { hasEncryptedCredentials } from "../build/bootstrap-env.mjs";

const require = createRequire(import.meta.url);
const KEY_NAME = "STORAGE_ENCRYPTION_KEY";
const KEYCHAIN_SERVICE = "OmniRoute Desktop";

function parseEnvFile(filePath) {
  if (!filePath || !existsSync(filePath)) return {};
  const result = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function resolveDataDir(env) {
  if (env.DATA_DIR?.trim()) return resolve(env.DATA_DIR.trim());
  if (process.platform === "win32") {
    return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "omniroute");
  }
  if (env.XDG_CONFIG_HOME?.trim()) return join(resolve(env.XDG_CONFIG_HOME.trim()), "omniroute");
  return join(homedir(), ".omniroute");
}

function getPreferredEnvFilePath(env) {
  const candidates = [];
  if (env.DATA_DIR?.trim()) candidates.push(join(resolve(env.DATA_DIR.trim()), ".env"));
  candidates.push(join(resolveDataDir(env), ".env"), join(process.cwd(), ".env"));
  return candidates.find((filePath) => existsSync(filePath)) || null;
}

function removePersistedKey(filePath, restrictPermissions = false) {
  if (!filePath || !existsSync(filePath)) return;
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Cannot safely migrate ${KEY_NAME} from a non-regular environment file.`);
  }
  const original = readFileSync(filePath, "utf8");
  const filtered = original
    .split(/\r?\n/)
    .filter((line) => !/^\s*STORAGE_ENCRYPTION_KEY\s*=/.test(line));
  const removedKey = filtered.length !== original.split(/\r?\n/).length;
  if (removedKey) {
    const ending = original.endsWith("\n") ? "\n" : "";
    const tempPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tempPath, `${filtered.join("\n")}${ending}`, {
        encoding: "utf8",
        mode: 0o600,
      });
      chmodSync(tempPath, 0o600);
      renameSync(tempPath, filePath);
    } catch (error) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Keep the original file and report the migration failure below.
      }
      throw error;
    }
  }
  if (restrictPermissions || removedKey) chmodSync(filePath, 0o600);
}

/** Load or migrate the local DB encryption key into the operating system keyring. */
export async function ensureDesktopStorageEncryptionKey() {
  let keytar;
  try {
    keytar = require("keytar");
  } catch {
    throw new Error(
      "OmniRoute needs the keytar native module and an unlocked OS credential store for the desktop launcher. Install the app dependencies and unlock GNOME Keyring/Secret Service, then reopen OmniRoute."
    );
  }
  if (typeof keytar.getPassword !== "function" || typeof keytar.setPassword !== "function") {
    throw new Error("OmniRoute could not use the operating system credential-store adapter.");
  }

  const preferredEnvPath = getPreferredEnvFilePath(process.env);
  const preferredEnv = parseEnvFile(preferredEnvPath);
  const dataDir = resolveDataDir({ ...preferredEnv, ...process.env });
  const serverEnvPath = join(dataDir, "server.env");
  const serverEnv = parseEnvFile(serverEnvPath);
  const account = `storage-encryption-key:${createHash("sha256").update(dataDir).digest("hex")}`;

  let keytarValue;
  try {
    keytarValue = await keytar.getPassword(KEYCHAIN_SERVICE, account);
  } catch {
    throw new Error(
      "OmniRoute cannot access the OS credential store. Unlock GNOME Keyring/Secret Service and reopen the desktop app."
    );
  }

  const candidates = [
    process.env[KEY_NAME],
    preferredEnv[KEY_NAME],
    serverEnv[KEY_NAME],
    keytarValue,
  ].filter((value) => typeof value === "string" && value.trim().length > 0);
  const normalizedCandidates = candidates.map((value) => value.trim());
  const distinctCandidates = new Set(normalizedCandidates);
  if (distinctCandidates.size > 1) {
    throw new Error(
      "OmniRoute found different database encryption keys in its configuration and OS credential store. Restore the matching key before starting to protect existing provider credentials."
    );
  }

  let storageKey = normalizedCandidates[0];
  if (!storageKey) {
    if (hasEncryptedCredentials(dataDir)) {
      throw new Error(
        "Encrypted provider credentials exist, but their database key is missing from the OS credential store and configuration. Restore the key from a backup before starting OmniRoute."
      );
    }
    storageKey = randomBytes(32).toString("hex");
  }

  if (!keytarValue) {
    try {
      await keytar.setPassword(KEYCHAIN_SERVICE, account, storageKey);
    } catch {
      throw new Error(
        "OmniRoute could not save its database key in the OS credential store. Unlock GNOME Keyring/Secret Service and retry."
      );
    }
  }

  process.env[KEY_NAME] = storageKey;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  removePersistedKey(serverEnvPath, true);
  if (preferredEnvPath !== serverEnvPath) removePersistedKey(preferredEnvPath);
  return { dataDir };
}

/** Record that the keyring migration and bootstrap decrypt-probe both passed. */
export function markDesktopCredentialStoreReady(dataDir) {
  const markerPath = join(dataDir, ".desktop-credential-store-v1");
  writeFileSync(markerPath, "ready\n", { encoding: "utf8", mode: 0o600 });
  chmodSync(markerPath, 0o600);
}
