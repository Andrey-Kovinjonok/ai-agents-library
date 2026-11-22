/** Exact public spelling requested by the caller; other spellings are literal branches. */
export const CURRENT_BRANCH_TARGET = "__CURERNT__";
export const JUST_CURRENT_BRANCH_TARGET = "__JUST_CURRENT_BRANCH__";
export const BRANCH_TARGETS_VERSION = 2;

function assertObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
}

// Conservative branch/ref subset. Values are identifiers, never shell commands or paths.
function assertBranchName(value, field) {
  if (typeof value !== "string" || !value || value === "HEAD" || value === "@"
    || value.startsWith("-") || /[\s\p{Cc}\p{Cf}~^:?*\[\\]/u.test(value)
    || value.includes("..") || value.includes("@{")
    || value.split("/").some(part => !part || part.startsWith(".")
      || part.endsWith(".") || part.endsWith(".lock"))) {
    throw new TypeError(`${field} must be a valid, explicit branch name`);
  }
}

function assertTargets(targets) {
  if (!Array.isArray(targets)) throw new TypeError("targets must be an array of strings");
  for (const target of targets) {
    assertBranchName(target, "targets entry");
    if (target.startsWith("refs/heads/")) {
      assertBranchName(target.slice("refs/heads/".length), "targets local branch");
    } else if (target.startsWith("refs/remotes/")) {
      const remainder = target.slice("refs/remotes/".length);
      if (!remainder.includes("/")) throw new TypeError("targets remote ref needs a branch");
      assertBranchName(remainder.slice(remainder.indexOf("/") + 1), "targets remote branch");
    } else if (target.startsWith("refs/")) {
      throw new TypeError("targets only supports refs/heads/ and refs/remotes/ references");
    }
  }
}

function localTarget(branch, currentBranch) {
  const branchKey = `refs/heads/${branch}`;
  const workingTree = branch === currentBranch;
  return { kind: "local", branch, ref: workingTree ? "HEAD" : branchKey, branchKey, workingTree };
}

function currentTarget(currentBranch, currentCommit) {
  if (currentBranch !== null) return localTarget(currentBranch, currentBranch);
  if (typeof currentCommit !== "string" || !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(currentCommit)) {
    throw new TypeError("currentCommit must be a full commit ID when no branch is checked out");
  }
  const commit = currentCommit.toLowerCase();
  return { kind: "detached", branch: null, ref: commit, branchKey: `commit:${commit}`, workingTree: true };
}

function literalTarget(target, currentBranch, remotes) {
  if (target.startsWith("refs/heads/")) {
    return localTarget(target.slice("refs/heads/".length), currentBranch);
  }
  const explicitlyRemote = target.startsWith("refs/remotes/");
  const name = explicitlyRemote ? target.slice("refs/remotes/".length) : target;
  const slash = name.indexOf("/");
  if (explicitlyRemote || (slash > 0 && remotes.has(name.slice(0, slash)))) {
    const branchKey = `refs/remotes/${name}`;
    return { kind: "remote", branch: name, ref: branchKey, branchKey, workingTree: false };
  }
  return localTarget(target, currentBranch);
}

/**
 * Resolve a freshly read product policy against a caller-supplied Git observation.
 * Pure: no Git execution, filesystem access, defaults, cached state or deletion.
 * Ref existence and observing every active worktree remain product responsibilities.
 */
export function resolveBranchTargets(input) {
  assertObject(input, "input");
  const { targetsVersion, targets, currentBranch, currentCommit, remotes } = input;
  if (targetsVersion !== BRANCH_TARGETS_VERSION) {
    throw new TypeError("targetsVersion must be 2; explicitly migrate legacy targets before resolving them");
  }
  assertTargets(targets);
  if (targets.includes(JUST_CURRENT_BRANCH_TARGET) && targets.length !== 1) {
    throw new TypeError("__JUST_CURRENT_BRANCH__ must be the only target");
  }
  if (currentBranch !== null) assertBranchName(currentBranch, "currentBranch");
  if (!Array.isArray(remotes)) throw new TypeError("remotes must be an array of remote names");
  for (const remote of remotes) {
    assertBranchName(remote, "remotes entry");
    if (remote.includes("/")) throw new TypeError("remotes entries must be single-component names");
  }
  const remoteNames = new Set(remotes);
  const byKey = new Map();
  for (const target of targets) {
    const resolved = target === CURRENT_BRANCH_TARGET || target === JUST_CURRENT_BRANCH_TARGET
      ? currentTarget(currentBranch, currentCommit)
      : literalTarget(target, currentBranch, remoteNames);
    if (target === JUST_CURRENT_BRANCH_TARGET) resolved.storageMode = "just-current";
    const existing = byKey.get(resolved.branchKey);
    if (existing) {
      if (!existing.requestedTargets.includes(target)) existing.requestedTargets.push(target);
    } else {
      byKey.set(resolved.branchKey, { requestedTargets: [target], ...resolved });
    }
  }
  return [...byKey.values()];
}

/**
 * Explicit conversion of the old selector convention, NOT a filesystem migration.
 * The product must review/persist the result and retain all unrelated config fields.
 */
export function migrateLegacyBranchTargets(input, options = {}) {
  assertObject(input, "input");
  if (input.targetsVersion !== 1) throw new TypeError("legacy targetsVersion must be 1");
  if (options?.confirmCurrentSelector !== true) {
    throw new TypeError("confirmCurrentSelector: true is required to reinterpret legacy current");
  }
  assertTargets(input.targets);
  return {
    targetsVersion: BRANCH_TARGETS_VERSION,
    targets: [...new Set(input.targets.map(target => {
      if (target === "current") return CURRENT_BRANCH_TARGET;
      if (target === CURRENT_BRANCH_TARGET) return `refs/heads/${target}`;
      return target;
    }))],
  };
}
