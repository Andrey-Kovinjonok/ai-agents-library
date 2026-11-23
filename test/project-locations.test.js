import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  agentProductPaths,
  ensureProductProject,
  findProductProject,
  projectAlias,
  resolveProductProject,
  resolveProjectIdentity,
} from "ai-agents-library/project-locations";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRepository(root) {
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-m", "initial");
}

function ensureInSeparateProcess(project, agentsRoot, homeDir) {
  const helper = fileURLToPath(new URL("./fixtures/ensure-product-project.mjs", import.meta.url));
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [helper, project, agentsRoot, homeDir],
      { encoding: "utf8", timeout: 10_000 },
      (error, stdout, stderr) => {
        if (error) {
          error.message += `\nstdout:\n${stdout}\nstderr:\n${stderr}`;
          reject(error);
          return;
        }
        resolve(JSON.parse(stdout));
      },
    );
  });
}

test("строит читаемое обратное имя из полного пути проекта", () => {
  assert.equal(
    projectAlias("/Users/andreykovinenok/WORK/OF/frontend", {
      homeDir: "/Users/andreykovinenok",
    }),
    "frontend_of_work_andreykovinenok",
  );
});

test("основная папка, дополнительная рабочая папка Git и символическая ссылка имеют одну идентичность", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-library-identity-"));
  const home = path.join(temp, "home", "tester");
  const repo = path.join(home, "WORK", "OF", "frontend");
  const worktree = path.join(temp, "feature-worktree");
  const link = path.join(temp, "frontend-link");
  createRepository(repo);
  git(repo, "worktree", "add", "-b", "feature/example", worktree);
  fs.symlinkSync(repo, link, "dir");

  const primary = resolveProjectIdentity(repo, { homeDir: home });
  const linkedWorktree = resolveProjectIdentity(worktree, { homeDir: home });
  const symlink = resolveProjectIdentity(link, { homeDir: home });

  assert.deepEqual(linkedWorktree, primary);
  assert.deepEqual(symlink, primary);
  assert.equal(primary.alias, "frontend_of_work_tester");
  fs.rmSync(temp, { recursive: true, force: true });
});

test("разные продукты получают раздельные корни и одинаковый каталог проекта", () => {
  const identity = {
    canonicalPath: "/Users/andreykovinenok/WORK/OF/frontend",
    alias: "frontend_of_work_andreykovinenok",
  };
  const agentsRoot = "/Users/andreykovinenok/.agents";

  const gitnexus = agentProductPaths("git-nexus", identity, { agentsRoot });
  const codegraph = agentProductPaths("codegraph", identity, { agentsRoot });

  assert.equal(gitnexus.productConfigFile, `${agentsRoot}/skills/git-nexus/config.json`);
  assert.equal(
    gitnexus.projectDirectory,
    `${agentsRoot}/skills/git-nexus/projects/frontend_of_work_andreykovinenok`,
  );
  assert.equal(codegraph.productConfigFile, `${agentsRoot}/skills/codegraph/config.json`);
  assert.equal(
    codegraph.projectDirectory,
    `${agentsRoot}/skills/codegraph/projects/frontend_of_work_andreykovinenok`,
  );
});

test("конфиг продукта связывает реальный путь с относительным каталогом и перечитывается при каждом вызове", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-library-live-config-"));
  const home = path.join(temp, "home", "tester");
  const repo = path.join(home, "WORK", "OF", "frontend");
  const agentsRoot = path.join(home, ".agents");
  createRepository(repo);
  const identity = resolveProjectIdentity(repo, { homeDir: home });
  const paths = agentProductPaths("codegraph", identity, { agentsRoot });
  fs.mkdirSync(path.dirname(paths.productConfigFile), { recursive: true });
  fs.writeFileSync(paths.productConfigFile, JSON.stringify({
    schemaVersion: 1,
    projects: {
      [identity.canonicalPath]: {
        directory: `projects/${identity.alias}`,
      },
    },
  }));

  const first = resolveProductProject("codegraph", repo, { agentsRoot, homeDir: home });
  assert.equal(first.projectDirectory, paths.projectDirectory);

  fs.writeFileSync(paths.productConfigFile, JSON.stringify({
    schemaVersion: 1,
    projects: {
      [identity.canonicalPath]: {
        directory: `projects/${identity.alias}_changed`,
      },
    },
  }));
  const second = resolveProductProject("codegraph", repo, { agentsRoot, homeDir: home });
  assert.equal(second.projectDirectory, `${paths.projectsDirectory}/${identity.alias}_changed`);
  assert.equal(second.config.schemaVersion, 1);
  assert.equal(
    second.config.projects[identity.canonicalPath].directory,
    `projects/${identity.alias}_changed`,
  );
  fs.rmSync(temp, { recursive: true, force: true });
});

