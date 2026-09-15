export interface PiCompatibleApi {
  on(event: string, handler: (event: any, context: any) => unknown): unknown;
}

export function registerPiCompatibleGitActionGuard(
  api: PiCompatibleApi,
  options?: { stateDirectory?: string; harness?: string },
): void;
