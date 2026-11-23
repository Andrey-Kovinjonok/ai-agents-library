export function createOpenCodeV1GitActionGuard(
  context: { directory?: string },
  options?: { stateDirectory?: string },
): Record<string, (...arguments_: any[]) => Promise<void>>;
export default function gitActionGuardForOpenCodeV1(
  context: { directory?: string },
): Promise<Record<string, (...arguments_: any[]) => Promise<void>>>;
