import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  evaluateApprovalContinuationEvent,
} from "ai-agents-library/approval-continuation";
import {
  agentProductPaths,
  resolveProjectIdentity,
} from "ai-agents-library/project-locations";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const HOOK_BIN = path.join(PACKAGE_ROOT, "bin", "approval-continuation-hook.js");

function productConfigFile(agentsRoot) {
  return path.join(
    agentsRoot,
    "skills",
    "approval-continuation",
    "config.json",
  );
}

function writeConfig(agentsRoot, trustedRoots, enabledClasses = []) {
  const file = productConfigFile(agentsRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    schemaVersion: 1,
    projects: {},
    settings: {
      trustedWorkRoots: trustedRoots,
      approval: { enabledClasses },
      continuation: { enabled: true },
      observations: { enabled: true },
      safety: { enabled: false },
    },
  }, null, 2)}\n`);
}

function runHook(payload, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      HOOK_BIN,
      "--agents-root",
      options.agentsRoot,
      "--user-home",
      options.homeDir,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`hook exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolve(stdout);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

test("настройки подтверждения перечитываются без перезапуска модуля", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "approval-live-config-"));
  const homeDir = path.join(temp, "home", "tester");
  const agentsRoot = path.join(homeDir, ".agents");
  const repository = path.join(homeDir, "WORK", "project");
  fs.mkdirSync(repository, { recursive: true });
  const payload = {
    hook_event_name: "PermissionRequest",
    tool_input: {
      cmd: "node --check src/app.js",
      workdir: repository,
    },
  };

  writeConfig(agentsRoot, [repository], []);
  const first = await evaluateApprovalContinuationEvent(payload, {
    agentsRoot,
    homeDir,
  });
  assert.equal(first, null);

  writeConfig(agentsRoot, [repository], ["node-check"]);
  const second = await evaluateApprovalContinuationEvent(payload, {
    agentsRoot,
    homeDir,
  });
  assert.equal(
    second.hookSpecificOutput.decision.behavior,
    "allow",
  );
  fs.rmSync(temp, { recursive: true, force: true });
});

