import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  beginGitActionPermission,
  createGitActionPermission,
  finishGitActionPermission,
  gitRequirementsFromCommand,
} from "ai-agents-library/approval-continuation";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-action-permission-"));
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
  return {
    root,
    repository,
    worktree,
    stateDirectory,
    event: { sessionId: "session-1", turnId: "turn-1" },
  };
}

function attempt(event, toolUseId) {
  return { ...event, toolUseId };
}

test("unstage is not a rollback but worktree restore is", () => {
  assert.deepEqual(gitRequirementsFromCommand("git restore --staged src/app.js"), []);
  assert.equal(gitRequirementsFromCommand("git restore src/app.js")[0].kind, "rollback");
  assert.equal(
    gitRequirementsFromCommand("git restore --staged --worktree src/app.js")[0].kind,
    "rollback",
  );
});

test("permission created in main checkout binds to the first linked worktree", (context) => {
  const value = fixture();
  context.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  createGitActionPermission({
    kind: "commit",
    cwd: value.repository,
    event: value.event,
    stateDirectory: value.stateDirectory,
  });

  assert.equal(beginGitActionPermission({
    kind: "commit",
    cwd: value.worktree,
    event: attempt(value.event, "first"),
    stateDirectory: value.stateDirectory,
  }), true);
  assert.equal(finishGitActionPermission({
    kind: "commit",
    cwd: value.worktree,
    event: attempt(value.event, "first"),
    exitCode: null,
    changesBranchRef: true,
    stateDirectory: value.stateDirectory,
  }), "retry");

  assert.equal(beginGitActionPermission({
    kind: "commit",
    cwd: value.repository,
    event: attempt(value.event, "wrong-worktree"),
    stateDirectory: value.stateDirectory,
  }), false);
  assert.equal(beginGitActionPermission({
    kind: "commit",
    cwd: value.worktree,
    event: attempt(value.event, "second"),
    stateDirectory: value.stateDirectory,
  }), true);
});

test("text-only failure keeps permission until the exact branch changes", (context) => {
  const value = fixture();
  context.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  createGitActionPermission({
    kind: "commit", cwd: value.repository, event: value.event,
    stateDirectory: value.stateDirectory,
  });
  const first = attempt(value.event, "first");
  assert.equal(beginGitActionPermission({
    kind: "commit", cwd: value.worktree, event: first,
    stateDirectory: value.stateDirectory,
  }), true);
  assert.equal(finishGitActionPermission({
    kind: "commit", cwd: value.worktree, event: first, exitCode: null,
    changesBranchRef: true, stateDirectory: value.stateDirectory,
  }), "retry");

  const second = attempt(value.event, "second");
  assert.equal(beginGitActionPermission({
    kind: "commit", cwd: value.worktree, event: second,
    stateDirectory: value.stateDirectory,
  }), true);
  git(value.worktree, "commit", "-q", "--allow-empty", "-m", "permitted");
  assert.equal(finishGitActionPermission({
    kind: "commit", cwd: value.worktree, event: second, exitCode: null,
    changesBranchRef: true, stateDirectory: value.stateDirectory,
  }), "completed");
  assert.equal(beginGitActionPermission({
    kind: "commit", cwd: value.worktree,
    event: attempt(value.event, "third"), stateDirectory: value.stateDirectory,
  }), false);
});

test("an unrelated local branch update does not consume commit permission", (context) => {
  const value = fixture();
  context.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  createGitActionPermission({
    kind: "commit", cwd: value.repository, event: value.event,
    stateDirectory: value.stateDirectory,
  });
  const first = attempt(value.event, "first");
  assert.equal(beginGitActionPermission({
    kind: "commit", cwd: value.worktree, event: first,
    stateDirectory: value.stateDirectory,
  }), true);
  git(value.repository, "branch", "unrelated");
  assert.equal(finishGitActionPermission({
    kind: "commit", cwd: value.worktree, event: first, exitCode: 0,
    changesBranchRef: true, stateDirectory: value.stateDirectory,
  }), "retry");
});

test("push permission survives an unknown result and is consumed by exit code zero", (context) => {
  const value = fixture();
  context.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  createGitActionPermission({
    kind: "push", cwd: value.repository, event: value.event,
    stateDirectory: value.stateDirectory,
  });
  const first = attempt(value.event, "first");
  assert.equal(beginGitActionPermission({
    kind: "push", cwd: value.repository, event: first,
    stateDirectory: value.stateDirectory,
  }), true);
  assert.equal(finishGitActionPermission({
    kind: "push", cwd: value.repository, event: first, exitCode: null,
    changesBranchRef: false, stateDirectory: value.stateDirectory,
  }), "retry");

  const second = attempt(value.event, "second");
  assert.equal(beginGitActionPermission({
    kind: "push", cwd: value.repository, event: second,
    stateDirectory: value.stateDirectory,
  }), true);
  assert.equal(finishGitActionPermission({
    kind: "push", cwd: value.repository, event: second, exitCode: 0,
    changesBranchRef: false, stateDirectory: value.stateDirectory,
  }), "completed");
  assert.equal(beginGitActionPermission({
    kind: "push", cwd: value.repository,
    event: attempt(value.event, "third"), stateDirectory: value.stateDirectory,
  }), false);
});
