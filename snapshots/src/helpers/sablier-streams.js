import { BigNumber, Contract } from "ethers";
import { retry } from "./retry.js";

const SABLIER_ABI = [
  "function getSender(uint256) view returns (address)",
  "function getAsset(uint256) view returns (address)",
  "function getUnderlyingToken(uint256) view returns (address)",
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
 * Note: Lockup v1.x names a stream's token `getAsset()`, while v2.0+ renamed it `getUnderlyingToken()`,
 * so each contract reverts on the getter it doesn't have. Every coop stream's token is still checked:
 * holding PNK doesn't make a contract PNK-only (the Arbitrum ones also stream USDC and DAI), so a stream
 * whose token can't be read fails the run instead of being counted as PNK.
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

      // Whichever getter this contract's version lacks reverts straight away and the other one answers,
      // so a retry only happens when the RPC fails. If neither ever answers, the run fails, naming both
      // errors so that an RPC outage isn't mistaken for the missing getter's revert.
      const token = await retry(() =>
        sablier.getAsset(r.id, { blockTag }).catch((assetError) =>
          sablier.getUnderlyingToken(r.id, { blockTag }).catch((tokenError) => {
            throw new Error(
              `Could not read the token of stream ${r.id} on ${contractAddr} — getAsset: ` +
                `${assetError.code ?? assetError.message}, getUnderlyingToken: ${tokenError.code ?? tokenError.message}`
            );
          })
        )
      );
      if (token.toLowerCase() !== pnkAddr) continue;

      // Non-cancelable, canceled and depleted streams report 0 rather than revert. A revert is the contract's
      // answer at that block, e.g. a v4.0 price-gated stream whose oracle, picked by whoever created it, has
      // stopped answering: retrying can't change it, and its sender can't cancel it either. Anyone can name
      // the Cooperative as a stream's sender, so failing the run here would let anyone block the drop; such
      // a stream is reported and skipped instead. Any other error is the RPC's, and once the retries run out
      // it fails the run, since swallowing it would silently drop the stream from the exclusion.
      const pnk = await retry(() =>
        sablier.refundableAmountOf(r.id, { blockTag }).catch((error) => {
          if (error.code === "CALL_EXCEPTION" || error.code === "UNPREDICTABLE_GAS_LIMIT") return null;
          throw error;
        })
      );
      if (pnk === null) {
        console.warn(
          `        ⚠ Sablier stream #${r.id} on ${contractAddr} reverts on refundableAmountOf, not excluded`
        );
        continue;
      }
      if (!pnk.isZero()) {
        found.push({ streamId: r.id, sender: r.sender, pnk });
      }
    }
  }

  return found;
}
