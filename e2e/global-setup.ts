// Builds the server exactly as the release workflow does, page included, so
// the tests run what users download. Cargo makes this a no-op when nothing
// changed; there is deliberately no switch to skip it and test a stale binary.
import { execFileSync } from "node:child_process";

import { REPO } from "./lib/editor";

export default function globalSetup() {
  execFileSync("cargo", ["build", "--release", "--locked"], { cwd: REPO, stdio: "inherit" });
}
