#!/usr/bin/env node

import {
  beginGitActionPermission,
  createGitActionPermission,
  finishGitActionPermission,
} from "../src/approval-continuation/index.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input || "{}");
const options = {
  kind: request.kind,
  cwd: request.cwd,
  event: request.event,
  stateDirectory: request.stateDirectory,
};
let result;
if (request.operation === "create") result = createGitActionPermission(options);
else if (request.operation === "begin") result = beginGitActionPermission(options);
else if (request.operation === "finish") {
  result = finishGitActionPermission({
    ...options,
    exitCode: request.exitCode,
    changesBranchRef: request.changesBranchRef,
  });
} else throw new Error(`Unknown operation: ${request.operation}`);
process.stdout.write(`${JSON.stringify({ result })}\n`);
