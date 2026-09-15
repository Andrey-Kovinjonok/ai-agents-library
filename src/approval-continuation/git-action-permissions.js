import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SCHEMA_VERSION = 1;
const DEFAULT_TTL_MILLISECONDS = 10 * 60 * 1000;
const MAX_STATE_BYTES = 32_768;
const ALLOWED_KINDS = new Set(["commit", "push", "rollback", "noverify"]);
const LOCK_WAIT_MILLISECONDS = 1_000;
const LOCK_POLL_MILLISECONDS = 5;
const LOCK_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function gitValue(cwd, ...args) {
  try {
    const value = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    return value || null;
  } catch {
    return null;
  }
}

function canonicalWhenPresent(value) {
  const absolute = path.resolve(value);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function commonGitDirectory(cwd) {
  let value = gitValue(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (value === null) {
    value = gitValue(cwd, "rev-parse", "--git-common-dir");
    if (value !== null && !path.isAbsolute(value)) value = path.join(cwd, value);
  }
  return value === null ? null : canonicalWhenPresent(value);
}

function worktreeRoot(cwd) {
  const value = gitValue(cwd, "rev-parse", "--show-toplevel");
  return value === null ? null : canonicalWhenPresent(value);
}

function currentTarget(cwd) {
  const branch = gitValue(cwd, "symbolic-ref", "--quiet", "--short", "HEAD");
  const head = gitValue(cwd, "rev-parse", "--verify", "HEAD");
  const branchRef = branch === null ? null : `refs/heads/${branch}`;
  const branchOid = branchRef === null
    ? null
    : gitValue(cwd, "rev-parse", "--verify", branchRef);
  return {
    worktree: worktreeRoot(cwd),
    branch,
    head,
    branchRef,
    branchOid,
  };
}

function normalizedEvent(event = {}) {
  return {
    sessionId: typeof event.sessionId === "string" && event.sessionId !== ""
      ? event.sessionId
      : "legacy-session",
    turnId: typeof event.turnId === "string" && event.turnId !== ""
      ? event.turnId
      : "legacy-turn",
    toolUseId: typeof event.toolUseId === "string" ? event.toolUseId : "",
  };
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function validateKind(kind) {
  if (!ALLOWED_KINDS.has(kind)) throw new TypeError(`Unsupported Git action kind: ${kind}`);
}

function statePath({ kind, repository, sessionId, stateDirectory }) {
  const repositoryKey = repository === null ? "pending" : digest(repository);
  return path.join(
    stateDirectory,
    `.agent-git-permission.${kind}.${digest(sessionId)}.${repositoryKey}.json`,
  );
}

function removeFile(file) {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(5).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function withStateLock(file, action) {
  const lockFile = `${file}.lock`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MILLISECONDS;
  let handle;
  while (handle === undefined) {
    try {
      handle = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(handle, `${process.pid}\n`);
      fs.fsyncSync(handle);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const status = fs.lstatSync(lockFile);
        if (status.isSymbolicLink() || !status.isFile()) return { locked: true, value: null };
        const owner = Number(fs.readFileSync(lockFile, "utf8").trim());
        if (!Number.isSafeInteger(owner) || owner <= 0) return { locked: true, value: null };
        try {
          process.kill(owner, 0);
        } catch (ownerError) {
          if (ownerError?.code !== "ESRCH") return { locked: true, value: null };
          removeFile(lockFile);
          continue;
        }
      } catch (readError) {
        if (readError?.code === "ENOENT") continue;
        return { locked: true, value: null };
      }
      if (Date.now() >= deadline) return { locked: true, value: null };
      Atomics.wait(LOCK_SLEEP_BUFFER, 0, 0, LOCK_POLL_MILLISECONDS);
    }
  }
  try {
    return { locked: false, value: action() };
  } finally {
    fs.closeSync(handle);
    removeFile(lockFile);
  }
}

function readFresh(file, ttlMilliseconds, now) {
  try {
    const status = fs.lstatSync(file);
    if (status.isSymbolicLink() || !status.isFile() || status.size > MAX_STATE_BYTES) {
      removeFile(file);
      return null;
    }
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || value.version !== SCHEMA_VERSION
      || typeof value.createdAt !== "number"
      || now - value.createdAt > ttlMilliseconds
    ) {
      removeFile(file);
      return null;
    }
    return value;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      try { removeFile(file); } catch { /* Fail closed below. */ }
    }
    return null;
  }
}

function sameBoundTarget(bound, current) {
  return bound.worktree === current.worktree && bound.branch === current.branch;
}

function targetAdvanced(before, after) {
  if (!sameBoundTarget(before, after)) return false;
  if (before.branchRef !== null) {
    return before.branchRef === after.branchRef && before.branchOid !== after.branchOid;
  }
  return before.head !== after.head;
}

function optionsWithDefaults(options) {
  return {
    ...options,
    stateDirectory: canonicalWhenPresent(options.stateDirectory ?? os.tmpdir()),
    ttlMilliseconds: options.ttlMilliseconds ?? DEFAULT_TTL_MILLISECONDS,
    now: options.now ?? Date.now(),
  };
}

export function createGitActionPermission(rawOptions) {
  const options = optionsWithDefaults(rawOptions);
  validateKind(options.kind);
  const event = normalizedEvent(options.event);
  const repository = commonGitDirectory(options.cwd);
  const file = statePath({
    kind: options.kind,
    repository,
    sessionId: event.sessionId,
    stateDirectory: options.stateDirectory,
  });
  const result = withStateLock(file, () => {
    atomicJson(file, {
      version: SCHEMA_VERSION,
      kind: options.kind,
      sessionId: event.sessionId,
      turnId: event.turnId,
      createdAt: options.now,
      state: "ready",
      repository,
    });
    return file;
  });
  if (result.locked) throw new Error(`Git permission state is busy: ${file}`);
  return result.value;
}

export function beginGitActionPermission(rawOptions) {
  const options = optionsWithDefaults(rawOptions);
  validateKind(options.kind);
  const event = normalizedEvent(options.event);
  const repository = commonGitDirectory(options.cwd);
  const exact = statePath({
    kind: options.kind, repository, sessionId: event.sessionId,
    stateDirectory: options.stateDirectory,
  });
  const pending = statePath({
    kind: options.kind, repository: null, sessionId: event.sessionId,
    stateDirectory: options.stateDirectory,
  });
  const candidates = exact === pending ? [exact] : [exact, pending];

  for (const source of candidates) {
    const locked = withStateLock(source, () => {
      const state = readFresh(source, options.ttlMilliseconds, options.now);
      if (state === null || state.sessionId !== event.sessionId) return "missing";
      if (state.repository !== null && state.repository !== repository) return "missing";
      const current = currentTarget(options.cwd);
      if (state.target !== undefined) {
        if (!sameBoundTarget(state.target, current)) return "denied";
        if (state.state === "attempting") {
          if (targetAdvanced(state.target, current)) removeFile(source);
          return "denied";
        }
      }

      const destination = statePath({
        kind: options.kind, repository, sessionId: event.sessionId,
        stateDirectory: options.stateDirectory,
      });
      atomicJson(destination, {
        ...state,
        state: "attempting",
        repository,
        target: { ...current, toolUseId: event.toolUseId },
      });
      if (destination !== source) removeFile(source);
      return "allowed";
    });
    if (locked.locked || locked.value === "denied") return false;
    if (locked.value === "allowed") return true;
  }
  return false;
}

export function finishGitActionPermission(rawOptions) {
  const options = optionsWithDefaults(rawOptions);
  validateKind(options.kind);
  const event = normalizedEvent(options.event);
  const repository = commonGitDirectory(options.cwd);
  const file = statePath({
    kind: options.kind, repository, sessionId: event.sessionId,
    stateDirectory: options.stateDirectory,
  });
  const result = withStateLock(file, () => {
    const state = readFresh(file, options.ttlMilliseconds, options.now);
    if (state === null || state.state !== "attempting" || state.sessionId !== event.sessionId) {
      return null;
    }
    if (
      typeof state.target !== "object"
      || state.target === null
      || (state.target.toolUseId !== "" && state.target.toolUseId !== event.toolUseId)
    ) return null;

    const succeeded = options.changesBranchRef === true
      ? targetAdvanced(state.target, currentTarget(options.cwd))
      : options.exitCode === 0;
    if (succeeded) {
      removeFile(file);
      return "completed";
    }

    atomicJson(file, {
      ...state,
      state: "ready",
      lastFailureAt: options.now,
      lastExitCode: Number.isInteger(options.exitCode) ? options.exitCode : null,
    });
    return "retry";
  });
  return result.locked ? null : result.value;
}
