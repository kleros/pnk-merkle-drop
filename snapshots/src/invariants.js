import { BigNumber, Contract, constants, utils } from "ethers";
import { retry } from "./helpers/retry.js";

/*
 * Invariants a run has to satisfy before anything leaves this machine. Each check re-derives what it
 * verifies independently of the code that produced it, or from another source: the merkle checks hash
 * with ethers rather than through @kleros/merkle-tree, the seeding checks ask the deployed contracts,
 * and the stake check holds a fresh reading of the subgraph against the published snapshots. A violation
 * throws an InvariantError, which stops the run before it uploads anything or prints the seeding
 * transactions.
 *
 * Seeding is what makes a mistake permanent: MerkleRedeem can't replace a week's root once set, and it
 * has no way to give tokens back, so PNK seeded against a root nobody can claim from stays locked in it.
 */

export class InvariantError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvariantError";
  }
}

function check(condition, message) {
  if (!condition) throw new InvariantError(message);
}

// The reward formula's fixed point: 1000000000 is 100%.
const ONE = BigNumber.from(1000000000);

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/** keccak256(abi.encodePacked(address, uint256)), the leaf MerkleRedeem.verifyClaim hashes for a claim. */
export const claimLeaf = (address, value) => utils.solidityKeccak256(["address", "uint256"], [address, value]);

// OpenZeppelin 3.x's MerkleProof, which MerkleRedeem is compiled with, hashes each pair in ascending order.
// Both sides are lowercase 32-byte hex strings, so comparing them as strings compares them as numbers.
const hashPair = (a, b) => utils.keccak256(a <= b ? utils.concat([a, b]) : utils.concat([b, a]));

/** MerkleProof.verify, as MerkleRedeem runs it. */
export function verifyMerkleProof(proof, root, leaf) {
  const computed = proof.reduce((hash, element) => hashPair(hash, element.toLowerCase()), leaf.toLowerCase());
  return computed === root.toLowerCase();
}

/**
 * The root of the tree @kleros/merkle-tree builds over these leaves: sorted and deduplicated, hashed in
 * pairs, with an odd node out carried up to the next layer as it is.
 */
export function merkleRootOf(leaves) {
  // lowercase 32-byte hex strings, so comparing them as strings orders them as numbers, like Buffer.compare
  let layer = [...new Set(leaves.map((leaf) => leaf.toLowerCase()))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(i + 1 < layer.length ? hashPair(layer[i], layer[i + 1]) : layer[i]);
    }
    layer = next;
  }
  return layer[0];
}

/**
 * Checks a snapshot exactly as it will be uploaded (the parsed JSON, not the in-memory object) against
 * what MerkleRedeem and the Court frontend need from it:
 *
 *  - every claim is keyed by its checksummed address, which the frontend looks claims up by, belongs
 *    to no KIP-86 address, and has as its `node` the leaf the contract hashes for it;
 *  - every proof verifies against the root under the contract's own MerkleProof, and the root commits
 *    to exactly the listed claims: rebuilt from them alone, it comes out the same;
 *  - every claim is exactly its pro-rata share of the drop, so the claims add up to the drop minus
 *    less than a wei per claim. More, and since MerkleRedeem pays every claim from its whole balance,
 *    the excess would be paid out of other weeks' unclaimed PNK; markedly less, and PNK nobody can
 *    claim would be stuck in the contract;
 *  - it covers the period being generated, read up to the period's pinned block.
 *
 * @returns {{ claims: number, totalClaimed: BigNumber, dust: BigNumber }}
 */
