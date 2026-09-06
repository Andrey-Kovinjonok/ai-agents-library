import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ApprovalContinuationInstallError,
  installApprovalContinuation,
} from "ai-agents-library/approval-continuation";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const INSTALL_BIN = path.join(PACKAGE_ROOT, "bin", "install-approval-continuation.js");

test("установщик создаёт один навык, ссылки и точечно объединяет Codex hooks", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "approval-install-"));
  const userHome = path.join(temp, "home");
  const agentsRoot = path.join(userHome, ".agents");
  const codexHome = path.join(userHome, ".codex");
  const work = path.join(userHome, "WORK");
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  const foreign = {
    matcher: "functions.exec_command",
    hooks: [{ type: "command", command: "node foreign-hook.js" }],
  };
  const previousPythonHook = {
    matcher: "exec_command",
    hooks: [{
      type: "command",
      command: "python3 /old/approval-continuation/scripts/acp_hook.py",
    }],
  };
  fs.writeFileSync(path.join(codexHome, "hooks.json"), JSON.stringify({
    custom: { keep: true },
    hooks: { PreToolUse: [foreign, previousPythonHook] },
  }));

  const options = {
    userHome,
    agentsRoot,
    codexHome,
    agents: ["codex", "claude"],
    trustedRoots: [work],
    packageRoot: PACKAGE_ROOT,
  };
  const first = await installApprovalContinuation(options);
  const configBefore = JSON.parse(fs.readFileSync(first.configFile, "utf8"));
  configBefore.settings.continuation.enabled = false;
  configBefore.custom = { keep: true };
  fs.writeFileSync(first.configFile, `${JSON.stringify(configBefore, null, 2)}\n`);
  const projectMarker = path.join(first.canonicalDirectory, "projects", "keep.txt");
  fs.mkdirSync(path.dirname(projectMarker), { recursive: true });
  fs.writeFileSync(projectMarker, "keep\n");

  const second = await installApprovalContinuation(options);

  assert.equal(fs.lstatSync(first.canonicalDirectory).isDirectory(), true);
  assert.equal(fs.lstatSync(first.hookLink).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(first.hookLink), fs.realpathSync(
    path.join(PACKAGE_ROOT, "bin", "approval-continuation-hook.js"),
  ));
  for (const link of [
    path.join(codexHome, "skills", "approval-continuation"),
    path.join(userHome, ".claude", "skills", "approval-continuation"),
  ]) {
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(link), fs.realpathSync(first.canonicalDirectory));
  }
  const configAfter = JSON.parse(fs.readFileSync(second.configFile, "utf8"));
  assert.equal(configAfter.settings.continuation.enabled, false);
  assert.deepEqual(configAfter.custom, { keep: true });
  assert.equal(fs.readFileSync(projectMarker, "utf8"), "keep\n");
  assert.equal(configAfter.legacyLocations.every(
    (entry) => entry.cleanupPolicy === "ask",
  ), true);
  assert.equal(configAfter.legacyLocations.some(
    (entry) => entry.kind === "legacy-python-runtime"
      && entry.path.endsWith("approval-continuation/scripts/acp_hook.py"),
  ), true);

  const hooks = JSON.parse(fs.readFileSync(path.join(codexHome, "hooks.json"), "utf8"));
  assert.deepEqual(hooks.custom, { keep: true });
  assert.deepEqual(
    hooks.hooks.PreToolUse.find((entry) => entry.hooks?.[0]?.command === "node foreign-hook.js"),
    foreign,
  );
  assert.equal(JSON.stringify(hooks).includes("acp_hook.py"), false);
  for (const event of [
    "SessionStart",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "Stop",
  ]) {
    const owned = hooks.hooks[event].filter((entry) => (
      entry.hooks?.[0]?.command?.includes("approval-continuation/scripts/acp-hook.js")
    ));
    assert.equal(owned.length, 1);
    assert.match(owned[0].hooks[0].command, /node/iu);
  }
  assert.match(hooks.hooks.PermissionRequest.at(-1).matcher, /functions\\\.exec_command/u);
  const hookOutput = execFileSync(process.execPath, [
    first.hookLink,
    "--agents-root",
    agentsRoot,
    "--user-home",
    userHome,
  ], {
    encoding: "utf8",
    input: JSON.stringify({
      hook_event_name: "PermissionRequest",
      tool_input: {
        cmd: "node --check src/app.js",
        workdir: work,
      },
    }),
  });
  assert.equal(
    JSON.parse(hookOutput).hookSpecificOutput.decision.behavior,
    "allow",
  );
  fs.rmSync(temp, { recursive: true, force: true });
});

