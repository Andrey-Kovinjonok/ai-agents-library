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
  continuation: { enabled: boolean };
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