export function assertSnapshotIntegrity(
  snapshot,
  { chainId, startDate, endDate, endBlock, adjustedSupply, excludedAddresses }
) {
  const where = `Chain ${chainId} snapshot`;
  const tree = snapshot.merkleTree;
  check(tree && tree.claims && BYTES32.test(tree.root), `${where} has no valid merkle tree`);
  const claims = Object.entries(tree.claims);
  check(claims.length > 0, `${where} has no claims`);
  const root = tree.root.toLowerCase();

  const droppedAmount = BigNumber.from(snapshot.droppedAmount);
  const averageTotalStaked = BigNumber.from(snapshot.averageTotalStaked);
  check(droppedAmount.gt(0), `${where} drops ${droppedAmount} wei`);
  check(averageTotalStaked.gt(0), `${where} has an average total stake of ${averageTotalStaked} wei`);

  const excluded = new Set(excludedAddresses.map((address) => address.toLowerCase()));
  let totalClaimed = BigNumber.from(0);
  let totalStaked = BigNumber.from(0);
  const leaves = [];
  for (const [address, claim] of claims) {
    check(
      utils.isAddress(address) && utils.getAddress(address) === address && address !== constants.AddressZero,
      `${where}: claim key ${address} is not a checksummed, non-zero address`
    );
    check(!excluded.has(address.toLowerCase()), `${where}: KIP-86 excluded address ${address} has a claim`);

    const value = BigNumber.from(claim.value);
    const averageStake = BigNumber.from(claim.averageStake);
    check(averageStake.gt(0), `${where}: ${address} has a claim with an average stake of ${averageStake} wei`);
    const share = averageStake.mul(droppedAmount).div(averageTotalStaked);
    check(value.eq(share), `${where}: ${address} claims ${value} wei, but its pro-rata share of the drop is ${share}`);

    const leaf = claimLeaf(address, value);
    check(
      String(claim.node).toLowerCase() === leaf,
      `${where}: ${address}'s node is not keccak256(abi.encodePacked(address, value))`
    );
    check(
      Array.isArray(claim.proof) && claim.proof.every((element) => BYTES32.test(element)),
      `${where}: ${address}'s proof is malformed`
    );
    check(
      verifyMerkleProof(claim.proof, root, leaf),
      `${where}: ${address}'s proof does not verify against root ${root}, so MerkleRedeem would reject the claim`
    );

    totalClaimed = totalClaimed.add(value);
    totalStaked = totalStaked.add(averageStake);
    leaves.push(leaf);
  }

  check(
    merkleRootOf(leaves) === root && tree.width === claims.length,
    `${where}: root ${root} does not commit to exactly the ${claims.length} listed claims`
  );
  check(
    totalStaked.eq(averageTotalStaked),
    `${where}: averageTotalStaked is ${averageTotalStaked} wei, but the claims' average stakes add up to ${totalStaked}`
  );
  check(
    BigNumber.from(snapshot.totalClaimable).eq(totalClaimed),
    `${where}: totalClaimable is ${BigNumber.from(
      snapshot.totalClaimable
    )} wei, but the claims add up to ${totalClaimed}`
  );
  // Implied by the shares and the total stake checked above, but these are what the contract depends on:
  // they still hold the line if the way claims are shared out ever changes.
  check(
    totalClaimed.lte(droppedAmount),
    `${where}: the claims add up to ${totalClaimed} wei, more than the ${droppedAmount} wei dropped`
  );
  const dust = droppedAmount.sub(totalClaimed);
  check(dust.lt(claims.length), `${where}: ${dust} wei of the drop can't be claimed by anyone`);

  check(
    snapshot.startDate === startDate.toISOString() && snapshot.endDate === endDate.toISOString(),
    `${where} covers ${snapshot.startDate} → ${
      snapshot.endDate
    }, not ${startDate.toISOString()} → ${endDate.toISOString()}`
  );
  check(
    snapshot.blockHeight === endBlock,
    `${where} was read up to block ${snapshot.blockHeight}, not the period's last block ${endBlock}`
  );
  check(
    BigNumber.from(snapshot.adjustedSupply).eq(adjustedSupply),
    `${where} records an adjusted supply of ${BigNumber.from(snapshot.adjustedSupply)} wei, not ${adjustedSupply}`
  );

  return { claims: claims.length, totalClaimed, dust };
}

/**
 * The KIP-66 staking target for a period: 33% for September 2025, 0.2 points more each period after,
 * capped at 50%. In integers, so that it doesn't depend on how the run derived its own target.
 *
 * @param {string} period The period, as `YYYY-MM`.
 * @returns {BigNumber} The target, where 1000000000 is 100%.
 */
export function scheduledTarget(period) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  check(match, `${period} is not a YYYY-MM period`);
  const periodsSinceStart = (Number(match[1]) - 2025) * 12 + Number(match[2]) - 9;
  check(periodsSinceStart >= 0, `${period} is before 2025-09, where the KIP-66 schedule starts`);
  return BigNumber.from(Math.min(330000000 + 2000000 * periodsSinceStart, 500000000));
}

/**
 * Checks the reward formula's inputs, and that the reward is what the formula allows for them.
 *
 * The KIP-86 exclusions have to leave a positive supply, and the stake has to fit in it: staked PNK
 * sits in the Court's contracts, outside the Cooperative's holdings, so a stake reaching the adjusted
 * supply means the exclusions or the stake history are wrong. The target has to be the one scheduled
 * for the period. With the stake share between 0 and 100%, the reward is positive and at most the last
 * drop × (1 + target).
 */
