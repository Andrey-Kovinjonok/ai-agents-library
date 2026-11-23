import path from "node:path";

import { claimContinuation } from "./continuation-state.js";

const DESTRUCTIVE_PATTERNS = [
  [
    /(?:^|\s)git\s+clean\s+-(?:[^\s]*f[^\s]*d|[^\s]*d[^\s]*f)(?:\s|$)/u,
    "Broad git clean -fd is blocked by approval-continuation.",
  ],
  [
    /(?:^|\s)git\s+push(?:\s+[^\s]+)*\s+--force(?:\s|$)/u,
    "Plain git push --force is blocked; use an exact force-with-lease workflow after review.",
  ],
  [
    /(?:^|\s)(?:sudo\s+)?rm\s+-(?:rf|fr)\s+(?:--\s+)?(?:\/|~)(?:\s|$)/u,
    "Recursive forced deletion of a filesystem root is blocked.",
  ],
  [
    /--no-sandbox(?:\s|$)/u,
    "Disabling the browser sandbox is blocked.",
  ],
];

const INCOMPLETE_PATTERNS = [
  /остал(?:ось|ись|ся)/iu,
  /не\s+заверш(?:ено|ил|ена|ён)/iu,
  /ещ[её]\s+(?:нужно|надо|предстоит)/iu,
  /следующ(?:ий|ая|ее)\s+шаг/iu,
  /\bremaining\b/iu,
  /\bnot\s+(?:done|complete|finished)\b/iu,
  /\bin\s+progress\b/iu,
  /\bTODO\b/iu,
];

const EXPLICITLY_COMPLETE_PATTERNS = [
  /дальше\s+ничего\s+(?:дополнительно\s+)?(?:менять|делать)\s+не\s+нужно/iu,
  /дополнительных?\s+действий?\s+не\s+требуется/iu,
  /(?:работа|задача)\s+завершен[аоы]?/iu,
];

const USER_DECISION_PATTERNS = [
  /\?/u,
  /нужн[оа]\s+(?:тво[её]|ваше?)/iu,
  /подтверд(?:и|ите|ение)/iu,
  /пришли(?:те)?/iu,
  /выбери(?:те)?/iu,
  /\bdo\s+you\s+want\b/iu,
  /\bplease\s+(?:choose|provide|confirm)\b/iu,
];

const ENV_FILE_NAME = /(?:^|\/)(?:\.env(?:\.[^/]*)?|[^/]+\.env)$/iu;
const SENSITIVE_OPTION = /^--?(?:token|password|secret|api[-_]?key|authorization)$/iu;
const SENSITIVE_OPTION_VALUE = /^(--?(?:token|password|secret|api[-_]?key|authorization))=.*$/iu;

function nestedValue(payload, key) {
  for (const containerKey of ["tool_input", "input", "arguments", "params"]) {
    const container = payload?.[containerKey];
    if (
      container !== null
      && typeof container === "object"
      && !Array.isArray(container)
      && Object.hasOwn(container, key)
    ) {
      return container[key];
    }
  }
  return payload?.[key];
}

export function commandFrom(payload) {
  for (const key of ["command", "cmd"]) {
    const value = nestedValue(payload, key);
    if (typeof value === "string") return value;
  }
  return "";
}

