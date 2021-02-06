import { MerkleTree } from "./MerkleTree";
import { Buffer } from "buffer";
import { toBuffer } from "ethereumjs-util";
import { soliditySha3, toWei } from "web3-utils";
import allocations from "./_fixtures/sample-allocation.json";
/**
 * Adapted from OpenZeppelin MerkleProof contract.
 *
 * @see {https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/cryptography/MerkleProof.sol}
 * @param proof The merkle path from `leaf` to `root`.
 * @param root The root of the merkle tree.
 * @param leaf The leaf node.
 * @return valid Whether the proof is valid or not.
 */
function verify(proof: string[], root: string, leaf: string) {
  return (
    root ===
    proof.reduce(
      (computedHash: string, proofElement: string): string =>
        Buffer.compare(toBuffer(computedHash), toBuffer(proofElement)) <= 0
          ? (soliditySha3(computedHash, proofElement) as string)
          : (soliditySha3(proofElement, computedHash) as string),
      leaf
    )
  );
}

describe("MerkleTree", () => {
  describe("Sanity tests", () => {
    const nodes: string[] = [
      MerkleTree.makeLeafNode("0x0000000000000000000000000000000000000000", "1234"),
      MerkleTree.makeLeafNode("0x0000000000000000000000000000000000000002", "10"),
      MerkleTree.makeLeafNode("0x0000000000000000000000000000000000000004", "8"),
      MerkleTree.makeLeafNode("0x0000000000000000000000000000000000000003", "10"),
      MerkleTree.makeLeafNode("0x0000000000000000000000000000000000000005", "7"),
      MerkleTree.makeLeafNode("0x0000000000000000000000000000000000000001", "2"),
    ];

    const mt = new MerkleTree(nodes);
    const root = mt.getHexRoot();

    it("Should correctly verify all nodes in the tree", () => {
      nodes.forEach((leaf) => {
        const proof = mt.getHexProof(leaf);
        expect(verify(proof, root, leaf)).toBe(true);
      });
    });

    it("Should not be able to get the proof of a non-existing node", () => {
      const leaf = MerkleTree.makeLeafNode("0x0000000000000000000000000000000000000000", "DOES NOT EXIST");
      expect(() => mt.getHexProof(leaf)).toThrowError("Element does not exist in the merkle tree");
    });

    it("Should fail to verify an invalid proof", () => {
      const proof = mt.getHexProof(nodes[0]);
      const leaf = MerkleTree.makeLeafNode("0x0000000000000000000000000000000000000000", "DOES NOT EXIST");
      expect(verify(proof, root, leaf)).toBe(false);
    });
  });

  describe("Property based tests", () => {
    range(1, randomInt(10, 100)).forEach((i) => {
      // Up to 10% of the allocations fixture
      const maxSize = randomInt(0, Object.keys(allocations).length / 10);
      const nodes: string[] = createNodes(createSample(maxSize, allocations as BalanceEntries));

      const mt = new MerkleTree(nodes);
      const root = mt.getHexRoot();

      describe(`[#${i}]:
          - # of elements: ${nodes.length}
          - root: ${root}`, () => {
        it("Should correctly verify all nodes in the tree", () => {
          nodes.forEach((leaf) => {
            const proof = mt.getHexProof(leaf);
            expect(verify(proof, root, leaf)).toBe(true);
          });
        });
      });
    });
  });
});

type BalanceEntries = Record<string, string>;

function createNodes(balances: BalanceEntries): string[] {
  return Object.entries(balances).map(([account, value]) => MerkleTree.makeLeafNode(account, toWei(value)));
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomElement<T>(arr: T[]): T {
  return arr[randomInt(0, arr.length - 1)];
}

function createSample(maxSize: number, balances: BalanceEntries): BalanceEntries {
  const entries = Object.entries(balances);

  return Object.fromEntries(
    Array(maxSize)
      .fill(0)
      .map(() => randomElement(entries))
  );
}

function range(start: number, end: number): number[] {
  return Array(end - start + 1)
    .fill(0)
    .map((_, index) => index);
}
