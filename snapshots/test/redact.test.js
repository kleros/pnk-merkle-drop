import assert from "assert/strict";
import { describe, it } from "node:test";
import { redact } from "../src/helpers/redact.js";

describe("redact", () => {
  it("replaces the RPC, subgraph and IPFS secrets in an error with their variables' names", () => {
    const saved = { ...process.env };
    process.env.ALCHEMY_TEST_RPC = "https://eth-mainnet.example/v2/SECRET-KEY-1";
    process.env.SUBGRAPH_TEST = "https://gateway.example/api/SECRET-KEY-2/subgraphs/id/abc";
    try {
      const message =
        'bad response (status=500, url="https://eth-mainnet.example/v2/SECRET-KEY-1", code=SERVER_ERROR) ' +
        "POST https://gateway.example/api/SECRET-KEY-2/subgraphs/id/abc responded with 500 " +
        "url: 'https://eth-mainnet.example/v2/SECRET-KEY-1'";
      const redacted = redact(message);
      assert.ok(!redacted.includes("SECRET-KEY"), redacted);
      assert.ok(redacted.includes('url="$ALCHEMY_TEST_RPC"'), redacted);
      assert.ok(redacted.includes("url: '$ALCHEMY_TEST_RPC'"), redacted);
      assert.ok(redacted.includes("POST $SUBGRAPH_TEST responded"), redacted);
    } finally {
      for (const name of ["ALCHEMY_TEST_RPC", "SUBGRAPH_TEST"]) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });
});
