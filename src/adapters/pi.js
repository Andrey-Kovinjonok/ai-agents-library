import { registerPiCompatibleGitActionGuard } from "./pi-compatible-git-action-guard.js";

export default function gitActionGuardForPi(pi) {
  return registerPiCompatibleGitActionGuard(pi, { harness: "pi" });
}
