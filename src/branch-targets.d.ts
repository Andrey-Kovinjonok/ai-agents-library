export const CURRENT_BRANCH_TARGET: "__CURERNT__";
export const BRANCH_TARGETS_VERSION: 2;

/** Product-owned fields, independent from its config.json schemaVersion. */
export interface BranchTargetsPolicy {
  targetsVersion: typeof BRANCH_TARGETS_VERSION;
  targets: readonly string[];
}

export interface BranchTargetsInput extends BranchTargetsPolicy {
  /** Real local branch name, or null for a detached checkout. */
  currentBranch: string | null;
  /** Full 40- or 64-digit hexadecimal commit ID, required for a detached selector. */
  currentCommit?: string;
  /** Explicit single-component remote names, e.g. ["origin", "upstream"]. */
  remotes: readonly string[];
}

export interface ResolvedBranchTarget {
  requestedTargets: string[];
  kind: "local" | "remote" | "detached";
  /** Local name, remote/name, or null for a detached checkout. */
  branch: string | null;
  /** HEAD for the checked-out branch; otherwise a full ref or commit ID. */
  ref: string;
  /** Stable identity, NOT a safe directory name. */
  branchKey: string;
  workingTree: boolean;
}

/** Pure selection only; the product verifies refs and runs/indexes the actual checkout. */
export function resolveBranchTargets(input: BranchTargetsInput): ResolvedBranchTarget[];

/** Does not write any config. Spread the result into the original project mapping. */
export function migrateLegacyBranchTargets(
  input: { targetsVersion: 1; targets: readonly string[] },
  options: { confirmCurrentSelector: true },
): BranchTargetsPolicy;
