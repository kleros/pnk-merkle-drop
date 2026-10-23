import assert from "assert/strict";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { describe, it } from "node:test";
import { BigNumber } from "ethers";
import { CHAINS, KIP_86_EXCLUDED_ADDRESSES } from "../src/config.js";
import { createSnapshotCreator } from "../src/create-snapshot-from-block-limits.js";
import { assertSnapshotIntegrity } from "../src/invariants.js";
import { BASIS, chainDrop, computeReward } from "../src/reward.js";
import { FakeChain } from "./support/fake-chain.js";
import { startSubgraph, withSubgraph } from "./support/subgraph-server.js";

/*
 * The August 2026 drop, regenerated from the stake events the subgraph served for it, must come out
 * exactly as published: the same bytes the Court frontend serves, under the roots seeded in MerkleRedeem
 * (mainnet week 66, Gnosis week 61). test/fixtures/generate-golden.js recorded the inputs.
 */
const golden = JSON.parse(readFileSync(new URL("./fixtures/golden-2026-08.json", import.meta.url), "utf8"));
const startDate = new Date(golden.startDate);
const endDate = new Date(golden.endDate);

// A chain whose timestamps make `startBlock` its first block of the period and `endBlock` its last.
function chainSpanning({ chainId, startBlock, endBlock }) {
  const start = startDate.getTime() / 1000;
  const end = endDate.getTime() / 1000;
  const timestampOf = (number) => {
    // The block before the period is stamped exactly on its first second, as Gnosis block 47492864 was on
    // 2026-08-01. That block belongs to neither period (see findFirstAfter), which is how the published
    // drops were computed, so a block finder that counted it in would fail this test.
    if (number < startBlock) return start - (startBlock - number) + 1;
    if (number > endBlock) return end + (number - endBlock - 1);
    return start + 1 + Math.floor(((number - startBlock) * (end - start - 2)) / (endBlock - startBlock));
  };
  return new FakeChain({ chainId, head: endBlock + 1000, timestampOf });
}

describe("the August 2026 drop, regenerated from its stake events", () => {
  for (const chain of golden.chains) {
    it(`reproduces the published chain ${chain.chainId} snapshot byte for byte`, async () => {
      const subgraph = await startSubgraph({
        events: chain.events.map((line) => {
          const [address, blocknumber, logIndex, newTotalStake] = line.split(",");
          return { address, blocknumber: Number(blocknumber), logIndex: Number(logIndex), newTotalStake };
        }),
        indexedBlock: chain.endBlock,
      });
      try {
        const json = await withSubgraph(chain.chainId, subgraph.url, async () => {
          const createSnapshot = await createSnapshotCreator({
            provider: chainSpanning(chain),
            droppedAmount: BigNumber.from(chain.droppedAmount),
            excludedAddresses: KIP_86_EXCLUDED_ADDRESSES,
          });
          // as cli.js calls it, with the configured first block and the period's last block already pinned
          const snapshot = await createSnapshot({
            fromBlock: CHAINS.find(({ chainId }) => chainId === chain.chainId).fromBlock,
            startDate,
            endDate,
            endBlock: chain.endBlock,
          });
          snapshot.adjustedSupply = BigNumber.from(chain.adjustedSupply);
          return JSON.stringify(snapshot);
        });

        assert.equal(JSON.parse(json).merkleTree.root, chain.published.root);
        assert.equal(createHash("sha256").update(json).digest("hex"), chain.published.sha256);
        assertSnapshotIntegrity(JSON.parse(json), {
          chainId: chain.chainId,
          startDate,
          endDate,
          endBlock: chain.endBlock,
          adjustedSupply: BigNumber.from(chain.adjustedSupply),
          excludedAddresses: KIP_86_EXCLUDED_ADDRESSES,
        });
      } finally {
        await subgraph.close();
      }
    });
  }

  it("drops what the reward formula gives for July's published drops and stakes", () => {
    const { formula } = golden;
    const { fullReward } = computeReward({
      lastamount: BigNumber.from(formula.lastamount),
      totalPNKStaked: BigNumber.from(formula.totalPNKStaked),
      adjustedSupply: BigNumber.from(formula.adjustedSupply),
      // KIP-66: 33% for 2025-09, 0.2 points more each period after
      target: BASIS.mul(352).div(1000),
    });
    for (const chain of CHAINS) {
      assert.equal(chainDrop(fullReward, chain.pnkDropRatio).toString(), formula.drops[chain.chainId]);
    }
  });
});
