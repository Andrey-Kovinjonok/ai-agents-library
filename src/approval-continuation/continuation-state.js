import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { APPROVAL_CONTINUATION_PRODUCT } from "./config.js";

function agentsRootFrom(options = {}) {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  return path.resolve(
    options.agentsRoot
      ?? process.env.AGENTS_HOME
      ?? path.join(homeDir, ".agents"),
  );
}

export function continuationStateDirectory(options = {}) {
  return path.join(
    agentsRootFrom(options),
    "skills",
    APPROVAL_CONTINUATION_PRODUCT,
    "state",
    "continuation",
  );
}

export function continuationSessionKey(payload) {
  const value = ["session_id", "sessionId", "thread_id", "threadId"]
    .map((key) => payload?.[key])
    .find((candidate) => typeof candidate === "string" && candidate !== "");
  if (value === undefined) return null;
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function ensureStateDirectory(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const status = fs.lstatSync(directory);
    if (status.isSymbolicLink() || !status.isDirectory()) return false;
    return true;
  } catch {
    return false;
  }
}

/** Atomically claim one numbered continuation slot for a session. */
export function claimContinuation(payload, maximum, options = {}) {
  if (!Number.isSafeInteger(maximum) || maximum <= 0) return false;
  const sessionKey = continuationSessionKey(payload);
  if (sessionKey === null) return false;
  const directory = continuationStateDirectory(options);
  if (!ensureStateDirectory(directory)) return false;

  for (let slot = 0; slot < maximum; slot += 1) {
    const marker = path.join(directory, `${sessionKey}.${slot}.json`);
    let handle;
    try {
      handle = fs.openSync(marker, "wx", 0o600);
      fs.writeFileSync(handle, `${JSON.stringify({
        schemaVersion: 1,
        claimedAt: new Date().toISOString(),
        slot,
      })}\n`);
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      return true;
    } catch (error) {
      if (handle !== undefined) fs.closeSync(handle);
      if (error?.code !== "EEXIST") return false;
    }
  }
  return false;
}
