import assert from "assert/strict";
import { describe, it } from "node:test";
import { utils } from "ethers";
import { getStakeSets } from "../src/helpers/subgraph-events.js";
import { withoutRetryDelays } from "./support/fake-chain.js";
import { startSubgraph, withSubgraph } from "./support/subgraph-server.js";

/*
 * getStakeSets refuses a stake history the subgraph can't vouch for, since a truncated or broken one
 * would quietly give wrong averages: the golden test only covers a subgraph that is fully indexed.
 */

const events = [
  { address: "0x00000000000000000000000000000000000000aa", blocknumber: 120, logIndex: 3, newTotalStake: "5" },
  { address: "0x00000000000000000000000000000000000000bb", blocknumber: 110, logIndex: 1, newTotalStake: "7" },
];

const read = async ({ indexedBlock, hasIndexingErrors }) => {
  const subgraph = await startSubgraph({ events, indexedBlock, hasIndexingErrors });
  try {
    return await withSubgraph(1, subgraph.url, () => withoutRetryDelays(() => getStakeSets(100, 200, 1)));
  } finally {
    await subgraph.close();
  }
};

describe("stake history from the subgraph", () => {
  it("is read in chain order once the subgraph has indexed through the last block needed", async () => {
    const read199 = await read({ indexedBlock: 199 });
    assert.deepEqual(
      read199.map(({ blockNumber, args }) => [blockNumber, args._address]),
      [
        [110, utils.getAddress(events[1].address)],
        [120, utils.getAddress(events[0].address)],
      ]
    );
  });

  it("is refused while the subgraph hasn't indexed that far", async () => {
    await assert.rejects(read({ indexedBlock: 198 }), /has only indexed up to block 198/);
  });

  it("is refused when the subgraph reports indexing errors", async () => {
    await assert.rejects(read({ indexedBlock: 500, hasIndexingErrors: true }), /reports indexing errors/);
  });
});
