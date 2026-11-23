import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function git(directory, args, binary = false) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return execFileSync("git", ["-C", directory, "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false", ...args], {
    env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1" },
    encoding: binary ? undefined : "utf8", maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000, stdio: ["ignore", "pipe", "pipe"],
  });
}

export function readGitCheckout(checkoutPath) {
  const root = fs.realpathSync(git(checkoutPath, ["rev-parse", "--show-toplevel"]).trim());
  let branch;
  try { branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim(); }
  catch (error) { if (error.status !== 1) throw error; branch = null; }
  return { checkoutPath: root, branch,
    commit: git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim(),
    remotes: git(root, ["remote"]).trim().split("\n").filter(Boolean) };
}

export function branchDirectoryName(branchKey) {
  if (typeof branchKey !== "string" || !/^(refs\/(heads|remotes)\/[^\s]+|commit:[a-f0-9]{40,64})$/.test(branchKey)
    || branchKey.includes("..") || branchKey.includes("\\")) throw new Error("Некорректный ключ ветки");
  const readable = branchKey.replace(/^refs\/(heads|remotes)\//, "").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 70);
  return `${readable}--${createHash("sha256").update(branchKey).digest("hex").slice(0, 20)}`;
}

const excludedDirectories = new Set([".git", ".gitnexus", ".agents", ".claude", ".codex", "node_modules", "graphify-out"]);
function allowed(name) {
  const parts = name.split("/");
  return !path.isAbsolute(name) && parts.every(p => p && p !== ".." && p !== "."
    && !p.startsWith(".env") && !p.endsWith(".env") && !p.startsWith(".codegraph") && !excludedDirectories.has(p));
}
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function realWithTail(value) {
  if (fs.existsSync(value)) return fs.realpathSync(value);
  return path.join(realWithTail(path.dirname(value)), path.basename(value));
}

/** Independent sanitized Git history; never adds worktrees or writes to the source repository. */
export function createGitSourceSnapshot({ checkoutPath, destination, reference, workingTree, branch, previousSnapshot }) {
  const before = readGitCheckout(checkoutPath);
  const source = before.checkoutPath;
  const directory = realWithTail(path.resolve(destination));
  if (inside(source, directory) || fs.existsSync(directory)) throw new Error("Нужна новая папка вне исходного проекта");
  git(source, ["check-ref-format", "--branch", branch]);
  if (typeof reference !== "string" || reference.startsWith("-") || /[\s\0]/.test(reference)) throw new Error("Некорректная ссылка Git");
  const sourceCommit = git(source, ["rev-parse", "--verify", "--end-of-options", `${reference}^{commit}`]).trim();
  if (workingTree && sourceCommit !== before.commit) throw new Error("Рабочие файлы относятся только к текущему коммиту");
  const records = workingTree
    ? [...new Set(git(source, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean))]
      .map(name => ({ name }))
    : git(source, ["ls-tree", "-rlz", sourceCommit]).split("\0").filter(Boolean).map(line => {
      const tab = line.indexOf("\t");
      const [mode, type, oid, size] = line.slice(0, tab).trim().split(/\s+/);
      return { name: line.slice(tab + 1), mode, type, oid, size: Number(size) };
    });
  const files = [];
  const excluded = [];
  let total = 0;
  for (const item of records.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (!allowed(item.name)) { excluded.push(item.name); continue; }
    let content, mode;
    if (workingTree) {
      const filename = path.join(source, item.name);
      let stat;
      try { stat = fs.lstatSync(filename); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (!stat.isFile() || fs.realpathSync(filename) !== filename) { excluded.push(item.name); continue; }
      if (stat.size > 32 * 1024 * 1024) throw new Error(`Файл больше предела снимка 32 MiB: ${item.name}`);
      const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { content = fs.readFileSync(fd); } finally { fs.closeSync(fd); }
      mode = stat.mode & 0o111 ? "100755" : "100644";
    } else {
      if (item.type !== "blob" || !["100644", "100755"].includes(item.mode)) { excluded.push(item.name); continue; }
      if (item.size > 32 * 1024 * 1024) throw new Error(`Файл больше предела снимка 32 MiB: ${item.name}`);
      content = git(source, ["cat-file", "blob", item.oid], true);
      mode = item.mode;
    }
    total += content.length;
    if (total > 512 * 1024 * 1024) throw new Error("Снимок больше предела 512 MiB; настройка требует отдельного решения");
    files.push({ name: item.name, content, mode });
  }
  const after = readGitCheckout(source);
  if (before.commit !== after.commit || before.branch !== after.branch
    || sourceCommit !== git(source, ["rev-parse", "--verify", "--end-of-options", `${reference}^{commit}`]).trim()) {
    throw new Error("Ветка изменилась во время подготовки снимка; повторите запуск");
  }
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  if (previousSnapshot) {
    const previous = fs.realpathSync(previousSnapshot);
    const marker = JSON.parse(fs.readFileSync(path.join(previous, ".git", "ai-agents-source.json"), "utf8"));
    if (marker.schemaVersion !== 1 || marker.source !== source) throw new Error("Предыдущий снимок относится к другому источнику");
    git(path.dirname(directory), ["clone", "--no-local", "--no-checkout", "--", previous, directory]);
    git(directory, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
    git(directory, ["update-ref", `refs/heads/${branch}`, marker.snapshotCommit]);
  } else {
    fs.mkdirSync(directory, { mode: 0o700 });
    git(directory, ["init", "-b", branch]);
  }
  const fingerprint = createHash("sha256");
  for (const file of files) {
    const target = path.join(directory, file.name);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, file.content, { flag: "wx", mode: file.mode === "100755" ? 0o700 : 0o600 });
    fingerprint.update(`${file.name}\0${file.mode}\0${file.content.length}\0`).update(file.content);
  }
  git(directory, ["add", "--force", "--all"]);
  git(directory, ["-c", "user.name=Agent source snapshot", "-c", "user.email=snapshot@localhost.invalid",
    "commit", "--allow-empty", "-m", `Source ${sourceCommit}`]);
  const snapshotCommit = git(directory, ["rev-parse", "HEAD"]).trim();
  fs.writeFileSync(path.join(directory, ".git", "ai-agents-source.json"), JSON.stringify({ schemaVersion: 1, source, snapshotCommit }), { flag: "wx", mode: 0o600 });
  return { directory, sourceCommit, sourceFingerprint: fingerprint.digest("hex"), snapshotCommit, files: files.length, excluded };
}
