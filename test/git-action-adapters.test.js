import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  evaluateCommandHookEvent,
  renderCommandHookDecision,
} from "ai-agents-library/approval-continuation";
import { registerPiCompatibleGitActionGuard } from "../src/adapters/pi-compatible-git-action-guard.js";
import { createOpenCodeV1GitActionGuard } from "../src/adapters/opencode-v1.js";
import { defineOpenCodeV2GitActionGuard } from "../src/adapters/opencode-v2.js";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-action-adapter-"));
  const repository = path.join(root, "repository");
  const worktree = path.join(root, "feature-worktree");
  const stateDirectory = path.join(root, "state");
  fs.mkdirSync(repository);
  fs.mkdirSync(stateDirectory);
  git(repository, "init", "-q", "-b", "main");
  git(repository, "config", "user.email", "test@example.invalid");
  git(repository, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repository, "tracked.txt"), "base\n");
  git(repository, "add", "tracked.txt");
  git(repository, "commit", "-q", "-m", "initial");
  git(repository, "worktree", "add", "-q", "-b", "feature/test", worktree);
  return { root, repository, worktree, stateDirectory };
}

test("Codex command adapter keeps authorization after text-only failure", (context) => {
  const value = fixture();
  context.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  assert.deepEqual(evaluateCommandHookEvent({
    hook_event_name: "UserPromptSubmit", session_id: "session", turn_id: "turn",
    cwd: value.repository, prompt: "КОММИТЬ",
  }, { harness: "codex", stateDirectory: value.stateDirectory }), { kind: "none" });
  assert.equal(evaluateCommandHookEvent({
    hook_event_name: "PreToolUse", session_id: "session", tool_use_id: "first",
    tool_input: { cmd: "git commit -m test", workdir: value.worktree },
  }, { harness: "codex", stateDirectory: value.stateDirectory }).kind, "none");
  const retry = evaluateCommandHookEvent({
    hook_event_name: "PostToolUse", session_id: "session", tool_use_id: "first",
    tool_input: { cmd: "git commit -m test", workdir: value.worktree },
    tool_response: "fatal: index.lock: Operation not permitted",
  }, { harness: "codex", stateDirectory: value.stateDirectory });
  assert.equal(retry.kind, "retry");
  assert.equal(evaluateCommandHookEvent({
    hook_event_name: "PreToolUse", session_id: "session", tool_use_id: "second",
    tool_input: { cmd: "git commit -m test", workdir: value.worktree },
  }, { harness: "codex", stateDirectory: value.stateDirectory }).kind, "none");
});

test("Qwen adapter trusts submitted_prompt but not generated prompt", (context) => {
  const value = fixture();
  context.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  evaluateCommandHookEvent({
    hook_event_name: "UserPromptSubmit", session_id: "session", cwd: value.repository,
    prompt: "КОММИТЬ",
  }, { harness: "qwen", stateDirectory: value.stateDirectory });
  assert.equal(evaluateCommandHookEvent({
    hook_event_name: "PreToolUse", session_id: "session", tool_use_id: "first",
    tool_input: { command: "git commit -m test", cwd: value.repository },
  }, { harness: "qwen", stateDirectory: value.stateDirectory }).kind, "block");

  evaluateCommandHookEvent({
    hook_event_name: "UserPromptSubmit", session_id: "session", cwd: value.repository,
    submitted_prompt: "КОММИТЬ", prompt: "expanded content",
  }, { harness: "qwen", stateDirectory: value.stateDirectory });
  assert.equal(evaluateCommandHookEvent({
    hook_event_name: "PreToolUse", session_id: "session", tool_use_id: "second",
    tool_input: { command: "git commit -m test", cwd: value.repository },
  }, { harness: "qwen", stateDirectory: value.stateDirectory }).kind, "none");
});

