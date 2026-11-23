import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { branchDirectoryName, createGitSourceSnapshot, readGitCheckout } from "ai-agents-library/git-checkout";

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-source-snapshot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "beta");
  fs.writeFileSync(path.join(repo, "main.js"), "export const value = 1;\n");
  git(repo, "add", "main.js");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "fixture");
  return { root, repo };
}

test("имена каталогов различают регистр, косую черту, дефис и знак процента", () => {
  const keys = ["refs/heads/feature/x", "refs/heads/feature-x", "refs/heads/Feature/x", "refs/heads/feature%2Fx", "refs/remotes/origin/beta"];
  const names = keys.map(branchDirectoryName);
  assert.equal(new Set(names.map(n => n.toLowerCase())).size, keys.length);
  assert.ok(names.every(name => !/[\\/]/.test(name)));
  assert.throws(() => branchDirectoryName("../bad"));
});

test("снимок читает текущие обычные файлы, не трогает источник и исключает окружение/ссылки", t => {
  const { root, repo } = fixture(t);
  fs.writeFileSync(path.join(repo, "main.js"), "export const value = 2;\n");
  fs.writeFileSync(path.join(repo, ".env"), "SYNTHETIC_FIXTURE=not-a-secret\n");
  fs.writeFileSync(path.join(repo, "private.env"), "SYNTHETIC_FIXTURE=not-a-secret\n");
  fs.symlinkSync(path.join(repo, ".env"), path.join(repo, "linked.js"));
  const before = git(repo, "status", "--porcelain=v1");
  const state = readGitCheckout(repo);
  assert.equal(state.branch, "beta");
  const result = createGitSourceSnapshot({ checkoutPath: repo, destination: path.join(root, "snapshot"),
    reference: "HEAD", workingTree: true, branch: "beta" });
  assert.equal(result.sourceCommit, state.commit);
  assert.equal(fs.readFileSync(path.join(result.directory, "main.js"), "utf8"), "export const value = 2;\n");
  for (const name of [".env", "private.env", "linked.js"]) assert.equal(fs.existsSync(path.join(result.directory, name)), false);
  assert.equal(git(repo, "status", "--porcelain=v1"), before);
  assert.equal(git(repo, "rev-parse", "HEAD"), state.commit);
  assert.equal(git(result.directory, "status", "--porcelain=v1"), "");
  assert.equal(git(result.directory, "branch", "--show-current"), "beta");
});

test("заданная ветка берётся из её снимка, а не из изменённого рабочего файла", t => {
  const { root, repo } = fixture(t);
  fs.writeFileSync(path.join(repo, "main.js"), "different working tree\n");
  const result = createGitSourceSnapshot({ checkoutPath: repo, destination: path.join(root, "fixed"),
    reference: "refs/heads/beta", workingTree: false, branch: "origin/beta" });
  assert.equal(fs.readFileSync(path.join(result.directory, "main.js"), "utf8"), "export const value = 1;\n");
  assert.equal(git(result.directory, "branch", "--show-current"), "origin/beta");
});

test("новый технический снимок наследует безопасную историю предыдущего, не изменяя его", t => {
  const { root, repo } = fixture(t);
  const first = createGitSourceSnapshot({ checkoutPath: repo, destination: path.join(root, "first"),
    reference: "HEAD", workingTree: true, branch: "beta" });
  fs.writeFileSync(path.join(repo, "main.js"), "export const value = 3;\n");
  const second = createGitSourceSnapshot({ checkoutPath: repo, destination: path.join(root, "second"),
    reference: "HEAD", workingTree: true, branch: "feature/task", previousSnapshot: first.directory });
  assert.equal(git(second.directory, "rev-parse", "HEAD^"), first.snapshotCommit);
  assert.equal(git(first.directory, "rev-parse", "HEAD"), first.snapshotCommit);
  assert.equal(fs.readFileSync(path.join(first.directory, "main.js"), "utf8"), "export const value = 1;\n");
  assert.notEqual(first.sourceFingerprint, second.sourceFingerprint);
});

test("существующая папка и размещение внутри исходника запрещены без удаления данных", t => {
  const { root, repo } = fixture(t);
  assert.throws(() => createGitSourceSnapshot({ checkoutPath: repo, destination: repo,
    reference: "HEAD", workingTree: true, branch: "beta" }));
  assert.throws(() => createGitSourceSnapshot({ checkoutPath: repo, destination: path.join(repo, "state"),
    reference: "HEAD", workingTree: true, branch: "beta" }));
  assert.equal(fs.existsSync(path.join(repo, "state")), false);
  const existing = path.join(root, "existing");
  fs.mkdirSync(existing);
  fs.writeFileSync(path.join(existing, "keep"), "keep");
  assert.throws(() => createGitSourceSnapshot({ checkoutPath: repo, destination: existing,
    reference: "HEAD", workingTree: true, branch: "beta" }));
  assert.equal(fs.readFileSync(path.join(existing, "keep"), "utf8"), "keep");
});