export function assertReward({
  period,
  totalSupply,
  cooperativePNK,
  adjustedSupply,
  totalPNKStaked,
  lastamount,
  target,
  fullReward,
}) {
  check(
    cooperativePNK.gte(0) && cooperativePNK.lt(totalSupply),
    `KIP-86 excludes ${cooperativePNK} wei, which is not less than the total supply of ${totalSupply} wei`
  );
  check(
    adjustedSupply.eq(totalSupply.sub(cooperativePNK)),
    `The adjusted supply ${adjustedSupply} is not the total supply ${totalSupply} minus the ${cooperativePNK} excluded`
  );
  check(
    totalPNKStaked.gt(0) && totalPNKStaked.lt(adjustedSupply),
    `${totalPNKStaked} wei staked is not a share of the ${adjustedSupply} wei adjusted supply`
  );
  const expectedTarget = scheduledTarget(period);
  check(target.eq(expectedTarget), `The target is ${target}, but the schedule sets ${expectedTarget} for ${period}`);
  check(
    fullReward.gt(0) && fullReward.lte(lastamount.mul(ONE.add(target)).div(ONE)),
    `The reward of ${fullReward} wei is outside what the formula allows for a last drop of ${lastamount} wei`
  );
}

/**
 * Checks the stake the reward formula uses against the snapshots published for that period. The run
 * reads the stake history from the subgraph again, so if the subgraph serves different events from the
 * ones the period was dropped with, the stake would change the reward with no other sign. Only each
 * chain's total is compared, since that is all the formula takes. Read again from the subgraph on
 * 2026-10-07, every period from 2025-10 to 2026-09 matched to the wei.
 *
 * @param {Object} options
 * @param {string} options.period The period the stake was averaged over, as `YYYY-MM`.
 * @param {Array<{ chainId: number, averageTotalStaked: BigNumber }>} options.stakes Each chain's stake, as read now.
 * @param {Array<{ chainId: number, averageTotalStaked: BigNumber }>} options.published The period's published
 *   snapshots.
 */
export function assertStakesAsPublished({ period, stakes, published }) {
  for (const { chainId, averageTotalStaked } of stakes) {
    const snapshot = published.find((it) => Number(it.chainId) === Number(chainId));
    check(snapshot, `Chain ${chainId} has no published ${period} snapshot to check its stake against`);
    check(
      averageTotalStaked.eq(snapshot.averageTotalStaked),
      `Chain ${chainId}: the ${period} average stake reads ${averageTotalStaked} wei from the subgraph now, but ` +
        `its published snapshot records ${snapshot.averageTotalStaked} wei. Either the subgraph serves another ` +
        `stake history now (behind The Graph's gateway another indexer may answer, so run again), the snapshot ` +
        `was published from a wrong one, or KIP_86_EXCLUDED_ADDRESSES or the averaging has changed since that ` +
        `period was dropped. Find out which before going on`
    );
  }
}

/**
 * Checks that the chains' drops are their exact shares of the reward, and the shares add up to all of it.
 *
 * @param {Object} options
 * @param {BigNumber} options.fullReward The reward for the period, in wei.
 * @param {Array<{ chainId: number, pnkDropRatio: BigNumber, droppedAmount: BigNumber }>} options.drops
 */
export function assertDropSplit({ fullReward, drops }) {
  const totalRatio = drops.reduce((sum, { pnkDropRatio }) => sum.add(pnkDropRatio), BigNumber.from(0));
  check(totalRatio.eq(ONE), `The chains' drop ratios add up to ${totalRatio}, not ${ONE}`);
  for (const { chainId, pnkDropRatio, droppedAmount } of drops) {
    const share = fullReward.mul(pnkDropRatio).div(ONE);
    check(
      droppedAmount.eq(share),
      `Chain ${chainId} drops ${droppedAmount} wei, but its share of the reward is ${share}`
    );
  }
}

/**
 * Checks that `blockTag` is the last block before `date`: the period's chain state is read at it, so
 * the next block has to be the first at or after the period's end.
 */
export async function assertPinnedBlock({ provider, chainId, blockTag, date }) {
  const getBlock = (number) =>
    retry(async () => {
      const block = await provider.getBlock(number);
      if (!block) throw new Error(`Chain ${chainId} returned no block ${number}`);
      return block;
    });
  const [block, next] = await Promise.all([getBlock(blockTag), getBlock(blockTag + 1)]);
  const timestamp = Math.floor(date.getTime() / 1000);
  check(
    block.timestamp < timestamp && next.timestamp >= timestamp,
    `Chain ${chainId}: block ${blockTag} (timestamp ${block.timestamp}) is not the last one before ` +
      `${date.toISOString()} (${timestamp}), the next one has timestamp ${next.timestamp}`
  );
}

const MERKLE_REDEEM_ABI = [
  "function token() view returns (address)",
  "function weekMerkleRoots(uint256) view returns (bytes32)",
  "function verifyClaim(address, uint256, uint256, bytes32[]) view returns (bool)",
];

