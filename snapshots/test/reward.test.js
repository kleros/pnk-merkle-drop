import assert from "assert/strict";
import { describe, it } from "node:test";
import { BigNumber } from "ethers";
import { CHAINS } from "../src/config.js";
import { BASIS, chainDrop, computeReward } from "../src/reward.js";

const wei = (value) => BigNumber.from(value);
const target = (percentTimesTen) => BASIS.mul(percentTimesTen).div(1000);

describe("reward formula", () => {
  it("gives the September 2026 drops, from August's published drops and stakes", () => {
    // lastamount and totalPNKStaked add up the published August snapshots (mainnet and Gnosis);
    // adjustedSupply is the one the September run read at the period's last block.
    const { stakePercent, fullReward } = computeReward({
      lastamount: wei("3720848084298438935337425"),
      totalPNKStaked: wei("318677498394732788487783457"),
      adjustedSupply: wei("754579065710379852839143679"),
      target: target(354),
    });
    assert.equal(stakePercent.toString(), "422324860");
    assert.equal(fullReward.toString(), "3466621659857479896861946");
    const [mainnet, gnosis] = CHAINS;
    assert.equal(chainDrop(fullReward, mainnet.pnkDropRatio).toString(), "3119959493871731907175751");
    assert.equal(chainDrop(fullReward, gnosis.pnkDropRatio).toString(), "346662165985747989686194");
  });

  it("keeps the reward flat when the stake is exactly at the target", () => {
    const lastamount = wei("1000000000000000000000000");
    const adjustedSupply = wei("750000000000000000000000000");
    const { fullReward } = computeReward({
      lastamount,
      totalPNKStaked: adjustedSupply.mul(354).div(1000),
      adjustedSupply,
      target: target(354),
    });
    assert.equal(fullReward.toString(), lastamount.toString());
  });

  it("grows the reward below the target and shrinks it above, by the gap", () => {
    const lastamount = wei("1000000000000000000000000");
    const adjustedSupply = wei("750000000000000000000000000");
    const at = (percentTimesTen) =>
      computeReward({
        lastamount,
        totalPNKStaked: adjustedSupply.mul(percentTimesTen).div(1000),
        adjustedSupply,
        target: target(354),
      }).fullReward.toString();
    assert.equal(at(254), "1100000000000000000000000");
    assert.equal(at(454), "900000000000000000000000");
    assert.equal(at(0), "1354000000000000000000000");
  });

  it("splits the reward between the chains to within a wei per chain", () => {
    for (const reward of ["1", "999", "3466621659857479896861946", "3720848084298438935337426"]) {
      const total = CHAINS.reduce((sum, { pnkDropRatio }) => sum.add(chainDrop(wei(reward), pnkDropRatio)), wei(0));
      assert.ok(total.lte(reward) && wei(reward).sub(total).lt(CHAINS.length), reward);
    }
  });
});