test("произвольный пакетный тест не подтверждается автоматически", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "approval-package-script-"));
  const homeDir = path.join(temp, "home", "tester");
  const agentsRoot = path.join(homeDir, ".agents");
  const repository = path.join(homeDir, "WORK", "project");
  fs.mkdirSync(repository, { recursive: true });
  writeConfig(agentsRoot, [repository], ["node-check"]);

  const decision = await evaluateApprovalContinuationEvent({
    hook_event_name: "PermissionRequest",
    tool_input: { cmd: "npm test", workdir: repository },
  }, { agentsRoot, homeDir });

  assert.equal(decision, null);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("наблюдения используют читаемый каталог проекта из общей библиотеки", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "approval-readable-project-"));
  const homeDir = path.join(temp, "home", "tester");
  const agentsRoot = path.join(homeDir, ".agents");
  const repository = path.join(homeDir, "WORK", "OF", "frontend");
  const link = path.join(temp, "frontend-link");
  fs.mkdirSync(repository, { recursive: true });
  fs.symlinkSync(repository, link, "dir");
  writeConfig(agentsRoot, [repository]);

  await evaluateApprovalContinuationEvent({
    hook_event_name: "PostToolUse",
    tool_input: { cmd: "node --check src/app.js", workdir: link },
    tool_response: { exit_code: 0 },
  }, { agentsRoot, homeDir });

  const identity = resolveProjectIdentity(repository, { homeDir });
  const paths = agentProductPaths("approval-continuation", identity, { agentsRoot });
  const config = JSON.parse(fs.readFileSync(paths.productConfigFile, "utf8"));
  const stateFile = path.join(paths.projectDirectory, "observations.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(identity.alias, "frontend_of_work_tester");
  assert.equal(
    config.projects[identity.canonicalPath].directory,
    `projects/${identity.alias}`,
  );
  assert.equal(state.project.canonicalPath, identity.canonicalPath);
  assert.equal(state.project.alias, identity.alias);
  assert.equal(state.outcomes["node --check src/app.js"].success, 1);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("несколько процессов не теряют наблюдения", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "approval-concurrent-"));
  const homeDir = path.join(temp, "home", "tester");
  const agentsRoot = path.join(homeDir, ".agents");
  const repository = path.join(homeDir, "WORK", "OF", "frontend");
  fs.mkdirSync(repository, { recursive: true });
  writeConfig(agentsRoot, [repository]);
  const payload = {
    hook_event_name: "PostToolUse",
    tool_input: { cmd: "node --check src/app.js", workdir: repository },
    tool_response: { exit_code: 0 },
  };

  await Promise.all(Array.from(
    { length: 12 },
    () => runHook(payload, { agentsRoot, homeDir }),
  ));

  const identity = resolveProjectIdentity(repository, { homeDir });
  const paths = agentProductPaths("approval-continuation", identity, { agentsRoot });
  const state = JSON.parse(fs.readFileSync(
    path.join(paths.projectDirectory, "observations.json"),
    "utf8",
  ));
  assert.equal(state.outcomes["node --check src/app.js"].success, 12);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("продолжение срабатывает один раз и уважает защиту от цикла", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "approval-stop-guard-"));
  const homeDir = path.join(temp, "home", "tester");
  const agentsRoot = path.join(homeDir, ".agents");
  fs.mkdirSync(homeDir, { recursive: true });
  writeConfig(agentsRoot, [homeDir]);
  const payload = {
    hook_event_name: "Stop",
    last_assistant_message: "Осталось запустить обещанные проверки.",
  };

  const first = await evaluateApprovalContinuationEvent(payload, {
    agentsRoot,
    homeDir,
  });
  const second = await evaluateApprovalContinuationEvent({
    ...payload,
    stop_hook_active: true,
  }, { agentsRoot, homeDir });

  assert.equal(first.decision, "block");
  assert.equal(second, null);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("неудачная и затем успешная проверка становятся только подсказкой", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "approval-candidate-"));
  const homeDir = path.join(temp, "home", "tester");
  const agentsRoot = path.join(homeDir, ".agents");
  const repository = path.join(homeDir, "WORK", "OF", "frontend");
  fs.mkdirSync(repository, { recursive: true });
  writeConfig(agentsRoot, [repository]);

  await evaluateApprovalContinuationEvent({
    hook_event_name: "PostToolUse",
    tool_input: { cmd: "npm run lint", workdir: repository },
    tool_response: { exit_code: 1 },
  }, { agentsRoot, homeDir });
  await evaluateApprovalContinuationEvent({
    hook_event_name: "PostToolUse",
    tool_input: { cmd: "node --check src/app.js", workdir: repository },
    tool_response: { exit_code: 0 },
  }, { agentsRoot, homeDir });

  const context = await evaluateApprovalContinuationEvent({
    hook_event_name: "SessionStart",
    workdir: repository,
  }, { agentsRoot, homeDir });
  assert.match(context.hookSpecificOutput.additionalContext, /npm run lint/u);
  assert.match(context.hookSpecificOutput.additionalContext, /node --check src\/app\.js/u);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("команда с файлом окружения не подтверждается и не записывается", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "approval-env-file-"));
  const homeDir = path.join(temp, "home", "tester");
  const agentsRoot = path.join(homeDir, ".agents");
  const repository = path.join(homeDir, "WORK", "project");
  fs.mkdirSync(repository, { recursive: true });
  writeConfig(agentsRoot, [repository], ["node-check"]);

  const decision = await evaluateApprovalContinuationEvent({
    hook_event_name: "PermissionRequest",
    tool_input: { cmd: "node --check .env", workdir: repository },
  }, { agentsRoot, homeDir });
  await evaluateApprovalContinuationEvent({
    hook_event_name: "PostToolUse",
    tool_input: { cmd: "node --check .env", workdir: repository },
    tool_response: { exit_code: 0 },
  }, { agentsRoot, homeDir });

  const config = JSON.parse(fs.readFileSync(productConfigFile(agentsRoot), "utf8"));
  assert.equal(decision, null);
  assert.deepEqual(config.projects, {});
  fs.rmSync(temp, { recursive: true, force: true });
});
