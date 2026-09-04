import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PRODUCT_CONFIG_SCHEMA_VERSION = 1;

function canonicalPath(value) {
  const absolute = path.resolve(value);
  return fs.realpathSync.native(absolute);
}

function canonicalPathWhenPresent(value) {
  const absolute = path.resolve(value);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function gitCommonDirectory(startPath, gitExecutable) {
  const run = (args) => execFileSync(gitExecutable, args, {
    cwd: startPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
    windowsHide: true,
  }).trim();

  try {
    return run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  } catch {
    try {
      const value = run(["rev-parse", "--git-common-dir"]);
      return path.isAbsolute(value) ? value : path.resolve(startPath, value);
    } catch {
      return null;
    }
  }
}

function safeAliasSegment(value) {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}.-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[.-]+|[.-]+$/gu, "");
}

function pathComponentsForAlias(projectPath, homeDir) {
  const absolute = canonicalPathWhenPresent(projectPath);
  const homeParent = path.dirname(canonicalPathWhenPresent(homeDir));
  const relativeToHomeParent = path.relative(homeParent, absolute);
  const isBelowHomeParent = relativeToHomeParent !== ""
    && relativeToHomeParent !== ".."
    && !relativeToHomeParent.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativeToHomeParent);
  const source = isBelowHomeParent
    ? relativeToHomeParent
    : absolute.slice(path.parse(absolute).root.length);
  return source.split(path.sep).filter(Boolean);
}

/**
 * Build a readable directory name by reversing the meaningful components of
 * the absolute path. The user's home-directory name deliberately remains in
 * the result so similarly named checkouts owned by different users do not
 * collapse into one directory.
 */
export function projectAlias(projectPath, options = {}) {
  const homeDir = options.homeDir ?? os.homedir();
  const components = pathComponentsForAlias(projectPath, homeDir)
    .map(safeAliasSegment)
    .filter(Boolean)
    .reverse();
  if (components.length === 0) {
    throw new Error(`Не удалось построить имя проекта из пути: ${projectPath}`);
  }
  return components.join("_");
}

/**
 * Resolve one stable project identity for the main checkout, linked Git
 * worktrees and symbolic links. A non-Git directory remains a valid project
 * and is identified by its real filesystem path.
 */
export function resolveProjectIdentity(startPath, options = {}) {
  const input = canonicalPath(startPath);
  const commonDirectory = gitCommonDirectory(input, options.gitExecutable ?? "git");
  const canonicalProject = commonDirectory
    ? canonicalPath(path.dirname(path.resolve(commonDirectory)))
    : input;
  return {
    canonicalPath: canonicalProject,
    alias: projectAlias(canonicalProject, options),
  };
}

function validateProductName(product) {
  if (
    typeof product !== "string"
    || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(product)
    || product === "."
    || product === ".."
  ) {
    throw new Error(`Недопустимое имя продукта: ${String(product)}`);
  }
}

function assertInside(parent, child, label) {
  const relative = path.relative(parent, child);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`${label} должен находиться внутри ${parent}`);
  }
}

function isInsideOrEqual(parent, child) {
  const relative = path.relative(parent, child);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolvedPathWithMissingTail(value) {
  let current = path.resolve(value);
  const tail = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(value);
    tail.unshift(path.basename(current));
    current = parent;
  }
  return path.join(canonicalPath(current), ...tail);
}

function ensureDirectoryTreeWithin(rootDirectory, targetDirectory, label) {
  const root = path.resolve(rootDirectory);
  const target = path.resolve(targetDirectory);
  if (!isInsideOrEqual(root, target)) {
    throw new Error(`${label} должен находиться внутри ${root}`);
  }

  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const realRoot = canonicalPath(root);
  const relative = path.relative(root, target);
  let current = root;

  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const status = fs.lstatSync(current);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error(`${label} содержит недопустимую ссылку или файл: ${current}`);
    }
    if (!isInsideOrEqual(realRoot, canonicalPath(current))) {
      throw new Error(`${label} вышел за безопасную внешнюю область`);
    }
  }

  return canonicalPath(target);
}

