import { spawnSync } from "child_process";
import { readdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const TEST_DIR = join(dirname(fileURLToPath(import.meta.url)), "../test");

// Everything that reaches a chain, a subgraph or IPFS. The suite needs none of it, and running it
// without them is what guarantees it stays offline.
const NETWORK_ENV = /^(ALCHEMY_|SUBGRAPH_|FILEBASE_)/;

/** The environment without the variables that reach a chain, a subgraph or IPFS. */
export const offlineEnv = (env) => Object.fromEntries(Object.entries(env).filter(([name]) => !NETWORK_ENV.test(name)));

// The suite takes a few seconds; a test that hangs (e.g. on a handle it leaves open) fails the run instead.
const TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Runs the offline test suite (test/*.test.js) and throws if any of it fails, so that a run never
 * starts on code, or on dependency versions, that break what the suite pins down: the stake averaging,
 * the reward formula, the merkle tree MerkleRedeem verifies against, the KIP-86 address list, the
 * exclusion helpers' guards, the run's own invariants and the seeding transaction it prints. It takes
 * a few seconds. The live suite in test/live, which reads the chains, is not part of it.
 *
 * @returns {string} What passed, as the test runner counts it, e.g. "100 tests passed, 1 todo".
 */
export function runSelfTest() {
  const files = readdirSync(TEST_DIR)
    .filter((file) => file.endsWith(".test.js"))
    .sort()
    .map((file) => join(TEST_DIR, file));
  if (files.length === 0) throw new Error(`There are no tests in ${TEST_DIR} to run`);

  const env = offlineEnv(process.env);
  const { status, stdout, stderr, error } = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...files], {
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (error?.code === "ETIMEDOUT") {
    process.stdout.write(stdout ?? "");
    process.stderr.write(stderr ?? "");
    throw new Error(`The offline test suite didn't finish within ${TIMEOUT_MS / 1000} s, so the run won't start.`);
  }
  if (error) throw error;
  if (status !== 0) {
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    throw new Error(
      `The offline test suite failed (exit code ${status}), so the run won't start. ` +
        "The failures are above. `yarn test` inside snapshots/ runs the suite on its own."
    );
  }
  const count = (name) => new RegExp(`^ℹ ${name} (\\d+)$`, "m").exec(stdout)?.[1];
  const todo = Number(count("todo") ?? 0);
  return `${count("pass") ?? "all"} tests passed${todo ? `, ${todo} todo` : ""}`;
}
