import { registerPiCompatibleGitActionGuard } from "./pi-compatible-git-action-guard.js";

export default function gitActionGuardForOhMyPi(pi) {
  return registerPiCompatibleGitActionGuard(pi, { harness: "oh-my-pi" });
}
