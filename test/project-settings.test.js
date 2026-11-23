import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { updateProductProject, resolveProductProject } from "ai-agents-library";

test("общая запись настроек меняет только поля выбранного продукта и сохраняет остальные", async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-settings-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, "project");
  fs.mkdirSync(repo);
  const options = { agentsRoot: path.join(temp, "agents"), homeDir: temp };
  await updateProductProject("git-nexus", repo, { enabled: true, targetsVersion: 2,
    targets: ["__CURERNT__", "origin/beta"], ownField: 1 }, options);
  await updateProductProject("git-nexus", repo, { targets: ["current"] }, options);
  const { mapping } = resolveProductProject("git-nexus", repo, options);
  assert.deepEqual(mapping.targets, ["current"]);
  assert.equal(mapping.ownField, 1);
  assert.equal(mapping.enabled, true);
  assert.equal(mapping.targetsVersion, 2);
  assert.deepEqual(fs.readdirSync(repo), []);
  await assert.rejects(updateProductProject("git-nexus", repo, { directory: "../outside" }, options));
  assert.equal(resolveProductProject("git-nexus", repo, options).mapping.directory, mapping.directory);
});
