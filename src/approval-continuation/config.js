import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const APPROVAL_CONTINUATION_PRODUCT = "approval-continuation";

export const SUPPORTED_APPROVAL_CLASSES = Object.freeze([
  "localhost-headless-screenshot",
  "node-check",
]);

function objectValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalPathWhenPresent(value) {
  const absolute = path.resolve(value);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function expandHome(value, homeDir) {
  if (value === "~") return homeDir;
  if (value.startsWith(`~${path.sep}`)) {
    return path.join(homeDir, value.slice(2));
  }
  return value;
}

export function approvalContinuationPaths(options = {}) {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const agentsRoot = path.resolve(
    options.agentsRoot
      ?? process.env.AGENTS_HOME
      ?? path.join(homeDir, ".agents"),
  );
  const canonicalDirectory = path.join(
    agentsRoot,
    "skills",
    APPROVAL_CONTINUATION_PRODUCT,
  );
  return {
    homeDir,
    agentsRoot,
    canonicalDirectory,
    configFile: path.join(canonicalDirectory, "config.json"),
    projectsDirectory: path.join(canonicalDirectory, "projects"),
  };
}

export function defaultApprovalContinuationConfig(options = {}) {
  const paths = approvalContinuationPaths(options);
  const trustedWorkRoots = options.trustedRoots?.length > 0
    ? options.trustedRoots.map((value) => canonicalPathWhenPresent(
      expandHome(String(value), paths.homeDir),
    ))
    : [
      path.join(paths.homeDir, "WORK", "OF"),
      path.join(paths.homeDir, "WORK", "GITHUB"),
    ].map(canonicalPathWhenPresent);
  return {
    schemaVersion: 1,
    projects: {},
    settings: {
      trustedWorkRoots,
      approval: {
        enabledClasses: [...SUPPORTED_APPROVAL_CLASSES],
      },
      continuation: {
        enabled: true,
        maxAutomaticContinuationsPerSession: 1,
      },
      observations: { enabled: true },
      safety: { enabled: false },
    },
    legacyLocations: [
      {
        path: path.join(paths.agentsRoot, "config", "approval-continuation.json"),
        kind: "legacy-settings",
        cleanupPolicy: "ask",
      },
      {
        path: path.join(
          paths.agentsRoot,
          "state",
          "approval-continuation",
          "observations",
        ),
        kind: "legacy-observations",
        cleanupPolicy: "ask",
      },
      {
        path: path.join(paths.homeDir, ".codex", "acp"),
        kind: "archive-default",
        cleanupPolicy: "ask",
      },
      {
        path: path.join(paths.canonicalDirectory, "scripts", "acp_hook.py"),
        kind: "legacy-python-runtime",
        cleanupPolicy: "ask",
      },
    ],
  };
}

function disabledRuntimeSettings(configFile) {
  return {
    schemaVersion: 1,
    configFile,
    trustedWorkRoots: [],
    approval: { enabledClasses: [] },
    continuation: {
      enabled: false,
      maxAutomaticContinuationsPerSession: 1,
    },
    observations: { enabled: false },
    safety: { enabled: false },
  };
}

function readJsonObject(file) {
  const status = fs.lstatSync(file);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`Настройка должна быть обычным файлом: ${file}`);
  }
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!objectValue(value)) {
    throw new Error(`Настройка должна содержать JSON-объект: ${file}`);
  }
  return value;
}

/**
 * Read and validate live settings on every invocation. Any malformed or absent
 * config fails closed: automatic approval, continuation, observations and
 * safety rules all remain disabled.
 */
export function readApprovalContinuationSettings(options = {}) {
  const paths = approvalContinuationPaths(options);
  const fallback = disabledRuntimeSettings(paths.configFile);
  let config;
  try {
    config = readJsonObject(paths.configFile);
  } catch {
    return fallback;
  }
  if (
    config.schemaVersion !== 1
    || !objectValue(config.projects)
    || !objectValue(config.settings)
  ) {
    return fallback;
  }

  const configuredRoots = config.settings.trustedWorkRoots;
  const trustedWorkRoots = Array.isArray(configuredRoots)
    && configuredRoots.every((value) => typeof value === "string" && value !== "")
    ? configuredRoots.map((value) => canonicalPathWhenPresent(
      expandHome(value, paths.homeDir),
    ))
    : [];
  const configuredClasses = objectValue(config.settings.approval)
    ? config.settings.approval.enabledClasses
    : [];
  const enabledClasses = Array.isArray(configuredClasses)
    && configuredClasses.every((value) => typeof value === "string")
    ? [...new Set(configuredClasses)].filter((value) => (
      SUPPORTED_APPROVAL_CLASSES.includes(value)
    )).sort()
    : [];
  const enabled = (section) => (
    objectValue(config.settings[section])
    && config.settings[section].enabled === true
  );

  return {
    schemaVersion: 1,
    configFile: paths.configFile,
    trustedWorkRoots,
    approval: { enabledClasses },
    continuation: (() => {
      const section = objectValue(config.settings.continuation)
        ? config.settings.continuation
        : {};
      const configuredMaximum = section.maxAutomaticContinuationsPerSession;
      const maximum = Number.isSafeInteger(configuredMaximum)
        && configuredMaximum >= 0
        && configuredMaximum <= 100
        ? configuredMaximum
        : 1;
      return {
        enabled: section.enabled === true,
        maxAutomaticContinuationsPerSession: maximum,
      };
    })(),
    observations: { enabled: enabled("observations") },
    safety: { enabled: enabled("safety") },
  };
}

export function isTrustedWorkingDirectory(value, settings, options = {}) {
  if (typeof value !== "string" || value === "") return false;
  const paths = approvalContinuationPaths(options);
  const candidate = canonicalPathWhenPresent(expandHome(value, paths.homeDir));
  return settings.trustedWorkRoots.some((root) => {
    const relative = path.relative(root, candidate);
    return relative === ""
      || (
        relative !== ".."
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative)
      );
  });
}
