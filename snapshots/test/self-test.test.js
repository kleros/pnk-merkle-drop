import assert from "assert/strict";
import { readFileSync } from "fs";
import { describe, it } from "node:test";
import { offlineEnv } from "../src/self-test.js";

describe("self-test", () => {
  it("runs the suite without any variable that reaches a chain, a subgraph or IPFS", () => {
    // every variable .env.example defines is one of them
    const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    const secrets = [...example.matchAll(/^([A-Z0-9_]+)=/gm)].map(([, name]) => name);
    assert.ok(secrets.length >= 6, secrets.join(", "));
    const env = Object.fromEntries([...secrets, "PATH", "HOME"].map((name) => [name, "value"]));
    assert.deepEqual(Object.keys(offlineEnv(env)), ["PATH", "HOME"]);
  });
});