/** Build standard locations for one agent product without touching disk. */
export function agentProductPaths(product, identity, options = {}) {
  validateProductName(product);
  if (
    !identity
    || typeof identity.canonicalPath !== "string"
    || typeof identity.alias !== "string"
    || identity.alias.length === 0
  ) {
    throw new Error("Некорректная идентичность проекта");
  }
  const agentsRoot = path.resolve(options.agentsRoot ?? path.join(os.homedir(), ".agents"));
  const skillsDirectory = path.join(agentsRoot, "skills");
  const productDirectory = path.join(skillsDirectory, product);
  const projectsDirectory = path.join(productDirectory, "projects");
  const projectDirectory = path.join(projectsDirectory, identity.alias);
  assertInside(skillsDirectory, productDirectory, "Каталог продукта");
  assertInside(projectsDirectory, projectDirectory, "Каталог проекта");
  return {
    agentsRoot,
    skillsDirectory,
    productDirectory,
    productConfigFile: path.join(productDirectory, "config.json"),
    projectsDirectory,
    projectDirectory,
  };
}

function readProductConfig(file) {
  let bytes;
  try {
    const status = fs.lstatSync(file);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw new Error(`Конфиг продукта должен быть обычным файлом: ${file}`);
    }
    bytes = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Конфиг продукта не найден: ${file}`);
    }
    throw error;
  }
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new Error(`Конфиг продукта содержит некорректный JSON: ${file}`);
  }
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || value.schemaVersion !== PRODUCT_CONFIG_SCHEMA_VERSION
    || value.projects === null
    || typeof value.projects !== "object"
    || Array.isArray(value.projects)
  ) {
    throw new Error(`Некорректный формат конфига продукта: ${file}`);
  }
  return value;
}

function configuredProjectDirectory(standardPaths, directory) {
  if (typeof directory !== "string" || path.isAbsolute(directory)) {
    throw new Error(`Некорректный каталог проекта в ${standardPaths.productConfigFile}`);
  }
  const projectDirectory = path.resolve(standardPaths.productDirectory, directory);
  assertInside(standardPaths.projectsDirectory, projectDirectory, "Каталог проекта");
  return projectDirectory;
}

function verifiedConfiguredProjectDirectory(standardPaths, directory) {
  const projectDirectory = configuredProjectDirectory(standardPaths, directory);
  const realProductDirectory = canonicalPath(standardPaths.productDirectory);
  const resolvedProjectsDirectory = resolvedPathWithMissingTail(
    standardPaths.projectsDirectory,
  );
  const resolvedProjectDirectory = resolvedPathWithMissingTail(projectDirectory);
  assertInside(
    realProductDirectory,
    resolvedProjectsDirectory,
    "Каталог projects",
  );
  assertInside(
    resolvedProjectsDirectory,
    resolvedProjectDirectory,
    "Каталог проекта",
  );
  return projectDirectory;
}

/**
 * Read a product's own config on every invocation and resolve the directory
 * mapped to the canonical project path. No cache is intentionally used.
 */
export function resolveProductProject(product, startPath, options = {}) {
  const identity = resolveProjectIdentity(startPath, options);
  const standardPaths = agentProductPaths(product, identity, options);
  const config = readProductConfig(standardPaths.productConfigFile);
  const mapping = config.projects[identity.canonicalPath];
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    throw new Error(
      `В конфиге продукта ${product} нет проекта: ${identity.canonicalPath}`,
    );
  }
  const projectDirectory = verifiedConfiguredProjectDirectory(
    standardPaths,
    mapping.directory,
  );
  return {
    ...standardPaths,
    identity,
    projectDirectory,
    mapping,
    config,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withFileLock(lockFile, action) {
  const deadline = Date.now() + 5_000;
  let handle;
  while (handle === undefined) {
    try {
      handle = fs.openSync(lockFile, "wx", 0o600);
      try {
        fs.writeFileSync(handle, `${process.pid}\n`);
        fs.fsyncSync(handle);
      } catch (writeError) {
        fs.closeSync(handle);
        handle = undefined;
        fs.rmSync(lockFile, { force: true });
        throw writeError;
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let ownerDescription = "создаётся";
      let ownerIsAlive = true;
      try {
        const status = fs.lstatSync(lockFile);
        if (status.isSymbolicLink() || !status.isFile()) {
          throw new Error(`Файл блокировки имеет недопустимый тип: ${lockFile}`);
        }
        const ownerText = fs.readFileSync(lockFile, "utf8").trim();
        if (ownerText !== "") {
          const owner = Number(ownerText);
          if (!Number.isSafeInteger(owner) || owner <= 0) {
            throw new Error(`Файл блокировки повреждён: ${lockFile}`);
          }
          ownerDescription = String(owner);
          try {
            process.kill(owner, 0);
          } catch (ownerError) {
            if (ownerError?.code === "ESRCH") ownerIsAlive = false;
            else if (ownerError?.code !== "EPERM") throw ownerError;
          }
        }
      } catch (lockError) {
        if (lockError?.code === "ENOENT") continue;
        throw lockError;
      }
      if (!ownerIsAlive) {
        throw new Error(
          `Осталась блокировка от завершившегося процесса ${ownerDescription}: ${lockFile}. `
          + "Библиотека не удаляет её автоматически.",
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(`Конфиг продукта занят процессом ${ownerDescription}`);
      }
      await delay(25);
    }
  }
  try {
    return await action();
  } finally {
    fs.closeSync(handle);
    fs.rmSync(lockFile, { force: true });
  }
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * Create or retain one product-owned path mapping. The operation only writes
 * below the supplied ~/.agents root, preserves unknown product fields and
 * refuses readable-name collisions instead of merging two projects.
 */
export async function ensureProductProject(product, startPath, options = {}) {
  const identity = resolveProjectIdentity(startPath, options);
  const standardPaths = agentProductPaths(product, identity, options);
  const resolvedAgentsRoot = resolvedPathWithMissingTail(standardPaths.agentsRoot);
  if (isInsideOrEqual(identity.canonicalPath, resolvedAgentsRoot)) {
    throw new Error("Корень агентских данных должен находиться вне рабочего проекта");
  }

  fs.mkdirSync(standardPaths.agentsRoot, { recursive: true, mode: 0o700 });
  const realAgentsRoot = canonicalPath(standardPaths.agentsRoot);
  if (isInsideOrEqual(identity.canonicalPath, realAgentsRoot)) {
    throw new Error("Корень агентских данных должен находиться вне рабочего проекта");
  }
  ensureDirectoryTreeWithin(
    standardPaths.agentsRoot,
    standardPaths.productDirectory,
    "Каталог продукта",
  );
  return withFileLock(`${standardPaths.productConfigFile}.lock`, async () => {
    const config = fs.existsSync(standardPaths.productConfigFile)
      ? readProductConfig(standardPaths.productConfigFile)
      : { schemaVersion: PRODUCT_CONFIG_SCHEMA_VERSION, projects: {} };
    const existing = config.projects[identity.canonicalPath];
    if (existing !== undefined && (existing === null || typeof existing !== "object" || Array.isArray(existing))) {
      throw new Error(`Некорректная запись проекта: ${identity.canonicalPath}`);
    }
    const defaultDirectory = `projects/${identity.alias}`;
    const directory = existing?.directory ?? defaultDirectory;
    const projectDirectory = configuredProjectDirectory(standardPaths, directory);

    for (const [otherPath, otherMapping] of Object.entries(config.projects)) {
      if (otherPath === identity.canonicalPath) continue;
      if (
        !otherMapping
        || typeof otherMapping !== "object"
        || Array.isArray(otherMapping)
      ) {
        throw new Error(`Некорректная запись проекта: ${otherPath}`);
      }
      const otherProjectDirectory = configuredProjectDirectory(
        standardPaths,
        otherMapping.directory,
      );
      if (otherProjectDirectory === projectDirectory) {
        throw new Error(
          `Совпадение читаемых имён проектов: ${identity.canonicalPath} и ${otherPath}`,
        );
      }
    }

    const realProjectsDirectory = ensureDirectoryTreeWithin(
      standardPaths.productDirectory,
      standardPaths.projectsDirectory,
      "Каталог projects",
    );
    const realProjectDirectory = ensureDirectoryTreeWithin(
      standardPaths.projectsDirectory,
      projectDirectory,
      "Каталог проекта продукта",
    );
    if (
      !isInsideOrEqual(realAgentsRoot, realProjectDirectory)
      || !isInsideOrEqual(realProjectsDirectory, realProjectDirectory)
      || isInsideOrEqual(identity.canonicalPath, realProjectDirectory)
    ) {
      throw new Error("Каталог проекта продукта вышел за безопасную внешнюю область");
    }

    const mapping = { ...(existing ?? {}), directory };
    const updated = {
      ...config,
      projects: {
        ...config.projects,
        [identity.canonicalPath]: mapping,
      },
    };
    writeJsonAtomic(standardPaths.productConfigFile, updated);
    return {
      ...standardPaths,
      identity,
      projectDirectory,
      mapping,
      config: updated,
    };
  });
}
