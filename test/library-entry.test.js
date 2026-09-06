import assert from "node:assert/strict";
import test from "node:test";

import * as agentLibrary from "ai-agents-library";

test("корень общей библиотеки экспортирует первый переиспользуемый модуль", () => {
  assert.equal(typeof agentLibrary.resolveProjectIdentity, "function");
  assert.equal(typeof agentLibrary.agentProductPaths, "function");
  assert.equal(typeof agentLibrary.resolveProductProject, "function");
  assert.equal(typeof agentLibrary.ensureProductProject, "function");
  assert.equal(typeof agentLibrary.resolveBranchTargets, "function");
  assert.equal(typeof agentLibrary.migrateLegacyBranchTargets, "function");
  assert.equal(agentLibrary.CURRENT_BRANCH_TARGET, "__CURERNT__");
  assert.equal(typeof agentLibrary.evaluateApprovalContinuationEvent, "function");
  assert.equal(typeof agentLibrary.installApprovalContinuation, "function");
});
