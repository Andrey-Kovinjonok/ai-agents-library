#!/usr/bin/env node

import { installGitActionGuard } from "../src/approval-continuation/index.js";

const options = { agents: [] };
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  const value = process.argv[index + 1];
  if (argument === "--agent") { options.agents.push(value); index += 1; }
  else if (argument === "--user-home") { options.userHome = value; index += 1; }
  else if (argument === "--codex-home") { options.codexHome = value; index += 1; }
  else if (argument === "--package-root") { options.packageRoot = value; index += 1; }
  else if (argument === "--node") { options.nodeExecutable = value; index += 1; }
  else if (argument === "--opencode-major") { options.openCodeMajor = Number(value); index += 1; }
  else throw new Error(`Неизвестный параметр: ${argument}`);
}
const result = installGitActionGuard(options);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
