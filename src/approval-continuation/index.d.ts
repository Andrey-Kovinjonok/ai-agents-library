import type { Readable, Writable } from "node:stream";

import type {
  AgentProductPathsOptions,
  ProjectIdentityOptions,
} from "../project-locations.js";

export interface ApprovalContinuationOptions
  extends ProjectIdentityOptions, AgentProductPathsOptions {}

export interface ApprovalContinuationRuntimeSettings {
  schemaVersion: 1;
  configFile: string;
  trustedWorkRoots: string[];
  approval: { enabledClasses: string[] };
  continuation: {
    enabled: boolean;
    maxAutomaticContinuationsPerSession: number;
  };
  observations: { enabled: boolean };
  safety: { enabled: boolean };
}

export interface ApprovalContinuationInstallOptions {
  userHome?: string;
  agentsRoot?: string;
  codexHome?: string;
  packageRoot?: string;
  agents?: string[];
  trustedRoots?: string[];
  nodeExecutable?: string;
}

export class ApprovalContinuationInstallError extends Error {}

export const APPROVAL_CONTINUATION_PRODUCT: "approval-continuation";

export type GitActionKind = "commit" | "push" | "rollback" | "noverify";
export type GitActionPermissionEvent = {
  sessionId?: string;
  turnId?: string;
  toolUseId?: string;
};
export type GitActionPermissionOptions = {
  kind: GitActionKind;
  cwd: string;
  event?: GitActionPermissionEvent;
  stateDirectory?: string;
  ttlMilliseconds?: number;
  now?: number;
};
export function createGitActionPermission(options: GitActionPermissionOptions): string;
export function beginGitActionPermission(options: GitActionPermissionOptions): boolean;
export function finishGitActionPermission(
  options: GitActionPermissionOptions & {
    exitCode?: number | null;
    changesBranchRef?: boolean;
  },
): "completed" | "retry" | null;
export type GitCommandRequirement = { kind: GitActionKind; action: "commit" | "push" | "rollback" };
export function authorizationKindsFromPrompt(prompt: unknown): GitActionKind[];
export function gitRequirementsFromCommand(command: unknown): GitCommandRequirement[];
export function recordGitAuthorizations(
  options: Omit<GitActionPermissionOptions, "kind"> & { prompt: unknown },
): string[];
export function beginGitCommandAuthorization(
  options: Omit<GitActionPermissionOptions, "kind"> & { command: unknown },
): { allowed: boolean; requirement: GitCommandRequirement | null; requirements: GitCommandRequirement[] };
export function finishGitCommandAuthorization(
  options: Omit<GitActionPermissionOptions, "kind"> & { command: unknown; exitCode?: number | null },
): Array<GitCommandRequirement & { outcome: "completed" | "retry" | null }>;
export function gitAuthorizationMessage(requirement: GitCommandRequirement): string;
export function normalizeCommandHookEvent(
  payload: Record<string, unknown>,
  harness: "codex" | "claude" | "qwen",
): Record<string, unknown>;
export function evaluateCommandHookEvent(
  payload: Record<string, unknown>,
  options: { harness: "codex" | "claude" | "qwen"; stateDirectory?: string },
): { kind: "none" } | { kind: "block" | "retry"; message: string };
export function renderCommandHookDecision(
  decision: { kind: "none" } | { kind: "block" | "retry"; message: string },
  harness: "codex" | "claude" | "qwen",
  eventName?: string,
): { output: string | null; stream?: "stdout" | "stderr"; exitCode: number };
export class GitActionGuardInstallError extends Error {}
export function installGitActionGuard(options?: {
  agents?: Array<"all" | "codex" | "claude" | "qwen" | "pi" | "oh-my-pi" | "opencode">;
  userHome?: string;
  codexHome?: string;
  packageRoot?: string;
  nodeExecutable?: string;
  openCodeMajor?: 1 | 2;
}): {
  agents: string[];
  packageRoot: string;
  runtime: string;
  configFiles: Record<string, string>;
  links: Record<string, { link: string; target: string }>;
  openCodeMajor: 1 | 2;
};
export const SUPPORTED_APPROVAL_CLASSES: readonly string[];
export const SUPPORTED_APPROVAL_CONTINUATION_AGENTS: readonly string[];

export function approvalContinuationPaths(options?: ApprovalContinuationOptions): {
  homeDir: string;
  agentsRoot: string;
  canonicalDirectory: string;
  configFile: string;
  projectsDirectory: string;
};

export function defaultApprovalContinuationConfig(
  options?: ApprovalContinuationOptions & { trustedRoots?: string[] },
): Record<string, unknown>;

export function readApprovalContinuationSettings(
  options?: ApprovalContinuationOptions,
): ApprovalContinuationRuntimeSettings;

export function isTrustedWorkingDirectory(
  value: string,
  settings: ApprovalContinuationRuntimeSettings,
  options?: ApprovalContinuationOptions,
): boolean;

export function evaluateApprovalContinuationEvent(
  payload: Record<string, unknown>,
  options?: ApprovalContinuationOptions,
): Promise<Record<string, unknown> | null>;

export function runApprovalContinuationHook(
  options?: ApprovalContinuationOptions & { input?: Readable; output?: Writable },
): Promise<number>;

export function installApprovalContinuation(
  options?: ApprovalContinuationInstallOptions,
): Promise<Record<string, unknown>>;

export function approvalClassFor(command: string): string | null;
export function destructiveReason(command: string): string | null;
export function sanitizeVerification(command: string): string | null;
export function findExitCode(value: unknown): number | null;
export function continuationSessionKey(payload: Record<string, unknown>): string | null;
export function continuationStateDirectory(options?: ApprovalContinuationOptions): string;
export function claimContinuation(
  payload: Record<string, unknown>,
  maximum: number,
  options?: ApprovalContinuationOptions,
): boolean;
export function continuationDecision(
  payload: Record<string, unknown>,
  settingsOrEnabled: { enabled: boolean; maxAutomaticContinuationsPerSession?: number } | boolean,
  options?: ApprovalContinuationOptions,
): Record<string, unknown> | null;
