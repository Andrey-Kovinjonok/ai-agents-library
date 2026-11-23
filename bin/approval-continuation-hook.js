#!/usr/bin/env node

import {
  runApprovalContinuationHook,
} from "../src/approval-continuation/index.js";

function parseArguments(arguments_) {
  const result = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (["--agents-root", "--agents-home"].includes(argument)) {
      result.agentsRoot = arguments_[index + 1];
      index += 1;
    } else if (argument === "--user-home") {
      result.homeDir = arguments_[index + 1];
      index += 1;
    } else {
      throw new Error(`Неизвестный аргумент hook: ${argument}`);
    }
    if (arguments_[index] === undefined) {
      throw new Error(`Для ${argument} не задано значение`);
    }
  }
  return result;
}

try {
  const options = parseArguments(process.argv.slice(2));
  process.exitCode = await runApprovalContinuationHook(options);
} catch (error) {
  process.stderr.write(`[approval-continuation] ${error.message}\n`);
  // A local policy failure must not make an agent command fail closed in an
  // unrelated project. The hook emits no decision, leaving the runtime's own
  // prompt and safety controls in charge.
  process.exitCode = 0;
}

