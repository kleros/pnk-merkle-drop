import { BigNumber, Contract } from "ethers";

const SABLIER_ABI = [
  "function getSender(uint256) view returns (address)",
  "function getAsset(uint256) view returns (address)",
  "function refundableAmountOf(uint256) view returns (uint128)",
  "function nextStreamId() view returns (uint256)",
];

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

/**
 * Dynamically discover and calculate PNK the Cooperative can recover from Sablier vesting streams.
 * Scans ALL streams on each configured Sablier contract, filtering to coop senders.
 * Returns the refundable (unvested + cancelable) portion only — vested PNK belongs to the recipient.
 * No hardcoded stream IDs needed — new streams are discovered automatically.
 *
 * Note: getAsset() returns empty on Sablier V4, so we fall back to sender-only check
 * (safe because we only configure contracts verified to hold PNK).
 */
export async function getCoopSablierPnk({ provider, sablierContracts, pnkAddress, excludedAddresses }) {
  const excludedSet = new Set(excludedAddresses.map((a) => a.toLowerCase()));
  const pnkAddr = pnkAddress.toLowerCase();

  let balance = BigNumber.from(0);
  const details = [];

  for (const contractAddr of sablierContracts) {
    // Skip contracts that don't hold PNK at all (avoids scanning thousands of irrelevant streams)
    const pnkToken = new Contract(pnkAddress, ERC20_ABI, provider);
    const contractPnkBalance = await pnkToken.balanceOf(contractAddr).catch(() => BigNumber.from(0));
    if (contractPnkBalance.isZero()) continue;

    const sablier = new Contract(contractAddr, SABLIER_ABI, provider);

    let nextId;
    try {
      nextId = (await sablier.nextStreamId()).toNumber();
    } catch {
      continue;
    }

    // Scan all streams in batches, checking sender
    const batchSize = 50;
    for (let start = 1; start < nextId; start += batchSize) {
      const end = Math.min(start + batchSize - 1, nextId - 1);
      const checks = [];

      for (let id = start; id <= end; id++) {
        checks.push(
          sablier
            .getSender(id)
            .then((sender) => ({ id, sender: sender.toLowerCase() }))
            .catch(() => null)
        );
      }

      const results = await Promise.all(checks);

      for (const r of results) {
        if (!r || !excludedSet.has(r.sender)) continue;

        // Verify asset is PNK if getAsset works (V2); on V4 getAsset returns empty,
        // but we already verified above that this contract holds PNK.
        try {
          const asset = await sablier.getAsset(r.id);
          if (asset.toLowerCase() !== pnkAddr) continue;
        } catch {
          // V4: getAsset not available — safe because we verified contract holds PNK above
        }

        try {
          const refundable = await sablier.refundableAmountOf(r.id);
          const pnk = BigNumber.from(refundable);
          if (!pnk.isZero()) {
            balance = balance.add(pnk);
            details.push({ streamId: r.id, sender: r.sender, pnk });
          }
        } catch {
          // Stream might be in a state where refundableAmountOf fails
        }
      }
    }
  }

  return { balance, details };
}
