import { BigNumber, Contract } from "ethers";
import { retry } from "./retry.js";

const SABLIER_ABI = [
  "function getSender(uint256) view returns (address)",
  "function getAsset(uint256) view returns (address)",
  "function refundableAmountOf(uint256) view returns (uint128)",
  "function nextStreamId() view returns (uint256)",
];

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

/**
 * Dynamically discover and calculate PNK the Cooperative can recover from Sablier vesting streams.
 * Scans ALL streams on each configured Sablier contract in parallel, filtering to coop senders.
 * Returns the refundable (unvested + cancelable) portion only — vested PNK belongs to the recipient.
 * No hardcoded stream IDs needed — new streams are discovered automatically.
 *
 * Note: getAsset() was removed in Sablier V4 (renamed to getUnderlyingToken), so calling it
 * reverts. We catch the revert and fall back to sender-only check
 * (safe because we skip contracts that don't hold PNK).
 *
 * `refundableAmountOf` is a function of `block.timestamp` — it shrinks every second as the stream
 * vests — so reading it at the head would make the same period yield a different number on every
 * run. Everything here is therefore read at `blockTag`.
 *
 * @param {number} blockTag The block the streams are read at.
 */
export async function getCoopSablierPnk({ provider, sablierContracts, pnkAddress, excludedAddresses, blockTag }) {
  const excludedSet = new Set(excludedAddresses.map((a) => a.toLowerCase()));
  const pnkAddr = pnkAddress.toLowerCase();

  // Scan contracts sequentially to avoid overwhelming RPC rate limits
  const contractResults = [];
  for (const contractAddr of sablierContracts) {
    contractResults.push(
      await scanSablierContract({ provider, contractAddr, pnkAddress, pnkAddr, excludedSet, blockTag })
    );
  }

  let balance = BigNumber.from(0);
  const details = [];
  for (const result of contractResults) {
    for (const d of result) {
      balance = balance.add(d.pnk);
      details.push(d);
    }
  }

  return { balance, details };
}

async function scanSablierContract({ provider, contractAddr, pnkAddress, pnkAddr, excludedSet, blockTag }) {
  // Skip contracts that don't hold PNK
  const pnkToken = new Contract(pnkAddress, ERC20_ABI, provider);
  const contractPnkBalance = await retry(() => pnkToken.balanceOf(contractAddr, { blockTag }));
  if (contractPnkBalance.isZero()) return [];

  const sablier = new Contract(contractAddr, SABLIER_ABI, provider);
  // Reading this at `blockTag` also keeps streams created after the period out of the scan.
  const nextId = (await retry(() => sablier.nextStreamId({ blockTag }))).toNumber();

  // Scan all streams in batches
  const batchSize = 100;
  const found = [];

  for (let start = 1; start < nextId; start += batchSize) {
    const end = Math.min(start + batchSize - 1, nextId - 1);
    const checks = [];

    for (let id = start; id <= end; id++) {
      checks.push(
        retry(() => sablier.getSender(id, { blockTag }), 2).then((sender) => ({ id, sender: sender.toLowerCase() }))
      );
    }

    const results = await Promise.all(checks);

    for (const r of results) {
      if (!excludedSet.has(r.sender)) continue;

      // Verify asset is PNK if getAsset works (V2); on V4 getAsset reverts
      // (function was renamed to getUnderlyingToken), so we fall back to sender-only check.
      // No retry here: getSender just succeeded so RPC is healthy, and retrying would waste
      // ~7s per stream on V4 contracts where getAsset always reverts.
      try {
        const asset = await sablier.getAsset(r.id, { blockTag });
        if (asset.toLowerCase() !== pnkAddr) continue;
      } catch {
        // V4: getAsset reverts — safe because we verified contract holds PNK above
      }

      try {
        const refundable = await retry(() => sablier.refundableAmountOf(r.id, { blockTag }));
        const pnk = BigNumber.from(refundable);
        if (!pnk.isZero()) {
          found.push({ streamId: r.id, sender: r.sender, pnk });
        }
      } catch {
        // Non-cancelable streams revert on refundableAmountOf — refundable amount is 0 by definition
      }
    }
  }

  return found;
}
