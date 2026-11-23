#!/usr/bin/env node

import {
  ApprovalContinuationInstallError,
  installApprovalContinuation,
} from "../src/approval-continuation/index.js";

function valueAfter(arguments_, index, option) {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new ApprovalContinuationInstallError(`Для ${option} не задано значение`);
  }
  return value;
}

function parseArguments(arguments_) {
  const result = {
    agents: [],
    trustedRoots: [],
  };
  if (process.env.AGENTS_HOME) result.agentsRoot = process.env.AGENTS_HOME;
  if (process.env.CODEX_HOME) result.codexHome = process.env.CODEX_HOME;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help") {
      result.help = true;
    } else if (argument === "--user-home") {
      result.userHome = valueAfter(arguments_, index, argument);
      index += 1;
    } else if (["--agents-root", "--agents-home"].includes(argument)) {
      result.agentsRoot = valueAfter(arguments_, index, argument);
      index += 1;
    } else if (argument === "--codex-home") {
      result.codexHome = valueAfter(arguments_, index, argument);
      index += 1;
    } else if (argument === "--agent") {
      result.agents.push(valueAfter(arguments_, index, argument));
      index += 1;
    } else if (argument === "--trusted-root") {
      result.trustedRoots.push(valueAfter(arguments_, index, argument));
      index += 1;
    } else {
      throw new ApprovalContinuationInstallError(`Неизвестный аргумент: ${argument}`);
    }
  }
  return result;
}

function usage() {
  return [
    "Использование: node bin/install-approval-continuation.js [параметры]",
    "",
    "  --agent <имя|all>       агент, для которого создаётся ссылка; можно повторять",
    "  --trusted-root <путь>   доверенный рабочий корень; можно повторять",
    "  --user-home <путь>      изолированный домашний каталог пользователя",
    "  --agents-root <путь>    общий корень агентских данных",
    "  --codex-home <путь>     каталог настроек Codex",
  ].join("\n");
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
  } else {
    const result = await installApprovalContinuation(options);
    process.stdout.write(`Канонический навык: ${result.canonicalDirectory}\n`);
    process.stdout.write(`Живые настройки: ${result.configFile}\n`);
    process.stdout.write(`Проектовые данные: ${result.projectsDirectory}\n`);
    for (const link of result.links) {
      process.stdout.write(`${link.agent}: ${link.path}\n`);
    }
    if (result.hooksFile !== null) {
      process.stdout.write(`Codex hooks: ${result.hooksFile}\n`);
    }
  }
} catch (error) {
  process.stderr.write(`Установка отклонена: ${error.message}\n`);
  process.exitCode = 1;
}