test("Claude block result uses a PreToolUse denial object", () => {
  const rendered = renderCommandHookDecision(
    { kind: "block", message: "blocked" }, "claude", "PreToolUse",
  );
  assert.equal(rendered.exitCode, 0);
  assert.deepEqual(JSON.parse(rendered.output), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "blocked",
    },
  });
});

test("Pi-compatible adapter captures input and blocks a second commit", async (context) => {
  const value = fixture();
  context.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const handlers = new Map();
  const pi = { on: (name, handler) => handlers.set(name, handler) };
  registerPiCompatibleGitActionGuard(pi, { stateDirectory: value.stateDirectory });
  const sessionManager = {
    getSessionId: () => "session",
    getLeafId: () => "turn",
  };
  const ctx = { cwd: value.worktree, sessionManager };
  await handlers.get("input")({ text: "КОММИТЬ", source: "interactive" }, ctx);
  assert.equal(await handlers.get("tool_call")({
    toolName: "bash", toolCallId: "first", input: { command: "git commit -m test" },
  }, ctx), undefined);
  git(value.worktree, "commit", "-q", "--allow-empty", "-m", "permitted");
  await handlers.get("tool_result")({
    toolName: "bash", toolCallId: "first", input: { command: "git commit -m test" },
    content: [], details: { exitCode: 0 },
  }, ctx);
  assert.equal((await handlers.get("tool_call")({
    toolName: "bash", toolCallId: "second", input: { command: "git commit -m second" },
  }, ctx)).block, true);
});

test("OpenCode v1 adapter reads only user messages", async (context) => {
  const value = fixture();
  context.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const hooks = createOpenCodeV1GitActionGuard(
    { directory: value.repository }, { stateDirectory: value.stateDirectory },
  );
  await hooks["chat.message"](
    { sessionID: "session", messageID: "turn" },
    { message: { role: "assistant" }, parts: [{ type: "text", text: "КОММИТЬ" }] },
  );
  await assert.rejects(
    hooks["tool.execute.before"](
      { tool: "bash", sessionID: "session", callID: "first" },
      { args: { command: "git commit -m test" } },
    ),
    /КОММИТЬ/u,
  );
});

test("OpenCode v1 adapter consumes push permission from a nested exit code", async (context) => {
  const value = fixture();
  context.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const hooks = createOpenCodeV1GitActionGuard(
    { directory: value.repository }, { stateDirectory: value.stateDirectory },
  );
  await hooks["chat.message"](
    { sessionID: "session", messageID: "turn" },
    { message: { role: "user" }, parts: [{ type: "text", text: "ПУШ" }] },
  );
  const before = { tool: "bash", sessionID: "session", callID: "first" };
  const args = { command: "git push" };
  await hooks["tool.execute.before"](before, { args });
  await hooks["tool.execute.after"]({ ...before, args }, {
    title: "push", output: "done", metadata: { process: { exitCode: 0 } },
  });
  await assert.rejects(
    hooks["tool.execute.before"](
      { tool: "bash", sessionID: "session", callID: "second" }, { args },
    ),
    /ПУШ/u,
  );
});

test("OpenCode v2 adapter registers prompt and tool boundaries", async (context) => {
  const value = fixture();
  context.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const handlers = {};
  const ctx = {
    location: { directory: value.repository },
    session: { hook: async (name, handler) => { handlers[`session:${name}`] = handler; } },
    tool: { hook: async (name, handler) => { handlers[`tool:${name}`] = handler; } },
  };
  await defineOpenCodeV2GitActionGuard({ stateDirectory: value.stateDirectory }).setup(ctx);
  assert.deepEqual(Object.keys(handlers).sort(), [
    "session:prompt", "tool:execute.after", "tool:execute.before",
  ]);
  await handlers["session:prompt"]({
    sessionID: "session", messageID: "turn", prompt: { text: "КОММИТЬ" },
  });
  await handlers["tool:execute.before"]({
    tool: "bash", sessionID: "session", callID: "first",
    input: { command: "git commit -m test" },
  });
});
