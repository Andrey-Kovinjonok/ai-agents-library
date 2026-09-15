import {
  beginGitActionPermission,
  createGitActionPermission,
  finishGitActionPermission,
} from "./git-action-permissions.js";

const COMMIT = /\bgit\s+commit\b/iu;
const PUSH = /\bgit\s+push\b/iu;
const COMMIT_NO_VERIFY = /\bgit\s+commit\b[^\n]*(?:--no-verify|\s-\w*n\w*(?:\s|$))/iu;
const PUSH_NO_VERIFY = /\bgit\s+push\b[^\n]*--no-verify/iu;
const COMMANDS = [
  ["commit", /(?<!\w)КОММИТЬ(?<bang>!)?(?!\w)/u],
  ["commit", /(?<!\w)АМЕНДИ(?<bang>!)?(?!\w)/u],
  ["push", /(?<!\w)ПУШ(?<bang>!)?(?!\w)/u],
];

export function authorizationKindsFromPrompt(prompt) {
  if (typeof prompt !== "string") return [];
  if (/^\s*ОТКАТИ\s*$/u.test(prompt)) return ["rollback"];
  for (const [kind, pattern] of COMMANDS) {
    const match = pattern.exec(prompt);
    if (match === null) continue;
    return match.groups?.bang === "!" ? [kind, "noverify"] : [kind];
  }
  return [];
}

export function gitRequirementsFromCommand(command) {
  if (typeof command !== "string" || command === "") return [];
  const requirements = [];
  if (COMMIT_NO_VERIFY.test(command)) requirements.push({ kind: "noverify", action: "commit" });
  else if (PUSH_NO_VERIFY.test(command)) requirements.push({ kind: "noverify", action: "push" });
  if (COMMIT.test(command)) requirements.push({ kind: "commit", action: "commit" });
  if (PUSH.test(command)) requirements.push({ kind: "push", action: "push" });
  const hardReset = /\bgit\s+reset\b[^\n]*--hard/iu.test(command);
  const checkoutFiles = /\bgit\s+checkout\b[^\n]*\s--(?:\s|$)/iu.test(command);
  const restore = /\bgit\s+restore\b[^\n]*/iu.exec(command)?.[0] ?? "";
  const restoreChangesWorktree = restore !== ""
    && (!/(?:^|\s)--staged(?:\s|$)/u.test(restore) || /(?:^|\s)--worktree(?:\s|$)/u.test(restore));
  if (hardReset || checkoutFiles || restoreChangesWorktree) {
    requirements.push({ kind: "rollback", action: "rollback" });
  }
  return requirements;
}

export function recordGitAuthorizations(options) {
  const kinds = authorizationKindsFromPrompt(options.prompt);
  return kinds.map((kind) => createGitActionPermission({ ...options, kind }));
}

export function beginGitCommandAuthorization(options) {
  const requirements = gitRequirementsFromCommand(options.command);
  for (const requirement of requirements) {
    if (!beginGitActionPermission({ ...options, kind: requirement.kind })) {
      return { allowed: false, requirement, requirements };
    }
  }
  return { allowed: true, requirement: null, requirements };
}

export function finishGitCommandAuthorization(options) {
  const requirements = gitRequirementsFromCommand(options.command);
  return requirements.map((requirement) => ({
    ...requirement,
    outcome: finishGitActionPermission({
      ...options,
      kind: requirement.kind,
      changesBranchRef: requirement.action === "commit",
    }),
  }));
}

export function gitAuthorizationMessage(requirement) {
  if (requirement.kind === "commit") return "Для git commit нужна команда пользователя: КОММИТЬ или АМЕНДИ.";
  if (requirement.kind === "push") return "Для git push нужна команда пользователя: ПУШ.";
  if (requirement.kind === "rollback") return "Для изменения или удаления незакоммиченных данных нужна отдельная точная команда пользователя: ОТКАТИ.";
  return requirement.action === "push"
    ? "Для git push --no-verify нужна команда пользователя: ПУШ!."
    : "Для git commit --no-verify нужна команда пользователя: КОММИТЬ! или АМЕНДИ!.";
}
