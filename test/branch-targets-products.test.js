import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureProductProject, resolveProductProject, resolveBranchTargets } from "ai-agents-library";

test("три отдельные продуктовые настройки используют общие функции без смешивания и без перезапуска", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-branch-products-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, "project");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-b", "beta", repo], { stdio: "ignore" });
  const options = { agentsRoot: path.join(temp, "agents"), homeDir: temp };
  const policies = {
    "git-nexus": ["__CURERNT__", "origin/beta"],
    codegraph: ["__CURERNT__", "current"],
    graphify: ["__CURERNT__", "origin/v8"],
  };
  const configs = {};
  for (const [product, targets] of Object.entries(policies)) {
    const prepared = await ensureProductProject(product, repo, options);
    const config = JSON.parse(fs.readFileSync(prepared.productConfigFile, "utf8"));
    Object.assign(config.projects[prepared.identity.canonicalPath], { targetsVersion: 2, targets, ownField: product });
    fs.writeFileSync(prepared.productConfigFile, JSON.stringify(config));
    configs[product] = { file: prepared.productConfigFile, config, key: prepared.identity.canonicalPath };
  }
  const read = product => {
    const { mapping } = resolveProductProject(product, repo, options);
    assert.equal(mapping.ownField, product);
    return resolveBranchTargets({ ...mapping, currentBranch: "beta", remotes: ["origin"] });
  };
  const before = Object.fromEntries(Object.keys(policies).map(product => [product, read(product)]));
  assert.equal(new Set(Object.values(configs).map(entry => entry.file)).size, 3);
  assert.equal(before["git-nexus"][1].branchKey, "refs/remotes/origin/beta");
  assert.equal(before.codegraph[1].branchKey, "refs/heads/current");
  assert.equal(before.graphify[1].branchKey, "refs/remotes/origin/v8");
  const { file, config, key } = configs["git-nexus"];
  config.projects[key].targets = ["current"];
  fs.writeFileSync(file, JSON.stringify(config));
  assert.deepEqual(read("git-nexus").map(item => item.branchKey), ["refs/heads/current"]);
  assert.deepEqual(read("codegraph"), before.codegraph);
  assert.deepEqual(read("graphify"), before.graphify);
  assert.deepEqual(fs.readdirSync(repo), [".git"]);
});