test("необязательный поиск проекта различает отсутствие конфига, отсутствие пути и точное совпадение", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-library-find-project-"));
  const home = path.join(temp, "home", "tester");
  const configuredRepo = path.join(home, "WORK", "OF", "frontend");
  const unknownRepo = path.join(home, "WORK", "OF", "backend");
  const agentsRoot = path.join(home, ".agents");
  createRepository(configuredRepo);
  createRepository(unknownRepo);

  const withoutConfig = findProductProject("git-branch-guard", configuredRepo, {
    agentsRoot,
    homeDir: home,
  });
  assert.equal(withoutConfig.configured, false);
  assert.equal(withoutConfig.reason, "config-missing");

  const identity = resolveProjectIdentity(configuredRepo, { homeDir: home });
  const paths = agentProductPaths("git-branch-guard", identity, { agentsRoot });
  fs.mkdirSync(paths.productDirectory, { recursive: true });
  fs.writeFileSync(paths.productConfigFile, JSON.stringify({
    schemaVersion: 1,
    projects: {
      [identity.canonicalPath]: {
        directory: `projects/${identity.alias}`,
        forbiddenBranches: ["beta"],
      },
    },
  }));

  const unknown = findProductProject("git-branch-guard", unknownRepo, {
    agentsRoot,
    homeDir: home,
  });
  assert.equal(unknown.configured, false);
  assert.equal(unknown.reason, "project-missing");

  const configured = findProductProject("git-branch-guard", configuredRepo, {
    agentsRoot,
    homeDir: home,
  });
  assert.equal(configured.configured, true);
  assert.deepEqual(configured.mapping.forbiddenBranches, ["beta"]);
  assert.equal(configured.identity.canonicalPath, identity.canonicalPath);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("не разрешает имени продукта или конфигу выйти из корня продукта", () => {
  const identity = {
    canonicalPath: "/Users/andreykovinenok/WORK/OF/frontend",
    alias: "frontend_of_work_andreykovinenok",
  };
  assert.throws(() => agentProductPaths("../escape", identity), /имя продукта/i);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-library-escape-"));
  const home = path.join(temp, "home", "tester");
  const repo = path.join(home, "WORK", "OF", "frontend");
  const agentsRoot = path.join(home, ".agents");
  createRepository(repo);
  const actual = resolveProjectIdentity(repo, { homeDir: home });
  const paths = agentProductPaths("codegraph", actual, { agentsRoot });
  fs.mkdirSync(path.dirname(paths.productConfigFile), { recursive: true });
  fs.writeFileSync(paths.productConfigFile, JSON.stringify({
    schemaVersion: 1,
    projects: {
      [actual.canonicalPath]: { directory: "../../escape" },
    },
  }));

  assert.throws(
    () => resolveProductProject("codegraph", repo, { agentsRoot, homeDir: home }),
    /каталог проекта/i,
  );
  fs.rmSync(temp, { recursive: true, force: true });
});

test("разрешение внешнего каталога не изменяет файлы исходного проекта", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-library-project-clean-"));
  const home = path.join(temp, "home", "tester");
  const repo = path.join(home, "WORK", "OF", "frontend");
  const agentsRoot = path.join(home, ".agents");
  createRepository(repo);
  const identity = resolveProjectIdentity(repo, { homeDir: home });
  const paths = agentProductPaths("git-nexus", identity, { agentsRoot });
  fs.mkdirSync(path.dirname(paths.productConfigFile), { recursive: true });
  fs.writeFileSync(paths.productConfigFile, JSON.stringify({
    schemaVersion: 1,
    projects: {
      [identity.canonicalPath]: { directory: `projects/${identity.alias}` },
    },
  }));
  const before = git(repo, "status", "--porcelain=v1", "--untracked-files=all");

  resolveProductProject("git-nexus", repo, { agentsRoot, homeDir: home });

  const after = git(repo, "status", "--porcelain=v1", "--untracked-files=all");
  assert.equal(after, before);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("подготовка создаёт связь и каталог продукта, сохраняя его собственные поля", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-library-prepare-"));
  const home = path.join(temp, "home", "tester");
  const repo = path.join(home, "WORK", "OF", "frontend");
  const other = path.join(home, "WORK", "OF", "backend");
  const agentsRoot = path.join(home, ".agents");
  createRepository(repo);
  createRepository(other);
  const identity = resolveProjectIdentity(repo, { homeDir: home });
  const otherIdentity = resolveProjectIdentity(other, { homeDir: home });
  const paths = agentProductPaths("git-nexus", identity, { agentsRoot });
  fs.mkdirSync(paths.productDirectory, { recursive: true });
  fs.writeFileSync(paths.productConfigFile, JSON.stringify({
    schemaVersion: 1,
    productSettings: { targets: ["current", "origin/main"] },
    projects: {
      [otherIdentity.canonicalPath]: {
        directory: `projects/${otherIdentity.alias}`,
        enabled: false,
      },
    },
  }));

  const prepared = await ensureProductProject("git-nexus", repo, {
    agentsRoot,
    homeDir: home,
  });
  const config = JSON.parse(fs.readFileSync(paths.productConfigFile, "utf8"));

  assert.equal(prepared.projectDirectory, paths.projectDirectory);
  assert.deepEqual(prepared.config.productSettings, {
    targets: ["current", "origin/main"],
  });
  assert.equal(fs.statSync(prepared.projectDirectory).isDirectory(), true);
  assert.deepEqual(config.productSettings, { targets: ["current", "origin/main"] });
  assert.deepEqual(config.projects[otherIdentity.canonicalPath], {
    directory: `projects/${otherIdentity.alias}`,
    enabled: false,
  });
  assert.deepEqual(config.projects[identity.canonicalPath], {
    directory: `projects/${identity.alias}`,
  });
  fs.rmSync(temp, { recursive: true, force: true });
});

test("подготовка запрещает размещать служебный корень внутри рабочего проекта", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-library-project-write-"));
  const home = path.join(temp, "home", "tester");
  const repo = path.join(home, "WORK", "OF", "frontend");
  createRepository(repo);

  await assert.rejects(
    ensureProductProject("git-nexus", repo, {
      agentsRoot: path.join(repo, ".agents"),
      homeDir: home,
    }),
    /вне рабочего проекта/i,
  );
  assert.equal(fs.existsSync(path.join(repo, ".agents")), false);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("подготовка не пишет наружу через символическую ссылку projects", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-library-projects-link-"));
  const home = path.join(temp, "home", "tester");
  const repo = path.join(home, "WORK", "OF", "frontend");
  const agentsRoot = path.join(home, ".agents");
  const outside = path.join(temp, "outside");
  createRepository(repo);
  fs.mkdirSync(outside, { recursive: true });

  const identity = resolveProjectIdentity(repo, { homeDir: home });
  const paths = agentProductPaths("codegraph", identity, { agentsRoot });
  fs.mkdirSync(paths.productDirectory, { recursive: true });
  fs.writeFileSync(paths.productConfigFile, JSON.stringify({
    schemaVersion: 1,
    projects: {
      [identity.canonicalPath]: { directory: `projects/${identity.alias}` },
    },
  }));
  fs.symlinkSync(outside, paths.projectsDirectory, "dir");

  assert.throws(
    () => resolveProductProject("codegraph", repo, { agentsRoot, homeDir: home }),
    /безопасн|внутри|ссылк/i,
  );
  await assert.rejects(
    ensureProductProject("codegraph", repo, { agentsRoot, homeDir: home }),
    /безопасн|внутри|ссылк/i,
  );
  assert.equal(fs.existsSync(path.join(outside, identity.alias)), false);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("два разных проекта с одинаковым читаемым именем не объединяются", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-library-collision-"));
  const home = path.join(temp, "home", "tester");
  const first = path.join(home, "WORK", "a b", "frontend");
  const second = path.join(home, "WORK", "a-b", "frontend");
  const agentsRoot = path.join(home, ".agents");
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });

  await ensureProductProject("codegraph", first, { agentsRoot, homeDir: home });
  await assert.rejects(
    ensureProductProject("codegraph", second, { agentsRoot, homeDir: home }),
    /совпадение читаемых имён/i,
  );
  fs.rmSync(temp, { recursive: true, force: true });
});

