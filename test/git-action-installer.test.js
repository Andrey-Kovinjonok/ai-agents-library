import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GitActionGuardInstallError,
  installGitActionGuard,
} from "ai-agents-library/approval-continuation";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");

test("installer configures all command hooks and extension links without replacing entries", (context) => {
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), "git-action-install-"));
  context.after(() => fs.rmSync(userHome, { recursive: true, force: true }));
  const claudeFile = path.join(userHome, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
  fs.writeFileSync(claudeFile, JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "keep-me" }] }] },
    theme: "dark",
  }));

  const result = installGitActionGuard({
    agents: ["all"],
    userHome,
    codexHome: path.join(userHome, ".codex"),
    packageRoot: PACKAGE_ROOT,
    nodeExecutable: process.execPath,
    openCodeMajor: 1,
  });
  assert.deepEqual(result.agents, ["codex", "claude", "qwen", "pi", "oh-my-pi", "opencode"]);

  const claude = JSON.parse(fs.readFileSync(claudeFile, "utf8"));
  assert.equal(claude.theme, "dark");
  assert.equal(claude.hooks.PreToolUse[0].hooks[0].command, "keep-me");
  assert.match(claude.hooks.PreToolUse[1].hooks[0].command, /--harness claude/u);
  assert.equal(claude.hooks.PostToolUseFailure.length, 1);

  const qwen = JSON.parse(fs.readFileSync(path.join(userHome, ".qwen", "settings.json"), "utf8"));
  assert.equal(qwen.hooks.PreToolUse[0].sequential, true);
  assert.equal(qwen.hooks.PreToolUse[0].matcher, "^run_shell_command$");
  const codex = JSON.parse(fs.readFileSync(path.join(userHome, ".codex", "hooks.json"), "utf8"));
  assert.equal(codex.hooks.PostToolUseFailure, undefined);

  assert.match(fs.realpathSync(path.join(userHome, ".pi", "agent", "extensions", "git-action-guard.js")), /src\/adapters\/pi\.js$/u);
  assert.match(fs.realpathSync(path.join(userHome, ".omp", "agent", "hooks", "git-action-guard.js")), /src\/adapters\/oh-my-pi\.js$/u);
  assert.match(fs.realpathSync(path.join(userHome, ".config", "opencode", "plugins", "git-action-guard.js")), /src\/adapters\/opencode-v1\.js$/u);
});

test("installer refuses a conflicting adapter before changing JSON settings", (context) => {
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), "git-action-conflict-"));
  context.after(() => fs.rmSync(userHome, { recursive: true, force: true }));
  const conflict = path.join(userHome, ".pi", "agent", "extensions", "git-action-guard.js");
  fs.mkdirSync(path.dirname(conflict), { recursive: true });
  fs.writeFileSync(conflict, "user file\n");

  assert.throws(() => installGitActionGuard({
    agents: ["codex", "pi"],
    userHome,
    codexHome: path.join(userHome, ".codex"),
    packageRoot: PACKAGE_ROOT,
  }), GitActionGuardInstallError);
  assert.equal(fs.existsSync(path.join(userHome, ".codex", "hooks.json")), false);
  assert.equal(fs.readFileSync(conflict, "utf8"), "user file\n");
});
