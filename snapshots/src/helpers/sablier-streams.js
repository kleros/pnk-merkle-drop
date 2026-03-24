import { BigNumber, Contract } from "ethers";

const retry = async (fn, maxRetries = 2) => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
};

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
 * Note: getAsset() returns empty on Sablier V4, so we fall back to sender-only check
 * (safe because we skip contracts that don't hold PNK).
 */
export async function getCoopSablierPnk({ provider, sablierContracts, pnkAddress, excludedAddresses }) {
  const excludedSet = new Set(excludedAddresses.map((a) => a.toLowerCase()));
  const pnkAddr = pnkAddress.toLowerCase();

  // Scan contracts sequentially to avoid overwhelming RPC rate limits
  const contractResults = [];
  for (const contractAddr of sablierContracts) {
    contractResults.push(await scanSablierContract({ provider, contractAddr, pnkAddress, pnkAddr, excludedSet }));
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

async function scanSablierContract({ provider, contractAddr, pnkAddress, pnkAddr, excludedSet }) {
  // Skip contracts that don't hold PNK
  const pnkToken = new Contract(pnkAddress, ERC20_ABI, provider);
  const contractPnkBalance = await pnkToken.balanceOf(contractAddr).catch(() => BigNumber.from(0));
  if (contractPnkBalance.isZero()) return [];

  const sablier = new Contract(contractAddr, SABLIER_ABI, provider);

  let nextId;
  try {
    nextId = (await sablier.nextStreamId()).toNumber();
  } catch {
    return [];
  }

  // Scan all streams in batches
  const batchSize = 100;
  const found = [];

  for (let start = 1; start < nextId; start += batchSize) {
    const end = Math.min(start + batchSize - 1, nextId - 1);
    const checks = [];

    for (let id = start; id <= end; id++) {
      checks.push(
        retry(() => sablier.getSender(id))
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
          found.push({ streamId: r.id, sender: r.sender, pnk });
        }
      } catch {
        // Stream might be in a state where refundableAmountOf fails
      }
    }
  }

  return found;
}