test("команда установки выводит все пути из переданного изолированного дома", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "approval-cli-home-"));
  const userHome = path.join(temp, "home");
  const output = execFileSync(process.execPath, [
    INSTALL_BIN,
    "--user-home",
    userHome,
    "--agent",
    "claude",
  ], { encoding: "utf8" });

  const canonical = path.join(
    userHome,
    ".agents",
    "skills",
    "approval-continuation",
  );
  assert.equal(output.includes(canonical), true);
  assert.equal(fs.lstatSync(canonical).isDirectory(), true);
  assert.equal(fs.lstatSync(path.join(
    userHome,
    ".claude",
    "skills",
    "approval-continuation",
  )).isSymbolicLink(), true);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("режим all связывает все семь поддерживаемых агентов с одним навыком", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "approval-all-agents-"));
  const userHome = path.join(temp, "home");
  const result = await installApprovalContinuation({
    userHome,
    agents: ["all"],
    packageRoot: PACKAGE_ROOT,
  });

  assert.equal(result.links.length, 7);
  for (const link of result.links) {
    assert.equal(fs.lstatSync(link.path).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(link.path), fs.realpathSync(result.canonicalDirectory));
  }
  fs.rmSync(temp, { recursive: true, force: true });
});

test("конфликтующая папка агента сохраняется и останавливает установку до записи", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "approval-link-conflict-"));
  const userHome = path.join(temp, "home");
  const agentsRoot = path.join(userHome, ".agents");
  const codexHome = path.join(userHome, ".codex");
  const conflict = path.join(userHome, ".claude", "skills", "approval-continuation");
  fs.mkdirSync(conflict, { recursive: true });
  const marker = path.join(conflict, "user-file.txt");
  fs.writeFileSync(marker, "keep");

  await assert.rejects(
    installApprovalContinuation({
      userHome,
      agentsRoot,
      codexHome,
      agents: ["claude"],
      packageRoot: PACKAGE_ROOT,
    }),
    ApprovalContinuationInstallError,
  );
  assert.equal(fs.readFileSync(marker, "utf8"), "keep");
  assert.equal(fs.existsSync(path.join(
    agentsRoot,
    "skills",
    "approval-continuation",
  )), false);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("некорректный Codex hooks сохраняется без частичной установки", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "approval-invalid-hooks-"));
  const userHome = path.join(temp, "home");
  const agentsRoot = path.join(userHome, ".agents");
  const codexHome = path.join(userHome, ".codex");
  const hooksFile = path.join(codexHome, "hooks.json");
  const original = "{\"hooks\":{\"PreToolUse\":{\"invalid\":true}}}\n";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(hooksFile, original);

  await assert.rejects(
    installApprovalContinuation({
      userHome,
      agentsRoot,
      codexHome,
      agents: ["codex"],
      packageRoot: PACKAGE_ROOT,
    }),
    ApprovalContinuationInstallError,
  );
  assert.equal(fs.readFileSync(hooksFile, "utf8"), original);
  assert.equal(fs.existsSync(path.join(
    agentsRoot,
    "skills",
    "approval-continuation",
  )), false);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("чужой канонический навык не перезаписывается", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "approval-canonical-conflict-"));
  const userHome = path.join(temp, "home");
  const agentsRoot = path.join(userHome, ".agents");
  const canonical = path.join(
    agentsRoot,
    "skills",
    "approval-continuation",
  );
  fs.mkdirSync(canonical, { recursive: true });
  const marker = path.join(canonical, "SKILL.md");
  const original = "---\nname: another-skill\n---\n";
  fs.writeFileSync(marker, original);

  await assert.rejects(
    installApprovalContinuation({
      userHome,
      agentsRoot,
      codexHome: path.join(userHome, ".codex"),
      agents: ["claude"],
      packageRoot: PACKAGE_ROOT,
    }),
    ApprovalContinuationInstallError,
  );
  assert.equal(fs.readFileSync(marker, "utf8"), original);
  fs.rmSync(temp, { recursive: true, force: true });
});