export function workingDirectoryFrom(payload) {
  for (const key of [
    "workdir",
    "cwd",
    "working_directory",
    "workingDirectory",
    "workspace_root",
  ]) {
    const value = nestedValue(payload, key);
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

function tokenizeSimpleCommand(command) {
  if (typeof command !== "string" || command.length > 1_000) return null;
  const tokens = [];
  let token = "";
  let tokenStarted = false;
  let quote = null;

  const push = () => {
    if (tokenStarted) tokens.push(token);
    token = "";
    tokenStarted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote !== null) {
      if (character === quote) {
        quote = null;
        tokenStarted = true;
      } else if (character === "\\" && quote === '"') {
        index += 1;
        if (index >= command.length) return null;
        token += command[index];
        tokenStarted = true;
      } else {
        token += character;
        tokenStarted = true;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (character === "\\") {
      index += 1;
      if (index >= command.length) return null;
      token += command[index];
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      push();
      continue;
    }
    if (character === "&" && command[index + 1] === "&") {
      push();
      tokens.push("&&");
      index += 1;
      continue;
    }
    if (["\n", "\r", ";", "|", "`", "$", ">", "<", "&"].includes(character)) {
      return null;
    }
    token += character;
    tokenStarted = true;
  }
  if (quote !== null) return null;
  push();
  return tokens;
}

function safeRelativeFile(value) {
  const parts = value.split("/");
  return Boolean(value)
    && !value.startsWith("-")
    && !path.posix.isAbsolute(value)
    && !parts.includes("..")
    && !ENV_FILE_NAME.test(value);
}

function safeNodeCheck(tokens) {
  return tokens.length === 3
    && path.basename(tokens[0]) === "node"
    && tokens[1] === "--check"
    && safeRelativeFile(tokens[2]);
}

function safeTempScreenshot(value) {
  return /^[A-Za-z0-9._/-]+$/u.test(value)
    && path.posix.isAbsolute(value)
    && !value.split("/").includes("..")
    && (value.startsWith("/private/tmp/") || value.startsWith("/tmp/"));
}

function safeLoopbackUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:"
    && ["127.0.0.1", "localhost"].includes(parsed.hostname)
    && parsed.username === ""
    && parsed.password === ""
    && parsed.hash === ""
    && (
      parsed.port === ""
      || (Number(parsed.port) >= 1 && Number(parsed.port) <= 65_535)
    );
}

function safeBrowserSegment(tokens) {
  const supported = new Set([
    "Google Chrome",
    "chrome",
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
  ]);
  if (tokens.length === 0 || !supported.has(path.basename(tokens[0]))) return false;
  let sawHeadless = false;
  let sawScreenshot = false;
  let sawUrl = false;
  for (const token of tokens.slice(1)) {
    if (["--headless", "--headless=new"].includes(token)) {
      sawHeadless = true;
    } else if ([
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu-sandbox",
      "--enable-webgl",
    ].includes(token)) {
      continue;
    } else if (/^--use-angle=(?:swiftshader|metal|default)$/u.test(token)) {
      continue;
    } else if (/^--window-size=[0-9]{2,5},[0-9]{2,5}$/u.test(token)) {
      continue;
    } else if (token.startsWith("--screenshot=") && safeTempScreenshot(
      token.slice("--screenshot=".length),
    )) {
      sawScreenshot = true;
    } else if (safeLoopbackUrl(token)) {
      sawUrl = true;
    } else {
      return false;
    }
  }
  return sawHeadless && sawScreenshot && sawUrl;
}

export function approvalClassFor(command) {
  const tokens = tokenizeSimpleCommand(command);
  if (tokens === null) return null;
  if (!tokens.includes("&&") && safeNodeCheck(tokens)) return "node-check";
  if (tokens.filter((token) => token === "&&").length > 1) return null;
  let browserTokens = tokens;
  const splitAt = tokens.indexOf("&&");
  if (splitAt >= 0) {
    if (!safeNodeCheck(tokens.slice(0, splitAt))) return null;
    browserTokens = tokens.slice(splitAt + 1);
  }
  return safeBrowserSegment(browserTokens)
    ? "localhost-headless-screenshot"
    : null;
}

export function destructiveReason(command) {
  for (const [pattern, reason] of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

function quoteToken(value) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function sanitizeVerification(command) {
  const tokens = tokenizeSimpleCommand(command);
  if (tokens === null) return null;
  const lowered = tokens.join(" ").toLocaleLowerCase("en-US");
  if (!["test", "spec", "lint", "typecheck", "ts-check", "check", "verify"].some(
    (word) => lowered.includes(word),
  )) return null;
  if (tokens.some((token) => ENV_FILE_NAME.test(token))) return null;

  const sanitized = [];
  let redactNext = false;
  for (const token of tokens) {
    if (redactNext) {
      sanitized.push("<redacted>");
      redactNext = false;
      continue;
    }
    const withValue = token.match(SENSITIVE_OPTION_VALUE);
    if (SENSITIVE_OPTION.test(token)) {
      sanitized.push(token);
      redactNext = true;
    } else if (withValue) {
      sanitized.push(`${withValue[1]}=<redacted>`);
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(token)) {
      sanitized.push(`${token.slice(0, token.indexOf("="))}=<redacted>`);
    } else if (/^https?:\/\/[^/@\s]+@/iu.test(token)) {
      sanitized.push(token.replace(/^(https?:\/\/)[^/@\s]+@/iu, "$1<redacted>@"));
    } else {
      sanitized.push(token);
    }
  }
  return sanitized.map(quoteToken).join(" ");
}

export function findExitCode(value) {
  if (Array.isArray(value)) {
    for (const nested of value) {
      const found = findExitCode(nested);
      if (found !== null) return found;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  for (const key of ["exit_code", "exitCode", "status_code", "statusCode"]) {
    if (Number.isInteger(value[key])) return value[key];
  }
  for (const nested of Object.values(value)) {
    const found = findExitCode(nested);
    if (found !== null) return found;
  }
  return null;
}

export function continuationDecision(payload, settingsOrEnabled, options = {}) {
  const settings = settingsOrEnabled !== null && typeof settingsOrEnabled === "object"
    ? settingsOrEnabled
    : {
      enabled: settingsOrEnabled === true,
      maxAutomaticContinuationsPerSession: 1,
    };
  if (settings.enabled !== true || payload?.stop_hook_active === true) return null;
  const message = payload?.last_assistant_message;
  if (typeof message !== "string" || message.trim() === "") return null;
  if (EXPLICITLY_COMPLETE_PATTERNS.some((pattern) => pattern.test(message))) return null;
  if (USER_DECISION_PATTERNS.some((pattern) => pattern.test(message))) return null;
  if (!INCOMPLETE_PATTERNS.some((pattern) => pattern.test(message))) return null;
  if (!claimContinuation(
    payload,
    settings.maxAutomaticContinuationsPerSession,
    options,
  )) return null;
  return {
    decision: "block",
    reason: (
      "Продолжай текущее задание: заверши явно оставшуюся безопасную работу "
      + "и обещанные проверки. Не расширяй область задачи и не выполняй "
      + "рискованные операции без отдельного разрешения пользователя. "
      + "Автопродолжение 1/1 для этой сессии уже использовано; "
      + "повторные Stop-события продолжение не запускают."
    ),
  };
}
