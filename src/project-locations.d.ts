export interface ProjectIdentityOptions {
  homeDir?: string;
  gitExecutable?: string;
}

export interface AgentProductPathsOptions {
  agentsRoot?: string;
}

export interface ProjectIdentity {
  canonicalPath: string;
  alias: string;
}

export interface AgentProductPaths {
  agentsRoot: string;
  skillsDirectory: string;
  productDirectory: string;
  productConfigFile: string;
  projectsDirectory: string;
  projectDirectory: string;
}

export interface ProductProjectMapping {
  directory: string;
  [field: string]: unknown;
}

export interface ProductConfig {
  schemaVersion: typeof PRODUCT_CONFIG_SCHEMA_VERSION;
  projects: Record<string, ProductProjectMapping>;
  [field: string]: unknown;
}

export interface ResolvedProductProject extends AgentProductPaths {
  identity: ProjectIdentity;
  mapping: ProductProjectMapping;
  config: ProductConfig;
}

export const PRODUCT_CONFIG_SCHEMA_VERSION: 1;

export function projectAlias(
  projectPath: string,
  options?: Pick<ProjectIdentityOptions, "homeDir">,
): string;

export function resolveProjectIdentity(
  startPath: string,
  options?: ProjectIdentityOptions,
): ProjectIdentity;

export function agentProductPaths(
  product: string,
  identity: ProjectIdentity,
  options?: AgentProductPathsOptions,
): AgentProductPaths;

export function resolveProductProject(
  product: string,
  startPath: string,
  options?: ProjectIdentityOptions & AgentProductPathsOptions,
): ResolvedProductProject;

export function ensureProductProject(
  product: string,
  startPath: string,
  options?: ProjectIdentityOptions & AgentProductPathsOptions,
): Promise<ResolvedProductProject>;

export function updateProductProject(
  product: string,
  startPath: string,
  patch: Record<string, unknown> & { directory?: never },
  options?: ProjectIdentityOptions & AgentProductPathsOptions,
): Promise<ResolvedProductProject>;
