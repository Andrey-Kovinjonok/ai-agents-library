import fs from "node:fs";
import path from "node:path";

import {
  ensureProductProject,
  resolveProductProject,
} from "../project-locations.js";
import { APPROVAL_CONTINUATION_PRODUCT } from "./config.js";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processIsAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function withObservationLock(lockFile, action) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 5_000;
  let handle;
  while (handle === undefined) {
    try {
      handle = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(handle, `${process.pid}\n`);
      fs.fsyncSync(handle);
    } catch (error) {
      if (handle !== undefined) {
        fs.closeSync(handle);
        handle = undefined;
        fs.rmSync(lockFile, { force: true });
      }
      if (error?.code !== "EEXIST") throw error;
      let owner;
      try {
        const status = fs.lstatSync(lockFile);
        if (status.isSymbolicLink() || !status.isFile()) {
          throw new Error(`Файл блокировки имеет недопустимый тип: ${lockFile}`);
        }
        owner = Number(fs.readFileSync(lockFile, "utf8").trim());
      } catch (readError) {
        if (readError?.code === "ENOENT") continue;
        throw readError;
      }
      if (!Number.isSafeInteger(owner) || owner <= 0) {
        throw new Error(`Файл блокировки повреждён: ${lockFile}`);
      }
      if (!processIsAlive(owner)) {
        throw new Error(
          `Осталась блокировка наблюдений от завершившегося процесса ${owner}: ${lockFile}. `
          + "Она не удаляется автоматически.",
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(`Наблюдения заняты процессом ${owner}: ${lockFile}`);
      }
      await sleep(25);
    }
  }
  try {
    return await action();
  } finally {
    fs.closeSync(handle);
    fs.rmSync(lockFile, { force: true });
  }
}

function initialState(identity) {
  return {
    schemaVersion: 1,
    project: {
      canonicalPath: identity.canonicalPath,
      alias: identity.alias,
    },
    outcomes: {},
    candidates: [],
    updatedAt: new Date(0).toISOString(),
  };
}

function readState(file, identity) {
  let value;
  try {
    const status = fs.lstatSync(file);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new Error(`Наблюдения должны быть обычным файлом: ${file}`);
    }
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return initialState(identity);
    if (error instanceof SyntaxError) {
      throw new Error(`Наблюдения содержат некорректный JSON: ${file}`);
    }
    throw error;
  }
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || value.schemaVersion !== 1
    || value.project?.canonicalPath !== identity.canonicalPath
    || value.project?.alias !== identity.alias
    || value.outcomes === null
    || typeof value.outcomes !== "object"
    || Array.isArray(value.outcomes)
    || !Array.isArray(value.candidates)
  ) {
    throw new Error(`Наблюдения имеют несовместимый формат: ${file}`);
  }
  return value;
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export async function recordVerificationObservation(observation, options = {}) {
  const prepared = await ensureProductProject(
    APPROVAL_CONTINUATION_PRODUCT,
    observation.workingDirectory,
    options,
  );
  const stateFile = path.join(prepared.projectDirectory, "observations.json");
  const lockFile = `${stateFile}.lock`;
  return withObservationLock(lockFile, async () => {
    const state = readState(stateFile, prepared.identity);
    const now = new Date().toISOString();
    const current = state.outcomes[observation.command];
    const outcome = current !== null && typeof current === "object" && !Array.isArray(current)
      ? current
      : { success: 0, failure: 0 };
    const key = observation.exitCode === 0 ? "success" : "failure";
    outcome[key] = Number.isSafeInteger(outcome[key]) ? outcome[key] + 1 : 1;
    outcome.lastSeen = now;
    state.outcomes[observation.command] = outcome;

    if (observation.exitCode !== 0) {
      state.pendingFailure = {
        command: observation.command,
        seenAt: now,
      };
    } else {
      const failed = state.pendingFailure;
      delete state.pendingFailure;
      if (typeof failed?.command === "string") {
        const existing = state.candidates.find((candidate) => (
          candidate !== null
          && typeof candidate === "object"
          && candidate.failed === failed.command
          && candidate.worked === observation.command
        ));
        if (existing) {
          existing.count = Number.isSafeInteger(existing.count) ? existing.count + 1 : 2;
          existing.lastSeen = now;
        } else {
          state.candidates.push({
            failed: failed.command,
            worked: observation.command,
            count: 1,
            status: "candidate",
            lastSeen: now,
          });
        }
        state.candidates = state.candidates.slice(-20);
      }
    }
    state.updatedAt = now;
    writeJsonAtomic(stateFile, state);
    return { stateFile, state, prepared };
  });
}

export function readVerificationCandidates(workingDirectory, options = {}) {
  let resolved;
  try {
    resolved = resolveProductProject(
      APPROVAL_CONTINUATION_PRODUCT,
      workingDirectory,
      options,
    );
  } catch (error) {
    if (/нет проекта/u.test(String(error?.message))) return [];
    throw error;
  }
  const state = readState(
    path.join(resolved.projectDirectory, "observations.json"),
    resolved.identity,
  );
  return state.candidates
    .filter((candidate) => candidate !== null && typeof candidate === "object")
    .sort((left, right) => Number(right.count ?? 0) - Number(left.count ?? 0))
    .slice(0, 3);
}