test("разные текстовые пути к одной папке продукта считаются конфликтом", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-library-normalized-collision-"));
  const home = path.join(temp, "home", "tester");
  const first = path.join(home, "WORK", "first");
  const second = path.join(home, "WORK", "second");
  const agentsRoot = path.join(home, ".agents");
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });

  const firstIdentity = resolveProjectIdentity(first, { homeDir: home });
  const secondIdentity = resolveProjectIdentity(second, { homeDir: home });
  const paths = agentProductPaths("codegraph", secondIdentity, { agentsRoot });
  fs.mkdirSync(paths.productDirectory, { recursive: true });
  fs.writeFileSync(paths.productConfigFile, JSON.stringify({
    schemaVersion: 1,
    projects: {
      [firstIdentity.canonicalPath]: {
        directory: `projects/nested/../${secondIdentity.alias}`,
      },
    },
  }));

  await assert.rejects(
    ensureProductProject("codegraph", second, { agentsRoot, homeDir: home }),
    /совпадение|одну папку/i,
  );
  fs.rmSync(temp, { recursive: true, force: true });
});

test("одновременная подготовка несколькими агентами не теряет записи проектов", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-library-concurrent-"));
  const home = path.join(temp, "home", "tester");
  const agentsRoot = path.join(home, ".agents");
  const projects = Array.from({ length: 16 }, (_, index) => {
    const project = path.join(home, "WORK", `team-${index}`, `project-${index}`);
    fs.mkdirSync(project, { recursive: true });
    return project;
  });

  const prepared = await Promise.all(projects.map((project) => ensureProductProject(
    "codegraph",
    project,
    { agentsRoot, homeDir: home },
  )));
  const configFile = prepared[0].productConfigFile;
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));

  assert.equal(Object.keys(config.projects).length, projects.length);
  for (const result of prepared) {
    assert.equal(
      config.projects[result.identity.canonicalPath].directory,
      `projects/${result.identity.alias}`,
    );
  }
  fs.rmSync(temp, { recursive: true, force: true });
});

test("разные процессы одновременно дополняют один конфиг без потери записей", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-library-processes-"));
  const home = path.join(temp, "home", "tester");
  const agentsRoot = path.join(home, ".agents");
  const projects = Array.from({ length: 8 }, (_, index) => {
    const project = path.join(home, "WORK", `group-${index}`, `project-${index}`);
    fs.mkdirSync(project, { recursive: true });
    return project;
  });

  const prepared = await Promise.all(
    projects.map((project) => ensureInSeparateProcess(project, agentsRoot, home)),
  );
  const config = JSON.parse(fs.readFileSync(prepared[0].productConfigFile, "utf8"));

  assert.equal(Object.keys(config.projects).length, projects.length);
  for (const result of prepared) {
    assert.equal(
      config.projects[result.identity.canonicalPath].directory,
      `projects/${result.identity.alias}`,
    );
  }
  fs.rmSync(temp, { recursive: true, force: true });
});