// MerkleRedeem's storage slot for weekMerkleRoots: Ownable's _owner takes slot 0 and token slot 1, as
// the storageLayout in contracts/deployments shows.
const WEEK_MERKLE_ROOTS_SLOT = 2;

// Multicall3, at the same address on every chain the drop is seeded on.
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL3_ABI = [
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)",
];

/**
 * Checks the week a chain's drop would be seeded as against the chain's MerkleRedeem: the contract
 * distributes the chain's token, the previous week is seeded, and this one either isn't yet or already
 * holds this exact root. The week number comes from the calendar, and the Court frontend reads a
 * snapshot's position in snapshots.json as its week, so a run that is a period off, or comes before the
 * previous drop was seeded, would otherwise only show once a juror's claim failed.
 *
 * @returns {Promise<"unseeded" | "seeded">} "seeded" when the week already holds this root, as when a
 *   seeded period is regenerated with --force.
 */
export async function assertSeedingWeek({ provider, chainId, merkleRedeem, token, week, root }) {
  const contract = new Contract(merkleRedeem, MERKLE_REDEEM_ABI, provider);
  const [distributed, previous, current] = await Promise.all([
    retry(() => contract.token()),
    retry(() => contract.weekMerkleRoots(week - 1)),
    retry(() => contract.weekMerkleRoots(week)),
  ]);
  check(
    distributed.toLowerCase() === token.toLowerCase(),
    `Chain ${chainId}: MerkleRedeem ${merkleRedeem} distributes ${distributed}, not ${token}`
  );
  check(
    previous !== constants.HashZero,
    `Chain ${chainId}: week ${week - 1} has no root in MerkleRedeem ${merkleRedeem}. Seed the previous period ` +
      `before this one, or the week number ${week} is wrong`
  );
  if (current === constants.HashZero) return "unseeded";
  check(
    current.toLowerCase() === root.toLowerCase(),
    `Chain ${chainId}: week ${week} is already seeded with root ${current}, but this run generated ${root}`
  );
  return "seeded";
}

/**
 * Runs every claim of a snapshot through the deployed MerkleRedeem's own verifyClaim, as if its week were
 * already seeded with the snapshot's root: an eth_call that overrides the week's storage slot with the
 * root, batched through Multicall3. It is the contract's own answer, before anything is seeded, to
 * whether each juror will be able to claim. Needs an RPC that supports eth_call state overrides, which
 * Alchemy does.
 */
export async function assertClaimableOnChain({ provider, chainId, merkleRedeem, week, snapshot, batchSize = 250 }) {
  check(
    typeof provider.send === "function",
    `Chain ${chainId}: simulating the claims needs a JSON-RPC provider, set the chain's RPC URL in .env`
  );
  const redeem = new utils.Interface(MERKLE_REDEEM_ABI);
  const multicall = new utils.Interface(MULTICALL3_ABI);
  const root = snapshot.merkleTree.root;
  const slot = utils.keccak256(utils.defaultAbiCoder.encode(["uint256", "uint256"], [week, WEEK_MERKLE_ROOTS_SLOT]));
  const stateOverride = { [merkleRedeem]: { stateDiff: { [slot]: root } } };

  const claims = Object.entries(snapshot.merkleTree.claims);
  let accepted = 0;
  for (let start = 0; start < claims.length; start += batchSize) {
    const batch = claims.slice(start, start + batchSize);
    const data = multicall.encodeFunctionData("aggregate3", [
      batch.map(([address, claim]) => ({
        target: merkleRedeem,
        allowFailure: true,
        callData: redeem.encodeFunctionData("verifyClaim", [address, week, BigNumber.from(claim.value), claim.proof]),
      })),
    ]);
    const [results] = multicall.decodeFunctionResult(
      "aggregate3",
      await retry(() => provider.send("eth_call", [{ to: MULTICALL3, data }, "latest", stateOverride]))
    );
    check(
      results.length === batch.length,
      `Chain ${chainId}: Multicall3 answered ${results.length} of ${batch.length}`
    );
    batch.forEach(([address], i) => {
      const { success, returnData } = results[i];
      check(
        success && redeem.decodeFunctionResult("verifyClaim", returnData)[0],
        `Chain ${chainId}: MerkleRedeem ${merkleRedeem} rejects ${address}'s claim for week ${week} against root ${root}`
      );
      accepted += 1;
    });
  }
  // every claim, not just the ones the loop reached
  check(accepted === claims.length, `Chain ${chainId}: only ${accepted} of ${claims.length} claims were simulated`);
  return accepted;
}
