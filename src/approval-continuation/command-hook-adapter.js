import {
  beginGitCommandAuthorization,
  finishGitCommandAuthorization,
  gitAuthorizationMessage,
  recordGitAuthorizations,
} from "./git-action-approval.js";

function nested(value, ...keys) {
  let current = value;
  for (const key of keys) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value !== "") ?? "";
}

function exitCodeFrom(value) {
  if (value !== null && typeof value === "object") {
    for (const key of ["exit_code", "exitCode", "status_code", "statusCode"]) {
      if (Number.isInteger(value[key])) return value[key];
    }
    for (const nestedValue of Object.values(value)) {
      const result = exitCodeFrom(nestedValue);
      if (result !== null) return result;
    }
  }
  if (typeof value === "string") {
    const match = /(?:exit[_ ]code|process exited with code|status)[^0-9-]*(-?\d+)/iu.exec(value);
    if (match !== null) return Number.parseInt(match[1], 10);
  }
  return null;
}

export function normalizeCommandHookEvent(payload, harness) {
  const eventName = firstString(payload.hook_event_name, payload.eventName, payload.event);
  const submittedPrompt = harness === "qwen"
    ? firstString(payload.submitted_prompt)
    : firstString(payload.prompt, payload.submitted_prompt);
  return {
    eventName,
    prompt: submittedPrompt,
    cwd: firstString(
      nested(payload, "tool_input", "workdir"),
      nested(payload, "tool_input", "cwd"),
      payload.cwd,
      payload.working_directory,
      process.cwd(),
    ),
    command: firstString(
      nested(payload, "tool_input", "command"),
      nested(payload, "tool_input", "cmd"),
      nested(payload, "input", "command"),
      nested(payload, "input", "cmd"),
      payload.command,
      payload.cmd,
    ),
    event: {
      sessionId: firstString(payload.session_id, payload.sessionId),
      turnId: firstString(payload.turn_id, payload.turnId),
      toolUseId: firstString(payload.tool_use_id, payload.toolUseId, payload.tool_call_id),
    },
    exitCode: exitCodeFrom(payload.tool_response ?? payload.response ?? payload.result),
  };
}

export function evaluateCommandHookEvent(payload, options) {
  const normalized = normalizeCommandHookEvent(payload, options.harness);
  const stateOptions = {
    cwd: normalized.cwd,
    event: normalized.event,
    stateDirectory: options.stateDirectory,
  };
  if (normalized.eventName === "UserPromptSubmit") {
    recordGitAuthorizations({ ...stateOptions, prompt: normalized.prompt });
    return { kind: "none" };
  }
  if (normalized.eventName === "PreToolUse") {
    const result = beginGitCommandAuthorization({ ...stateOptions, command: normalized.command });
    if (!result.allowed) {
      return { kind: "block", message: gitAuthorizationMessage(result.requirement) };
    }
    return { kind: "none" };
  }
  if (["PostToolUse", "PostToolUseFailure"].includes(normalized.eventName)) {
    const results = finishGitCommandAuthorization({
      ...stateOptions,
      command: normalized.command,
      exitCode: normalized.exitCode,
    });
    if (results.some((result) => result.outcome === "retry")) {
      return {
        kind: "retry",
        message: "Git-разрешение ещё действует. Исправь причину и повтори ту же операцию.",
      };
    }
  }
  return { kind: "none" };
}

export function renderCommandHookDecision(decision, harness, eventName) {
  if (decision.kind === "none") return { output: null, exitCode: 0 };
  if (decision.kind === "block") {
    if (harness === "codex") return { output: decision.message, stream: "stderr", exitCode: 2 };
    if (harness === "qwen") {
      return { output: JSON.stringify({ decision: "block", reason: decision.message }), stream: "stdout", exitCode: 0 };
    }
    return {
      output: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: eventName,
          permissionDecision: "deny",
          permissionDecisionReason: decision.message,
        },
      }),
      stream: "stdout",
      exitCode: 0,
    };
  }
  const output = harness === "qwen"
    ? { hookSpecificOutput: { additionalContext: decision.message } }
    : { systemMessage: decision.message };
  return { output: JSON.stringify(output), stream: "stdout", exitCode: 0 };
}
