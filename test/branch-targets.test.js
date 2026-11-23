import assert from "node:assert/strict";
import test from "node:test";

import {
  CURRENT_BRANCH_TARGET,
  BRANCH_TARGETS_VERSION,
  migrateLegacyBranchTargets,
  resolveBranchTargets,
} from "ai-agents-library/branch-targets";

const commit = "a".repeat(40);
const resolve = (targets, options = {}) => resolveBranchTargets({
  targetsVersion: 2, targets, currentBranch: "feature/task", remotes: ["origin"], ...options,
});

test("точное обозначение __CURERNT__ и версия формата экспортируются", () => {
  assert.equal(CURRENT_BRANCH_TARGET, "__CURERNT__");
  assert.equal(BRANCH_TARGETS_VERSION, 2);
});

test("указатель становится настоящим именем, origin/beta остаётся отдельной целью", () => {
  assert.deepEqual(resolve([CURRENT_BRANCH_TARGET, "origin/beta"]), [
    { requestedTargets: [CURRENT_BRANCH_TARGET], kind: "local", branch: "feature/task",
      ref: "HEAD", branchKey: "refs/heads/feature/task", workingTree: true },
    { requestedTargets: ["origin/beta"], kind: "remote", branch: "origin/beta",
      ref: "refs/remotes/origin/beta", branchKey: "refs/remotes/origin/beta", workingTree: false },
  ]);
});

test("current, Current, CURRENT и __CURRENT__ — настоящие ветки, не указатели", () => {
  for (const name of ["current", "Current", "CURRENT", "__CURRENT__"]) {
    const [target] = resolve([name]);
    assert.equal(target.branch, name);
    assert.equal(target.branchKey, `refs/heads/${name}`);
    assert.equal(target.workingTree, false);
  }
});

test("настоящая ветка с именем __CURERNT__ доступна через полную ссылку", () => {
  const targets = resolve([CURRENT_BRANCH_TARGET, "refs/heads/__CURERNT__"]);
  assert.equal(targets.length, 2);
  assert.equal(targets[1].branch, "__CURERNT__");
  assert.equal(targets[1].workingTree, false);
});

test("локальная beta и удалённая origin/beta не смешиваются", () => {
  const targets = resolve([CURRENT_BRANCH_TARGET, "origin/beta"], { currentBranch: "beta" });
  assert.deepEqual(targets.map(t => t.branchKey), ["refs/heads/beta", "refs/remotes/origin/beta"]);
});

test("указатель и выбранная локальная ветка объединяются независимо от порядка", () => {
  for (const list of [[CURRENT_BRANCH_TARGET, "beta", "refs/heads/beta"],
    ["refs/heads/beta", "beta", CURRENT_BRANCH_TARGET]]) {
    const [target, ...rest] = resolve(list, { currentBranch: "beta" });
    assert.equal(rest.length, 0);
    assert.deepEqual(target.requestedTargets, list);
    assert.equal(target.ref, "HEAD");
    assert.equal(target.workingTree, true);
  }
});

test("короткая и полная удалённая ссылка объединяются, локальный тёзка остаётся", () => {
  const targets = resolve(["origin/beta", "refs/remotes/origin/beta", "refs/heads/origin/beta"]);
  assert.equal(targets.length, 2);
  assert.deepEqual(targets[0].requestedTargets, ["origin/beta", "refs/remotes/origin/beta"]);
  assert.equal(targets[1].branchKey, "refs/heads/origin/beta");
});

test("источники remotes передаются продуктом, имя с косой чертой само по себе локальное", () => {
  const targets = resolve(["upstream/main", "feature/task", "origin/beta"], { remotes: ["upstream"] });
  assert.deepEqual(targets.map(t => t.kind), ["remote", "local", "local"]);
});

test("на каждом вызове текущая ветка разрешается заново", () => {
  const targets = [CURRENT_BRANCH_TARGET, "origin/beta"];
  assert.equal(resolve(targets, { currentBranch: "first" })[0].branch, "first");
  assert.equal(resolve(targets, { currentBranch: "second" })[0].branch, "second");
});

