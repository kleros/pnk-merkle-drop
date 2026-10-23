import { BigNumber } from "ethers";

// basis points: 9 zeroes
export const BASIS = BigNumber.from(1000000000);

/**
 * The KIP-66 reward for a period, compounding on the previous period's drop:
 *
 *   reward = lastamount × (1 + target − staked)
 *
 * where `staked` is the share of the adjusted supply staked in Court. Everything is in fixed point
 * with BASIS = 100%, rounded down at each step, which is what makes a period reproducible to the wei.
 *
 * @param {Object} options
 * @param {BigNumber} options.lastamount The total dropped in the previous period, in wei.
 * @param {BigNumber} options.totalPNKStaked The average stake used by the formula, in wei.
 * @param {BigNumber} options.adjustedSupply The total supply minus the KIP-86 exclusions, in wei.
 * @param {BigNumber} options.target The staking target, in BASIS units.
 * @returns {{ stakePercent: BigNumber, multiplier: BigNumber, fullReward: BigNumber }}
 */
export function computeReward({ lastamount, totalPNKStaked, adjustedSupply, target }) {
  const stakePercent = totalPNKStaked.mul(BASIS).div(adjustedSupply);
  const multiplier = BASIS.add(target).sub(stakePercent);
  const fullReward = lastamount.mul(multiplier).div(BASIS);
  return { stakePercent, multiplier, fullReward };
}

/** A chain's share of the reward, rounded down. */
export const chainDrop = (fullReward, pnkDropRatio) => fullReward.mul(pnkDropRatio).div(BASIS);
