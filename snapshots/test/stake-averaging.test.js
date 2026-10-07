import assert from "assert/strict";
import { describe, it } from "node:test";
import { BigNumber } from "ethers";
import { getAverageStakesByAddress } from "../src/create-snapshot-from-block-limits.js";

/*
 * A juror's average stake over a period [startBlock, endBlock) weighs each block equally: in a block,
 * the stake is the newTotalStake of the juror's last StakeSet event at or before it, or 0 before the
 * first one. Events at or after endBlock don't count, and neither do the Cooperative's addresses.
 */

const A = "0x00000000000000000000000000000000000000aA";
const B = "0x00000000000000000000000000000000000000bB";
const C = "0x00000000000000000000000000000000000000cC";

// A StakeSet event, as getStakeSets returns it.
const stakeSet = (address, blockNumber, newTotalStake, logIndex = 0) => ({
  args: { _address: address, _newTotalStake: BigNumber.from(newTotalStake) },
  blockNumber,
  logIndex,
});

const average = (events, { startBlock = 100, endBlock = 200, excluded = [] } = {}) => {
  const result = getAverageStakesByAddress({ startBlock, endBlock }, events, excluded);
  return Object.fromEntries(Object.entries(result).map(([address, stake]) => [address, stake.toString()]));
};

describe("average stakes", () => {
  it("is the stake itself when it doesn't change during the period", () => {
    assert.deepEqual(average([stakeSet(A, 50, 1000)]), { [A]: "1000" });
  });

  it("counts a first stake from the block it happens in", () => {
    // 0 in blocks 100-149, 1000 in blocks 150-199
    assert.deepEqual(average([stakeSet(A, 150, 1000)]), { [A]: "500" });
  });

  it("weighs each stake by the blocks it lasts", () => {
    // 1000 in blocks 100-124, 3000 in blocks 125-199
    assert.deepEqual(average([stakeSet(A, 50, 1000), stakeSet(A, 125, 3000)]), { [A]: "2500" });
  });

  it("applies a change at the period's first block from the start", () => {
    assert.deepEqual(average([stakeSet(A, 50, 1000), stakeSet(A, 100, 3000)]), { [A]: "3000" });
  });

  it("ignores changes at or after the period's end", () => {
    assert.deepEqual(average([stakeSet(A, 50, 1000), stakeSet(A, 200, 9999), stakeSet(A, 250, 7777)]), {
      [A]: "1000",
    });
  });

  it("keeps only the last change of a block", () => {
    const events = [stakeSet(A, 150, 1000, 1), stakeSet(A, 150, 3000, 4), stakeSet(A, 150, 5000, 7)];
    assert.deepEqual(average(events), { [A]: "2500" });
  });

  it("counts an unstake from the block it happens in", () => {
    assert.deepEqual(average([stakeSet(A, 50, 1000), stakeSet(A, 150, 0)]), { [A]: "500" });
  });

  it("rounds down", () => {
    // (1 × 1 + 2 × 99) / 100
    assert.deepEqual(average([stakeSet(A, 50, 1), stakeSet(A, 101, 2)]), { [A]: "1" });
  });

  it("leaves out jurors with nothing staked during the period", () => {
    assert.deepEqual(average([stakeSet(A, 50, 0), stakeSet(B, 250, 1000), stakeSet(C, 50, 5)]), { [C]: "5" });
  });

  it("leaves out the Cooperative's addresses, whatever their case", () => {
    const events = [stakeSet(A, 50, 1000), stakeSet(B, 50, 2000)];
    assert.deepEqual(average(events, { excluded: [A.toLowerCase()] }), { [B]: "2000" });
    assert.deepEqual(average(events, { excluded: [B.toUpperCase().replace("0X", "0x")] }), { [A]: "1000" });
  });

  it("averages each juror on their own", () => {
    const events = [stakeSet(A, 50, 1000), stakeSet(B, 60, 400), stakeSet(A, 150, 3000), stakeSet(B, 175, 0)];
    assert.deepEqual(average(events), { [A]: "2000", [B]: "300" });
  });

  it("agrees with a block-by-block count on random stake histories", () => {
    // mulberry32, so that every run checks the same histories
    let seed = 0x5eed;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const integer = (max) => Math.floor(random() * max);
    const stake = () => (random() < 0.2 ? 0n : BigInt(integer(1e9)) * 10n ** BigInt(integer(16)));

    for (let scenario = 0; scenario < 300; scenario++) {
      const startBlock = 50 + integer(100);
      const endBlock = startBlock + 1 + integer(150);
      const histories = { [A]: [], [B]: [], [C]: [] };
      const events = [];
      for (const address of Object.keys(histories)) {
        const used = new Set();
        for (let i = integer(7); i > 0; i--) {
          const blockNumber = integer(endBlock + 50);
          const logIndex = integer(4);
          if (used.has(`${blockNumber}:${logIndex}`)) continue;
          used.add(`${blockNumber}:${logIndex}`);
          events.push({ address, blockNumber, logIndex, stake: stake() });
        }
      }
      // in the order getStakeSets returns them
      events.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

      const expected = {};
      for (const address of Object.keys(histories)) {
        const own = events.filter((event) => event.address === address);
        let sum = 0n;
        for (let block = startBlock; block < endBlock; block++) {
          const current = own.filter((event) => event.blockNumber <= block).pop();
          sum += current ? current.stake : 0n;
        }
        const mean = sum / BigInt(endBlock - startBlock);
        if (mean !== 0n) expected[address] = mean.toString();
      }

      const actual = average(
        events.map(({ address, blockNumber, logIndex, stake }) =>
          stakeSet(address, blockNumber, stake.toString(), logIndex)
        ),
        { startBlock, endBlock }
      );
      assert.deepEqual(actual, expected, `scenario ${scenario}: [${startBlock}, ${endBlock})`);
    }
  });
});