test("отделённый снимок различается по полному номеру, а не общему HEAD", () => {
  const [target] = resolve([CURRENT_BRANCH_TARGET], { currentBranch: null, currentCommit: commit });
  assert.deepEqual(target, { requestedTargets: [CURRENT_BRANCH_TARGET], kind: "detached",
    branch: null, ref: commit, branchKey: `commit:${commit}`, workingTree: true });
  assert.notEqual(target.branchKey, resolve([CURRENT_BRANCH_TARGET], {
    currentBranch: null, currentCommit: "b".repeat(64),
  })[0].branchKey);
  for (const currentCommit of [undefined, "HEAD", "abc1234", "z".repeat(40)]) {
    assert.throws(() => resolve([CURRENT_BRANCH_TARGET], { currentBranch: null, currentCommit }), /currentCommit/);
  }
});

test("без текущей ветки разрешаются заданные ветки, пустой список не добавляет main", () => {
  assert.equal(resolve(["origin/main"], { currentBranch: null })[0].branch, "origin/main");
  assert.deepEqual(resolve([]), []);
});

test("нет молчаливого принятия старого или неуказанного формата", () => {
  for (const targetsVersion of [undefined, 1, 3, "2"]) {
    assert.throws(() => resolve(["current"], { targetsVersion }), /targetsVersion/);
  }
});

test("некорректные цели отвергаются без нормализации и скрытого выбора main", () => {
  for (const name of ["", " main", "main ", "HEAD", "-x", "a..b", "a@{b", "a\\b", "a*b",
    "a?b", "a[b", "a~b", "a^b", "a:b", "a\nb", "a\u0000b", "a\u202eb", "a//b", "/a", "a/",
    ".hidden", "a/.hidden", "a.lock", "a./", "refs/tags/v1", "refs/heads/", "refs/remotes/origin"] ) {
    assert.throws(() => resolve([name]), { name: "TypeError" }, name);
  }
  for (const targets of [null, "current", [42], [null]]) {
    assert.throws(() => resolve(targets), { name: "TypeError" });
  }
});

test("неполные сведения о Git отвергаются, неверное имя не превращается в путь", () => {
  for (const currentBranch of [undefined, 12, "", "HEAD", "../bad"]) {
    assert.throws(() => resolve([CURRENT_BRANCH_TARGET], { currentBranch }), /currentBranch/);
  }
  for (const remotes of [undefined, "origin", [null], ["-option"], ["origin/path"]]) {
    assert.throws(() => resolve(["origin/beta"], { remotes }), /remotes/);
  }
});

test("входы не изменяются, возвращаемые объекты не разделяют изменяемое состояние", () => {
  const input = Object.freeze({ targetsVersion: 2, targets: Object.freeze([CURRENT_BRANCH_TARGET, "current"]),
    currentBranch: "feature/task", remotes: Object.freeze(["origin"]) });
  const first = resolveBranchTargets(input);
  first[0].requestedTargets.push("changed");
  first[0].branch = "changed";
  assert.deepEqual(resolveBranchTargets(input), resolve([CURRENT_BRANCH_TARGET, "current"]));
});

test("переход старого формата явный, сохраняет настоящую ветку с новым зарезервированным именем", () => {
  const input = Object.freeze({ targetsVersion: 1,
    targets: Object.freeze(["current", "Current", "origin/beta", "__CURERNT__"]) });
  assert.throws(() => migrateLegacyBranchTargets(input), /confirmCurrentSelector/);
  assert.deepEqual(migrateLegacyBranchTargets(input, { confirmCurrentSelector: true }), {
    targetsVersion: 2, targets: [CURRENT_BRANCH_TARGET, "Current", "origin/beta", "refs/heads/__CURERNT__"],
  });
  assert.deepEqual(input.targets, ["current", "Current", "origin/beta", "__CURERNT__"]);
  assert.throws(() => migrateLegacyBranchTargets({ targetsVersion: 2, targets: ["current"] },
    { confirmCurrentSelector: true }), /targetsVersion/);
});

test("имена, которые могут совпасть после упрощения каталога, имеют разные идентификаторы", () => {
  const targets = resolve(["feature/x", "feature-x", "feature_x", "Feature/x"]);
  assert.equal(new Set(targets.map(t => t.branchKey)).size, 4);
});

test("переход формата не маскирует повреждённый список целей", () => {
  for (const targets of [undefined, null, ["current", 3], ["current", "main "]]) {
    assert.throws(() => migrateLegacyBranchTargets({ targetsVersion: 1, targets },
      { confirmCurrentSelector: true }), { name: "TypeError" });
  }
});
