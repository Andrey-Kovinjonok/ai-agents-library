import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AGENTS = Object.freeze(["codex", "claude", "qwen", "pi", "oh-my-pi", "opencode"]);
const TOOL_EVENTS = Object.freeze(["PreToolUse", "PostToolUse"]);
const FAILURE_EVENTS = Object.freeze(["PostToolUseFailure"]);

export class GitActionGuardInstallError extends Error {
  constructor(message) {
    super(message);
    this.name = "GitActionGuardInstallError";
  }
}

function exists(file) {
  try { fs.lstatSync(file); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function readJson(file) {
  if (!exists(file)) return {};
  const status = fs.lstatSync(file);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new GitActionGuardInstallError(`Ожидался обычный JSON-файл: ${file}`);
  }
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not object");
    return value;
  } catch (error) {
    throw new GitActionGuardInstallError(`Некорректный JSON в ${file}: ${error.message}`);
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try { fs.renameSync(temporary, file); } finally { fs.rmSync(temporary, { force: true }); }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function ownedHook(entry) {
  return Array.isArray(entry?.hooks) && entry.hooks.some((hook) => (
    typeof hook?.command === "string" && hook.command.includes("git-action-guard-hook")
  ));
}

function commandEntry({ command, event, harness }) {
  const entry = {
    hooks: [{
      type: "command",
      command,
      timeout: harness === "qwen" ? 10_000 : 10,
    }],
  };
  if (event !== "UserPromptSubmit") {
    entry.matcher = harness === "qwen"
      ? "^run_shell_command$"
      : harness === "claude" ? "^Bash$" : "Bash|functions\\.exec_command|exec_command";
  }
  if (harness === "qwen") entry.sequential = true;
  return entry;
}

function mergedCommandHooks(document, { harness, nodeExecutable, runtime }) {
  if (document.hooks !== undefined && (
    document.hooks === null || typeof document.hooks !== "object" || Array.isArray(document.hooks)
  )) throw new GitActionGuardInstallError("Поле hooks должно быть JSON-объектом");
  const hooks = { ...(document.hooks ?? {}) };
  const events = ["UserPromptSubmit", ...TOOL_EVENTS, ...(harness === "codex" ? [] : FAILURE_EVENTS)];
  const command = `${shellQuote(nodeExecutable)} ${shellQuote(runtime)} --harness ${harness}`;
  for (const event of events) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
      throw new GitActionGuardInstallError(`Поле hooks.${event} должно быть массивом`);
    }
    hooks[event] = [
      ...(hooks[event] ?? []).filter((entry) => !ownedHook(entry)),
      commandEntry({ command, event, harness }),
    ];
  }
  return { ...document, hooks };
}

function linkExact(link, target) {
  if (exists(link)) {
    const status = fs.lstatSync(link);
    const actual = status.isSymbolicLink()
      ? path.resolve(path.dirname(link), fs.readlinkSync(link))
      : null;
    if (actual === path.resolve(target)) return;
    throw new GitActionGuardInstallError(`Нельзя заменить существующий файл или ссылку: ${link}`);
  }
  fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
  fs.symlinkSync(target, link, "file");
}

function selectedAgents(values) {
  const expanded = values?.includes("all") ? AGENTS : values ?? ["codex"];
  const selected = [...new Set(expanded)];
  for (const agent of selected) {
    if (!AGENTS.includes(agent)) throw new GitActionGuardInstallError(`Неизвестная оболочка: ${agent}`);
  }
  return selected;
}

function packageRootDefault() {
  return fileURLToPath(new URL("../../", import.meta.url));
}

export function installGitActionGuard(options = {}) {
  const userHome = path.resolve(options.userHome ?? os.homedir());
  const codexHome = path.resolve(options.codexHome ?? path.join(userHome, ".codex"));
  const packageRoot = path.resolve(options.packageRoot ?? packageRootDefault());
  const nodeExecutable = path.resolve(options.nodeExecutable ?? process.execPath);
  const agents = selectedAgents(options.agents);
  const runtime = path.join(packageRoot, "bin", "git-action-guard-hook.js");
  if (!exists(runtime) || !fs.lstatSync(runtime).isFile()) {
    throw new GitActionGuardInstallError(`Исполняемый файл не найден: ${runtime}`);
  }

  const configFiles = {
    codex: path.join(codexHome, "hooks.json"),
    claude: path.join(userHome, ".claude", "settings.json"),
    qwen: path.join(userHome, ".qwen", "settings.json"),
  };
  const prepared = [];
  for (const harness of ["codex", "claude", "qwen"]) {
    if (!agents.includes(harness)) continue;
    const file = configFiles[harness];
    const current = readJson(file);
    prepared.push({
      type: "json",
      harness,
      file,
      value: mergedCommandHooks(current, { harness, nodeExecutable, runtime }),
    });
  }

  const openCodeMajor = options.openCodeMajor ?? 1;
  if (![1, 2].includes(openCodeMajor)) {
    throw new GitActionGuardInstallError("openCodeMajor должен быть равен 1 или 2");
  }
  const links = {
    pi: {
      link: path.join(userHome, ".pi", "agent", "extensions", "git-action-guard.js"),
      target: path.join(packageRoot, "src", "adapters", "pi.js"),
    },
    "oh-my-pi": {
      link: path.join(userHome, ".omp", "agent", "hooks", "git-action-guard.js"),
      target: path.join(packageRoot, "src", "adapters", "oh-my-pi.js"),
    },
    opencode: {
      link: path.join(userHome, ".config", "opencode", "plugins", "git-action-guard.js"),
      target: path.join(packageRoot, "src", "adapters", `opencode-v${openCodeMajor}.js`),
    },
  };
  for (const harness of ["pi", "oh-my-pi", "opencode"]) {
    if (!agents.includes(harness)) continue;
    const item = links[harness];
    if (!exists(item.target) || !fs.lstatSync(item.target).isFile()) {
      throw new GitActionGuardInstallError(`Адаптер не найден: ${item.target}`);
    }
    if (exists(item.link)) linkExact(item.link, item.target);
    prepared.push({ type: "link", harness, ...item });
  }

  for (const item of prepared) {
    if (item.type === "json") writeJsonAtomic(item.file, item.value);
    else linkExact(item.link, item.target);
  }
  return { agents, packageRoot, runtime, configFiles, links, openCodeMajor };
}
