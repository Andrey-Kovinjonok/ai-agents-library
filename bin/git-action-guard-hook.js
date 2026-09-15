#!/usr/bin/env node

import {
  evaluateCommandHookEvent,
  renderCommandHookDecision,
} from "../src/approval-continuation/index.js";

const harnessIndex = process.argv.indexOf("--harness");
const harness = harnessIndex >= 0 ? process.argv[harnessIndex + 1] : "codex";
if (!["codex", "claude", "qwen"].includes(harness)) {
  process.stderr.write(`Unknown harness: ${harness}\n`);
  process.exit(2);
}

let input = "";
for await (const chunk of process.stdin) input += chunk;
let payload;
try {
  payload = JSON.parse(input || "{}");
} catch {
  process.exit(0);
}
const decision = evaluateCommandHookEvent(payload, { harness });
const rendered = renderCommandHookDecision(decision, harness, payload.hook_event_name);
if (rendered.output !== null) {
  const stream = rendered.stream === "stderr" ? process.stderr : process.stdout;
  stream.write(`${rendered.output}\n`);
}
process.exit(rendered.exitCode);
