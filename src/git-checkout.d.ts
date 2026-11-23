export interface GitCheckout {
  checkoutPath: string;
  branch: string | null;
  commit: string;
  remotes: string[];
}
export interface GitSourceSnapshot {
  directory: string;
  sourceCommit: string;
  sourceFingerprint: string;
  snapshotCommit: string;
  files: number;
  excluded: string[];
  changedFiles: number;
}
export function readGitCheckout(checkoutPath: string): GitCheckout;
export function branchDirectoryName(branchKey: string): string;
export function createGitSourceSnapshot(options: {
  checkoutPath: string;
  destination: string;
  reference: string;
  workingTree: boolean;
  branch: string;
  previousSnapshot?: string;
  reuse?: boolean;
}): GitSourceSnapshot;
