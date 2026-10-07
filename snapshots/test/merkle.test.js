import assert from "assert/strict";
import { describe, it } from "node:test";
import { MerkleTree } from "@kleros/merkle-tree";
import { BigNumber, constants, utils } from "ethers";
import { merkleRootOf, verifyMerkleProof } from "../src/invariants.js";

/*
 * MerkleRedeem.verifyClaim hashes a claim as keccak256(abi.encodePacked(address, uint256)) and checks it
 * with OpenZeppelin 3.x's MerkleProof, whose source is embedded in contracts/deployments:
 *
 *   for each proof element: computedHash = computedHash <= element
 *                                           ? keccak256(computedHash, element) : keccak256(element, computedHash)
 *   return computedHash == root
 *
 * The snapshots build their trees with @kleros/merkle-tree, which hashes the leaf through web3-utils'
 * soliditySha3 handed an ethers BigNumber. That only works because web3-utils recognizes the BigNumber,
 * so these tests pin the tree to the contract's rules. test/live checks the deployed contract itself.
 */
const solidityVerify = (proof, root, leaf) =>
  proof.reduce(
    (computedHash, element) =>
      BigInt(computedHash) <= BigInt(element)
        ? utils.keccak256(utils.concat([computedHash, element]))
        : utils.keccak256(utils.concat([element, computedHash])),
    leaf
  ) === root;

const contractLeaf = (address, value) => utils.solidityKeccak256(["address", "uint256"], [address, value]);

let seed = 7;
const randomBytes = (length) =>
  utils.hexlify(
    Array.from({ length }, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % 256;
    })
  );

// Claims as createSnapshot makes them: checksummed addresses and BigNumber amounts.
const randomClaims = (count) =>
  Array.from({ length: count }, () => ({
    address: utils.getAddress(randomBytes(20)),
    value: BigNumber.from(randomBytes(12)),
  }));

describe("merkle tree", () => {
  it("hashes a claim the way MerkleRedeem does", () => {
    const values = [0, 1, "3119959493871731907175751", constants.MaxUint256];
    for (const { address } of randomClaims(4)) {
      for (const value of values) {
        assert.equal(
          MerkleTree.makeLeafNode(address, BigNumber.from(value)),
          contractLeaf(address, value),
          `${address} ${value}`
        );
      }
    }
  });

  for (const size of [1, 2, 3, 4, 5, 7, 8, 9, 16, 17, 100]) {
    it(`builds a tree of ${size} claims whose every proof MerkleRedeem accepts, and only those`, () => {
      const claims = randomClaims(size);
      const leaves = claims.map(({ address, value }) => MerkleTree.makeLeafNode(address, value));
      const tree = new MerkleTree(leaves);
      const root = tree.getHexRoot();

      for (const [i, leaf] of leaves.entries()) {
        const proof = tree.getHexProof(leaf);
        assert.ok(solidityVerify(proof, root, leaf), `claim ${i}`);
        assert.ok(verifyMerkleProof(proof, root, leaf), `claim ${i}, as the run checks it`);
        const { address, value } = claims[i];
        const inflated = contractLeaf(address, value.add(1));
        assert.equal(solidityVerify(proof, root, inflated), false);
        assert.equal(verifyMerkleProof(proof, root, inflated), false);
      }
      if (size === 1) assert.equal(root, leaves[0]);
    });
  }

  it("has a root that commits to exactly its claims", () => {
    const leaves = randomClaims(33).map(({ address, value }) => MerkleTree.makeLeafNode(address, value));
    const root = new MerkleTree(leaves).getHexRoot();
    assert.equal(merkleRootOf(leaves), root);
    assert.notEqual(merkleRootOf(leaves.slice(1)), root);
    assert.notEqual(merkleRootOf([...leaves, contractLeaf(constants.AddressZero, 1)]), root);
  });
});
