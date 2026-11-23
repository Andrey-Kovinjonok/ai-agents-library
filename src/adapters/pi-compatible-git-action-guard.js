import {
  beginGitCommandAuthorization,
  finishGitCommandAuthorization,
  gitAuthorizationMessage,
  recordGitAuthorizations,
} from "../approval-continuation/git-action-approval.js";

function sessionEvent(ctx, toolUseId = "") {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    turnId: ctx.sessionManager.getLeafId?.() ?? "",
    toolUseId,
  };
}

export function registerPiCompatibleGitActionGuard(pi, options = {}) {
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    recordGitAuthorizations({
      prompt: event.text,
      cwd: ctx.cwd,
      event: sessionEvent(ctx),
      stateDirectory: options.stateDirectory,
    });
    return { action: "continue" };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" || typeof event.input?.command !== "string") return undefined;
    const result = beginGitCommandAuthorization({
      command: event.input.command,
      cwd: ctx.cwd,
      event: sessionEvent(ctx, event.toolCallId),
      stateDirectory: options.stateDirectory,
    });
    if (result.allowed) return undefined;
    return { block: true, reason: gitAuthorizationMessage(result.requirement) };
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash" || typeof event.input?.command !== "string") return undefined;
    const results = finishGitCommandAuthorization({
      command: event.input.command,
      cwd: ctx.cwd,
      event: sessionEvent(ctx, event.toolCallId),
      exitCode: Number.isInteger(event.details?.exitCode) ? event.details.exitCode : null,
      stateDirectory: options.stateDirectory,
    });
    if (!results.some((result) => result.outcome === "retry")) return undefined;
    return {
      content: [
        ...event.content,
        { type: "text", text: "Git-разрешение ещё действует. Исправь причину и повтори ту же операцию." },
      ],
    };
  });
}
