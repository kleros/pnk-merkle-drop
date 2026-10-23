import { MerkleTree } from "@kleros/merkle-tree";
import { BigNumber } from "ethers";

/**
 * Builds a snapshot the way createSnapshot does, from each address's average stake, and returns it the
 * way it is uploaded: serialized to JSON and parsed back.
 *
 * @param {Object<string, BigNumber>} stakes The average stake of each (checksummed) address.
 */
export function buildSnapshot({ stakes, droppedAmount, startDate, endDate, blockHeight, adjustedSupply }) {
  const sum = (values) => values.reduce((total, value) => total.add(value), BigNumber.from(0));
  const averageTotalStaked = sum(Object.values(stakes));
  const values = {};
  const nodes = {};
  for (const [address, stake] of Object.entries(stakes)) {
    values[address] = stake.mul(droppedAmount).div(averageTotalStaked);
    nodes[address] = MerkleTree.makeLeafNode(address, values[address]);
  }
  const tree = new MerkleTree(Object.values(nodes));
  const claims = {};
  for (const address of Object.keys(stakes)) {
    claims[address] = {
      averageStake: stakes[address],
      value: values[address],
      node: nodes[address],
      proof: tree.getHexProof(nodes[address]),
    };
  }
  return JSON.parse(
    JSON.stringify({
      merkleTree: { claims, root: tree.getHexRoot(), width: tree.getWidth(), height: tree.getHeight() },
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      blockHeight,
      averageTotalStaked,
      droppedAmount,
      totalClaimable: sum(Object.values(values)),
      apy: 0,
      adjustedSupply,
    })
  );
}
