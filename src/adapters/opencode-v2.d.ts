export function defineOpenCodeV2GitActionGuard(options?: { stateDirectory?: string }): {
  id: string;
  setup(context: any): Promise<void>;
};
declare const plugin: ReturnType<typeof defineOpenCodeV2GitActionGuard>;
export default plugin;
