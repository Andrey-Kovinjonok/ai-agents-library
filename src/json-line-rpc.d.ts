import type { Readable, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
export interface JsonLinePeerOptions {
  handler?: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
  maxMessageBytes?: number;
}
export class JsonLinePeer {
  constructor(input: Readable, output: Writable, options?: JsonLinePeerOptions);
  readonly done: Promise<void>;
  readonly closed: boolean;
  request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  close(error?: Error): void;
}
export function spawnJsonLinePeer(command: string, args: string[], options: JsonLinePeerOptions & {
  cwd?: string;
  env: Record<string, string | undefined>;
}): { peer: JsonLinePeer; process: ChildProcessWithoutNullStreams; close(): Promise<void> };
