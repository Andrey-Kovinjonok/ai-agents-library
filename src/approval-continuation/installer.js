import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  approvalContinuationPaths,
  defaultApprovalContinuationConfig,
} from "./config.js";

const SKILL_NAME = "approval-continuation";
const EVENTS = Object.freeze([
  "SessionStart",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
]);
const COMMAND_MATCHER = "Bash|functions\\.exec_command|exec_command";

export const SUPPORTED_APPROVAL_CONTINUATION_AGENTS = Object.freeze([
  "codex",
  "claude",
  "cursor",
  "opencode",
  "antigravity",
  "codebuddy",
  "qoder",
]);

export class ApprovalContinuationInstallError extends Error {
  constructor(message) {
    super(message);
    this.name = "ApprovalContinuationInstallError";
  }
}

function objectValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function readJsonObject(file, missing = {}) {
  let status;
  try {
    status = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return missing;
    throw error;
  }
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new ApprovalContinuationInstallError(
      `Ожидался обычный JSON-файл: ${file}`,
    );
  }
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new ApprovalContinuationInstallError(
      `Не удалось прочитать корректный JSON из ${file}: ${error.message}`,
    );
  }
  if (!objectValue(value)) {
    throw new ApprovalContinuationInstallError(
      `JSON должен содержать объект: ${file}`,
    );
  }
  return value;
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
  );
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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withProductConfigLock(configFile, action) {
  const lockFile = `${configFile}.lock`;
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
          throw new ApprovalContinuationInstallError(
            `Файл блокировки имеет недопустимый тип: ${lockFile}`,
          );
        }
        owner = Number(fs.readFileSync(lockFile, "utf8").trim());
      } catch (readError) {
        if (readError?.code === "ENOENT") continue;
        throw readError;
      }
      if (!Number.isSafeInteger(owner) || owner <= 0) {
        throw new ApprovalContinuationInstallError(
          `Файл блокировки повреждён: ${lockFile}`,
        );
      }
      let ownerIsAlive = true;
      try {
        process.kill(owner, 0);
      } catch (ownerError) {
        if (ownerError?.code === "ESRCH") ownerIsAlive = false;
        else if (ownerError?.code !== "EPERM") throw ownerError;
      }
      if (!ownerIsAlive) {
        throw new ApprovalContinuationInstallError(
          `Осталась блокировка от завершившегося процесса ${owner}: ${lockFile}. `
          + "Она не удаляется автоматически.",
        );
      }
      if (Date.now() >= deadline) {
        throw new ApprovalContinuationInstallError(
          `Конфиг занят процессом ${owner}: ${configFile}`,
        );
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

function copyFileAtomic(source, destination, mode = 0o644) {
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(temporary, mode);
  try {
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function normalizedLinkTarget(link) {
  const target = fs.readlinkSync(link);
  return path.resolve(path.dirname(link), target);
}

function preflightExactLink(link, target, label) {
  if (!exists(link)) return;
  const status = fs.lstatSync(link);
  if (status.isSymbolicLink() && normalizedLinkTarget(link) === path.resolve(target)) {
    return;
  }
  throw new ApprovalContinuationInstallError(
    `Нельзя заменить существующий ${label}: ${link}`,
  );
}

function createOrKeepLink(link, target, directory = false) {
  if (exists(link)) return;
  fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
  fs.symlinkSync(target, link, directory ? "dir" : "file");
}

function skillDirectory(agent, userHome, codexHome) {
  if (agent === "codex") return path.join(codexHome, "skills");
  const relative = {
    claude: [".claude", "skills"],
    cursor: [".cursor", "skills"],
    opencode: [".config", "opencode", "skills"],
    antigravity: [".gemini", "antigravity", "skills"],
    codebuddy: [".codebuddy", "skills"],
    qoder: [".qoder", "skills"],
  };
  return path.join(userHome, ...relative[agent]);
}

function normalizeAgents(values) {
  const selected = values?.length > 0 ? values : ["codex"];
  const expanded = selected.includes("all")
    ? SUPPORTED_APPROVAL_CONTINUATION_AGENTS
    : selected;
  const result = [...new Set(expanded)];
  for (const agent of result) {
    if (!SUPPORTED_APPROVAL_CONTINUATION_AGENTS.includes(agent)) {
      throw new ApprovalContinuationInstallError(`Неподдерживаемый агент: ${agent}`);
    }
  }
  return result;
}

function canonicalDirectoryIsOwned(canonicalDirectory) {
  const skillFile = path.join(canonicalDirectory, "SKILL.md");
  if (exists(skillFile)) {
    const status = fs.lstatSync(skillFile);
    if (status.isSymbolicLink() || !status.isFile()) return false;
    const header = fs.readFileSync(skillFile, "utf8").slice(0, 4096);
    return /^name:\s*["']?approval-continuation["']?\s*$/mu.test(header);
  }
  const allowedBeforeAssets = new Set(["config.json", "projects"]);
  return fs.readdirSync(canonicalDirectory).every((entry) => (
    allowedBeforeAssets.has(entry)
  ));
}

function preflightDirectory(directory, label) {
  if (!exists(directory)) return;
  const status = fs.lstatSync(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new ApprovalContinuationInstallError(
      `${label} должен быть обычным каталогом: ${directory}`,
    );
  }
}

function preflightOwnedAsset(file, label) {
  if (!exists(file)) return;
  const status = fs.lstatSync(file);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new ApprovalContinuationInstallError(
      `${label} должен быть обычным файлом: ${file}`,
    );
  }
}

function validateProductConfig(config, file) {
  if (
    config.schemaVersion !== 1
    || !objectValue(config.projects)
    || (config.settings !== undefined && !objectValue(config.settings))
    || (config.legacyLocations !== undefined && !Array.isArray(config.legacyLocations))
  ) {
    throw new ApprovalContinuationInstallError(
      `Несовместимый конфиг approval-continuation: ${file}`,
    );
  }
}

function mergeConfig(existing, options) {
  const defaults = defaultApprovalContinuationConfig(options);
  if (existing === null) return defaults;
  const settings = objectValue(existing.settings) ? existing.settings : {};
  const trustedWorkRoots = options.trustedRoots?.length > 0
    ? defaultApprovalContinuationConfig(options).settings.trustedWorkRoots
    : settings.trustedWorkRoots ?? defaults.settings.trustedWorkRoots;
  return {
    ...existing,
    schemaVersion: 1,
    projects: existing.projects,
    settings: {
      ...defaults.settings,
      ...settings,
      trustedWorkRoots,
      approval: {
        ...defaults.settings.approval,
        ...(objectValue(settings.approval) ? settings.approval : {}),
      },
      continuation: {
        ...defaults.settings.continuation,
        ...(objectValue(settings.continuation) ? settings.continuation : {}),
      },
      observations: {
        ...defaults.settings.observations,
        ...(objectValue(settings.observations) ? settings.observations : {}),
      },
      safety: {
        ...defaults.settings.safety,
        ...(objectValue(settings.safety) ? settings.safety : {}),
      },
    },
    legacyLocations: existing.legacyLocations ?? defaults.legacyLocations,
  };
}

function entryIsOwned(entry) {
  if (!objectValue(entry) || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((hook) => {
    if (!objectValue(hook) || typeof hook.command !== "string") return false;
    return hook.command.includes("approval-continuation/scripts/acp-hook.js")
      || hook.command.includes("approval-continuation/scripts/acp_hook.py")
      || hook.command.includes("bin/approval-continuation-hook.js");
  });
}

function validateCodexHooks(document, hooksFile) {
  const hooks = document.hooks ?? {};
  if (!objectValue(hooks)) {
    throw new ApprovalContinuationInstallError(
      `Поле hooks должно быть объектом: ${hooksFile}`,
    );
  }
  for (const event of EVENTS) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
      throw new ApprovalContinuationInstallError(
        `Поле hooks.${event} должно быть массивом: ${hooksFile}`,
      );
    }
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function hookEntry(command, event) {
  const messages = {
    SessionStart: "Loading shared procedure observations",
    PreToolUse: "Checking shared safety settings",
    PermissionRequest: "Checking shared approval settings",
    PostToolUse: "Observing verification outcome",
    Stop: "Checking whether promised work remains",
  };
  const entry = {
    hooks: [{
      type: "command",
      command,
      statusMessage: messages[event],
      timeout: 5,
    }],
  };
  if (event === "SessionStart") {
    entry.matcher = "startup|resume|clear|compact";
    entry.hooks[0].additionalContextLimit = 1500;
  } else if (event !== "Stop") {
    entry.matcher = COMMAND_MATCHER;
  }
  return entry;
}

function mergedCodexHooks(document, hookLink, paths, nodeExecutable) {
  const command = [
    shellQuote(nodeExecutable),
    shellQuote(hookLink),
    "--agents-root",
    shellQuote(paths.agentsRoot),
    "--user-home",
    shellQuote(paths.homeDir),
  ].join(" ");
  const hooks = { ...(document.hooks ?? {}) };
  for (const event of EVENTS) {
    hooks[event] = [
      ...(hooks[event] ?? []).filter((entry) => !entryIsOwned(entry)),
      hookEntry(command, event),
    ];
  }
  return { ...document, hooks };
}

function defaultPackageRoot() {
  return fileURLToPath(new URL("../../", import.meta.url));
}

/**
 * Install immutable skill assets and adapter links. The function never removes
 * conflicting paths and never replaces product config or project data.
 */
export async function installApprovalContinuation(options = {}) {
  const userHome = path.resolve(options.userHome ?? os.homedir());
  const agentsRoot = path.resolve(
    options.agentsRoot
      ?? (options.userHome === undefined ? process.env.AGENTS_HOME : undefined)
      ?? path.join(userHome, ".agents"),
  );
  const codexHome = path.resolve(
    options.codexHome
      ?? (options.userHome === undefined ? process.env.CODEX_HOME : undefined)
      ?? path.join(userHome, ".codex"),
  );
  const packageRoot = path.resolve(options.packageRoot ?? defaultPackageRoot());
  const agents = normalizeAgents(options.agents);
  const paths = approvalContinuationPaths({ userHome, homeDir: userHome, agentsRoot });
  const sourceSkill = path.join(packageRoot, "skills", SKILL_NAME);
  const sourceSkillFile = path.join(sourceSkill, "SKILL.md");
  const sourceAgentFile = path.join(sourceSkill, "agents", "openai.yaml");
  const runtimeHook = path.join(packageRoot, "bin", "approval-continuation-hook.js");
  const hookLink = path.join(paths.canonicalDirectory, "scripts", "acp-hook.js");
  const hooksFile = path.join(codexHome, "hooks.json");
  const links = agents.map((agent) => ({
    agent,
    path: path.join(skillDirectory(agent, userHome, codexHome), SKILL_NAME),
  }));

  for (const source of [sourceSkillFile, sourceAgentFile, runtimeHook]) {
    if (!exists(source) || !fs.lstatSync(source).isFile()) {
      throw new ApprovalContinuationInstallError(
        `Пакет неполон, отсутствует обычный файл: ${source}`,
      );
    }
  }
  if (exists(paths.canonicalDirectory)) {
    preflightDirectory(paths.canonicalDirectory, "Канонический навык");
    if (!canonicalDirectoryIsOwned(paths.canonicalDirectory)) {
      throw new ApprovalContinuationInstallError(
        `Нельзя перезаписать чужой канонический навык: ${paths.canonicalDirectory}`,
      );
    }
  }
  for (const directory of [
    path.join(paths.canonicalDirectory, "agents"),
    path.join(paths.canonicalDirectory, "scripts"),
    paths.projectsDirectory,
  ]) {
    preflightDirectory(directory, "Каталог навыка");
  }
  preflightOwnedAsset(
    path.join(paths.canonicalDirectory, "SKILL.md"),
    "Описание канонического навыка",
  );
  preflightOwnedAsset(
    path.join(paths.canonicalDirectory, "agents", "openai.yaml"),
    "Метаданные канонического навыка",
  );
  for (const link of links) {
    preflightExactLink(link.path, paths.canonicalDirectory, `путь навыка агента ${link.agent}`);
  }
  preflightExactLink(hookLink, runtimeHook, "исполняемый сценарий навыка");

  const existingConfig = exists(paths.configFile)
    ? readJsonObject(paths.configFile)
    : null;
  if (existingConfig !== null) validateProductConfig(existingConfig, paths.configFile);
  const hooksDocument = agents.includes("codex")
    ? readJsonObject(hooksFile)
    : null;
  if (hooksDocument !== null) validateCodexHooks(hooksDocument, hooksFile);

  fs.mkdirSync(paths.canonicalDirectory, { recursive: true, mode: 0o700 });
  return withProductConfigLock(paths.configFile, async () => {
    const currentConfig = exists(paths.configFile)
      ? readJsonObject(paths.configFile)
      : null;
    if (currentConfig !== null) validateProductConfig(currentConfig, paths.configFile);
    const currentHooksDocument = agents.includes("codex")
      ? readJsonObject(hooksFile)
      : null;
    if (currentHooksDocument !== null) {
      validateCodexHooks(currentHooksDocument, hooksFile);
    }

    fs.mkdirSync(paths.projectsDirectory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(paths.canonicalDirectory, "agents"), {
      recursive: true,
      mode: 0o700,
    });
    fs.mkdirSync(path.join(paths.canonicalDirectory, "scripts"), {
      recursive: true,
      mode: 0o700,
    });
    copyFileAtomic(sourceSkillFile, path.join(paths.canonicalDirectory, "SKILL.md"));
    copyFileAtomic(
      sourceAgentFile,
      path.join(paths.canonicalDirectory, "agents", "openai.yaml"),
    );
    createOrKeepLink(hookLink, runtimeHook);

    const nextConfig = mergeConfig(currentConfig, {
      homeDir: userHome,
      agentsRoot,
      trustedRoots: options.trustedRoots,
    });
    if (
      currentConfig === null
      || JSON.stringify(nextConfig) !== JSON.stringify(currentConfig)
    ) {
      writeJsonAtomic(paths.configFile, nextConfig);
    }
    for (const link of links) {
      createOrKeepLink(link.path, paths.canonicalDirectory, true);
    }
    if (currentHooksDocument !== null) {
      writeJsonAtomic(hooksFile, mergedCodexHooks(
        currentHooksDocument,
        hookLink,
        paths,
        options.nodeExecutable ?? process.execPath,
      ));
    }

    return {
      ...paths,
      packageRoot,
      canonicalDirectory: paths.canonicalDirectory,
      configFile: paths.configFile,
      projectsDirectory: paths.projectsDirectory,
      hookLink,
      hooksFile: agents.includes("codex") ? hooksFile : null,
      links,
    };
  });
}
