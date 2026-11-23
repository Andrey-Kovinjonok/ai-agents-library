import {
  beginGitCommandAuthorization,
  finishGitCommandAuthorization,
  gitAuthorizationMessage,
  recordGitAuthorizations,
} from "../approval-continuation/git-action-approval.js";
import { findExitCode } from "../approval-continuation/policy.js";

function promptText(parts) {
  return Array.isArray(parts)
    ? parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
    : "";
}

export function createOpenCodeV1GitActionGuard(context, options = {}) {
  const defaultCwd = context.directory ?? process.cwd();
  return {
    "chat.message": async (input, output) => {
      if (output.message?.role !== "user") return;
      recordGitAuthorizations({
        prompt: promptText(output.parts),
        cwd: defaultCwd,
        event: { sessionId: input.sessionID, turnId: input.messageID ?? "" },
        stateDirectory: options.stateDirectory,
      });
    },
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash" || typeof output.args?.command !== "string") return;
      const result = beginGitCommandAuthorization({
        command: output.args.command,
        cwd: output.args.cwd ?? output.args.workdir ?? defaultCwd,
        event: { sessionId: input.sessionID, toolUseId: input.callID },
        stateDirectory: options.stateDirectory,
      });
      if (!result.allowed) throw new Error(gitAuthorizationMessage(result.requirement));
    },
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "bash" || typeof input.args?.command !== "string") return;
      const results = finishGitCommandAuthorization({
        command: input.args.command,
        cwd: input.args.cwd ?? input.args.workdir ?? defaultCwd,
        event: { sessionId: input.sessionID, toolUseId: input.callID },
        exitCode: findExitCode(output),
        stateDirectory: options.stateDirectory,
      });
      if (results.some((result) => result.outcome === "retry")) {
        output.output += "\nGit-разрешение ещё действует. Исправь причину и повтори ту же операцию.";
      }
    },
  };
}

export default async function gitActionGuardForOpenCodeV1(context) {
  return createOpenCodeV1GitActionGuard(context);
}
