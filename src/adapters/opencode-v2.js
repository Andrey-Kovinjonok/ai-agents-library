import {
  beginGitCommandAuthorization,
  finishGitCommandAuthorization,
  gitAuthorizationMessage,
  recordGitAuthorizations,
} from "../approval-continuation/git-action-approval.js";
import { findExitCode } from "../approval-continuation/policy.js";

export function defineOpenCodeV2GitActionGuard(options = {}) {
  return {
    id: "ai-agents-library.git-action-guard",
    async setup(ctx) {
      const defaultCwd = ctx.location.directory;
      await ctx.session.hook("prompt", (event) => {
        recordGitAuthorizations({
          prompt: event.prompt.text,
          cwd: defaultCwd,
          event: { sessionId: event.sessionID, turnId: event.messageID ?? "" },
          stateDirectory: options.stateDirectory,
        });
      });
      await ctx.tool.hook("execute.before", (event) => {
        const command = event.input?.command;
        if (event.tool !== "bash" || typeof command !== "string") return;
        const result = beginGitCommandAuthorization({
          command,
          cwd: event.input.cwd ?? event.input.workdir ?? defaultCwd,
          event: { sessionId: event.sessionID, toolUseId: event.callID ?? event.id ?? "" },
          stateDirectory: options.stateDirectory,
        });
        if (!result.allowed) throw new Error(gitAuthorizationMessage(result.requirement));
      });
      await ctx.tool.hook("execute.after", (event) => {
        const command = event.input?.command;
        if (event.tool !== "bash" || typeof command !== "string") return;
        const exitCode = findExitCode(event);
        const results = finishGitCommandAuthorization({
          command,
          cwd: event.input.cwd ?? event.input.workdir ?? defaultCwd,
          event: { sessionId: event.sessionID, toolUseId: event.callID ?? event.id ?? "" },
          exitCode,
          stateDirectory: options.stateDirectory,
        });
        if (results.some((result) => result.outcome === "retry") && event.status === "completed") {
          event.result = {
            ...event.result,
            metadata: { ...event.result?.metadata, gitPermissionRetry: true },
          };
        }
      });
    },
  };
}

export default defineOpenCodeV2GitActionGuard();
