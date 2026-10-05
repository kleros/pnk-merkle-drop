import { BigNumber, Contract } from "ethers";
import { retry } from "./retry.js";

const SABLIER_ABI = [
  "function getSender(uint256) view returns (address)",
  "function getAsset(uint256) view returns (address)",
  "function getUnderlyingToken(uint256) view returns (address)",
  "function refundableAmountOf(uint256) view returns (uint128)",
  "function nextStreamId() view returns (uint256)",
  "function getLockupModel(uint256) view returns (uint8)",
];

// Lockup.Model's last value, which only Lockup v4.0 has: a stream that unlocks once an oracle reports a target price.
const LOCKUP_PRICE_GATED = 3;

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

// Multicall3, deployed at this address on every chain the streams are read on.
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL3_ABI = [
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)",
];

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
  const multicall = new Contract(MULTICALL3, MULTICALL3_ABI, provider);
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
      // so a retry only happens when the RPC fails. If neither ever answers, the run fails, naming both errors.
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

      // Non-cancelable, canceled and depleted streams report 0 rather than revert. The one stream that can revert
      // here by design is a v4.0 price-gated one whose oracle, picked by whoever created it, returns malformed
      // data (an oracle that reverts is caught by Sablier and read as a price of 0). `cancel` runs into the same
      // revert, so its sender can't claw anything back at that block, and the stream counts as 0. Failing the run
      // on it would fail every re-run too, as the block is in the past, and anyone can name the Cooperative as a
      // stream's sender, so anyone could block the drop.
      //
      // To tell that revert apart from an RPC failure, the read goes through Multicall3, which reports a revert of
      // the call as `success: false` in an otherwise successful response. Neither the stream's model, which only
      // says that the stream can revert, nor the error tells the two apart: ethers versions label errors
      // differently, and 5.7+ reports even an RPC outage on a call as CALL_EXCEPTION. An RPC failure therefore
      // fails the run once the retries run out, as does any other revert, since swallowing it would drop the
      // stream from the exclusion.
      const [{ success, returnData }] = await retry(() =>
        multicall.callStatic.aggregate3(
          [
            {
              target: contractAddr,
              allowFailure: true,
              callData: sablier.interface.encodeFunctionData("refundableAmountOf", [r.id]),
            },
          ],
          { blockTag }
        )
      );
      if (!success) {
        // Before v2.0 there is no getLockupModel, and an RPC outage fails it too: either way the run fails.
        const model = await retry(() => sablier.getLockupModel(r.id, { blockTag })).catch(() => null);
        if (model !== LOCKUP_PRICE_GATED) {
          throw new Error(
            `Sablier stream ${r.id} on ${contractAddr} reverts on refundableAmountOf at block ${blockTag} ` +
              `with data ${returnData}`
          );
        }
        console.warn(
          `        ⚠ Sablier stream #${r.id} on ${contractAddr} is price-gated and reverts at block ${blockTag}, ` +
            `so its sender couldn't cancel it: not excluded`
        );
        continue;
      }
      const [pnk] = sablier.interface.decodeFunctionResult("refundableAmountOf", returnData);
      if (!pnk.isZero()) {
        found.push({ streamId: r.id, sender: r.sender, pnk });
      }
    }
  }

  return found;
}
