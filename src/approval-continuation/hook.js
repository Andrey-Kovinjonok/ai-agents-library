import {
  isTrustedWorkingDirectory,
  readApprovalContinuationSettings,
} from "./config.js";
import {
  approvalClassFor,
  commandFrom,
  continuationDecision,
  destructiveReason,
  findExitCode,
  sanitizeVerification,
  workingDirectoryFrom,
} from "./policy.js";
import {
  readVerificationCandidates,
  recordVerificationObservation,
} from "./observations.js";

function permissionDecision(payload, settings, options) {
  const workingDirectory = workingDirectoryFrom(payload);
  if (!isTrustedWorkingDirectory(workingDirectory, settings, options)) return null;
  const approvalClass = approvalClassFor(commandFrom(payload));
  if (approvalClass === null) return null;
  if (!settings.approval.enabledClasses.includes(approvalClass)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "allow",
        message: `Allowed configured class: ${approvalClass}`,
      },
    },
  };
}

function safetyDecision(payload, settings) {
  if (!settings.safety.enabled) return null;
  const reason = destructiveReason(commandFrom(payload));
  if (reason === null) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

async function observe(payload, settings, options) {
  const workingDirectory = workingDirectoryFrom(payload);
  if (!settings.observations.enabled) return null;
  if (!isTrustedWorkingDirectory(workingDirectory, settings, options)) return null;
  const command = sanitizeVerification(commandFrom(payload));
  const exitCode = findExitCode(payload.tool_response);
  if (command === null || exitCode === null || workingDirectory === "") return null;
  await recordVerificationObservation({
    command,
    exitCode,
    workingDirectory,
  }, options);
  return null;
}

function sessionContext(payload, settings, options) {
  const workingDirectory = workingDirectoryFrom(payload);
  if (!settings.observations.enabled) return null;
  if (!isTrustedWorkingDirectory(workingDirectory, settings, options)) return null;
  const candidates = readVerificationCandidates(workingDirectory, options);
  if (candidates.length === 0) return null;
  const lines = [
    "Approval-continuation repository observations (hints, not policy; verify against current configuration):",
    ...candidates.map((candidate) => (
      `- Failed: ${candidate.failed}; later worked: ${candidate.worked} `
      + `(observed ${candidate.count ?? 1}x).`
    )),
  ];
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: lines.join("\n"),
    },
  };
}

/** Evaluate one Codex-compatible event using settings read at call time. */
export async function evaluateApprovalContinuationEvent(payload, options = {}) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const settings = readApprovalContinuationSettings(options);
  switch (payload.hook_event_name) {
    case "PermissionRequest":
      return permissionDecision(payload, settings, options);
    case "PreToolUse":
      return safetyDecision(payload, settings);
    case "PostToolUse":
      return observe(payload, settings, options);
    case "SessionStart":
      return sessionContext(payload, settings, options);
    case "Stop":
      return continuationDecision(payload, settings.continuation, options);
    default:
      return null;
  }
}

async function readStream(stream) {
  let value = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) value += chunk;
  return value;
}

export async function runApprovalContinuationHook(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  let payload;
  try {
    payload = JSON.parse(await readStream(input));
  } catch {
    return 0;
  }
  const decision = await evaluateApprovalContinuationEvent(payload, options);
  if (decision !== null) {
    output.write(`${JSON.stringify(decision)}\n`);
  }
  return 0;
}
