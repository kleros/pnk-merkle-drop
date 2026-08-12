import { BigNumber, Contract } from "ethers";
import { getAmountsForLiquidity } from "./uniswap-math.js";
import { fetchJson } from "./fetch-json.js";
import { retry } from "./retry.js";

const CTF_ABI = [
  "function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint indexSet) view returns (bytes32)",
  "function getPositionId(address collateralToken, bytes32 collectionId) pure returns (uint256)",
];

const ALGEBRA_PM_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function factory() view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
];

const ALGEBRA_FACTORY_ABI = ["function poolByPair(address, address) view returns (address)"];
const ALGEBRA_POOL_ABI = [
  "function globalState() view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint8 communityFeeToken0, uint8 communityFeeToken1, bool unlocked)",
];

// Event topic0 hashes
const CONDITION_PREPARATION_TOPIC = "0xab3760c3bd2bb38b5bcf54dc79802ed67338b4cf29f3054ded67ed24661e4177";
const WRAPPED1155_CREATION_TOPIC = "0x5cf3a4006b0dcb221517555192a3e5df5e19783c22ea769c1ef46dd421ae2d32";
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Dynamically discover and calculate PNK the Cooperative controls via Futarchy conditional tokens.
 * 1. Discovers YES_PNK / NO_PNK tokens via Blockscout API
 * 2. Extracts positionIds + conditionIds from creation tx logs
 * 3. Pairs YES/NO correctly by matching positionIds to conditionIds via on-chain CTF calls
 * 4. Adds Algebra LP amounts
 * Redeemable PNK per market = min(total_YES_PNK, total_NO_PNK).
 */
export async function getCoopFutarchyPnk({
  provider,
  blockscoutApi,
  ctfAddress,
  pnkAddress,
  algebraPM,
  excludedAddresses,
}) {
  const ctf = new Contract(ctfAddress, CTF_ABI, provider);

  // ── Step 1: Discover YES_PNK / NO_PNK tokens via Blockscout ──
  const balanceByToken = new Map(); // tokenAddr -> { symbol, total, holders }

  await Promise.all(
    excludedAddresses.map(async (addr) => {
      let params = new URLSearchParams({ type: "ERC-20" });
      let hasMore = true;
      while (hasMore) {
        const data = await fetchJson(`${blockscoutApi}/api/v2/addresses/${addr}/tokens?${params}`);
        for (const item of data.items || data) {
          const symbol = item.token?.symbol || "";
          if (symbol !== "YES_PNK" && symbol !== "NO_PNK") continue;
          const tokenAddr = (item.token?.address || item.token?.address_hash || "").toLowerCase();
          const balance = BigNumber.from(item.value || "0");
          if (balance.isZero()) continue;
          if (!balanceByToken.has(tokenAddr)) {
            balanceByToken.set(tokenAddr, { symbol, total: BigNumber.from(0), holders: new Set() });
          }
          const entry = balanceByToken.get(tokenAddr);
          entry.total = entry.total.add(balance);
          entry.holders.add(addr);
        }
        if (!data.next_page_params) {
          hasMore = false;
        } else {
          params = new URLSearchParams({ type: "ERC-20", ...data.next_page_params });
        }
      }
    })
  );

  if (balanceByToken.size === 0) return { balance: BigNumber.from(0), details: [] };

  // ── Step 2: Get creation tx logs → extract positionIds and conditionIds ──
  const tokenPositionIds = new Map(); // wrappedAddr -> positionId (BigNumber)
  const allConditionIds = new Set();

  await Promise.all(
    [...balanceByToken.keys()].map(async (tokenAddr) => {
      // Get creation tx hash from Blockscout (no RPC equivalent)
      const addrData = await fetchJson(`${blockscoutApi}/api/v2/addresses/${tokenAddr}`);
      const txHash = addrData.creation_tx_hash || addrData.creation_transaction_hash;
      if (!txHash) return;

      // Get tx receipt from RPC (faster than Blockscout /transactions/{hash}/logs)
      const receipt = await retry(() => provider.getTransactionReceipt(txHash));
      if (!receipt) return;

      for (const log of receipt.logs) {
        const logAddr = log.address.toLowerCase();
        const topics = log.topics || [];

        // ConditionPreparation → conditionId
        if (logAddr === ctfAddress.toLowerCase() && topics[0] === CONDITION_PREPARATION_TOPIC && topics[1]) {
          allConditionIds.add(topics[1]);
        }

        // Wrapped1155Creation → positionId for our token
        if (topics[0] === WRAPPED1155_CREATION_TOPIC && topics[3]) {
          const wrappedAddr = ("0x" + topics[3].slice(26)).toLowerCase();
          if (wrappedAddr === tokenAddr) {
            tokenPositionIds.set(tokenAddr, BigNumber.from(topics[2]));
          }
        }
      }
    })
  );

  // ── Step 3: For each conditionId, compute YES/NO positionIds and match to tokens ──
  const paired = new Set();
  const markets = [];

  for (const conditionId of allConditionIds) {
    const [collId1, collId2] = await Promise.all([
      retry(() => ctf.getCollectionId(ZERO_BYTES32, conditionId, 1)),
      retry(() => ctf.getCollectionId(ZERO_BYTES32, conditionId, 2)),
    ]);
    const [posId1, posId2] = await Promise.all([
      retry(() => ctf.getPositionId(pnkAddress, collId1)),
      retry(() => ctf.getPositionId(pnkAddress, collId2)),
    ]);

    // Find which discovered tokens match these positionIds
    let yesAddr = null;
    let noAddr = null;
    for (const [tokenAddr, positionId] of tokenPositionIds) {
      if (paired.has(tokenAddr)) continue;
      if (positionId.eq(posId1) || positionId.eq(posId2)) {
        const { symbol } = balanceByToken.get(tokenAddr);
        if (symbol === "YES_PNK" && !yesAddr) yesAddr = tokenAddr;
        if (symbol === "NO_PNK" && !noAddr) noAddr = tokenAddr;
      }
    }

    if (yesAddr && noAddr) {
      paired.add(yesAddr);
      paired.add(noAddr);
      markets.push({ conditionId, yes: yesAddr, no: noAddr });
    }
  }

  // ── Step 4: Add Algebra LP amounts ──
  const targetTokens = new Set(balanceByToken.keys());
  if (algebraPM) {
    const lpAmounts = await getAlgebraLpAmounts({
      provider,
      blockscoutApi,
      algebraPM,
      excludedAddresses,
      targetTokens,
    });
    for (const { wrappedAddr, amount } of lpAmounts) {
      if (!balanceByToken.has(wrappedAddr)) {
        balanceByToken.set(wrappedAddr, { symbol: "UNKNOWN", total: BigNumber.from(0), holders: new Set() });
      }
      balanceByToken.get(wrappedAddr).total = balanceByToken.get(wrappedAddr).total.add(amount);
    }
  }

  // ── Step 5: Compute redeemable per market ──
  let totalRedeemable = BigNumber.from(0);
  const details = [];

  for (let i = 0; i < markets.length; i++) {
    const { yes, no } = markets[i];
    const yesTotal = balanceByToken.get(yes)?.total || BigNumber.from(0);
    const noTotal = balanceByToken.get(no)?.total || BigNumber.from(0);
    const redeemable = yesTotal.lt(noTotal) ? yesTotal : noTotal;
    if (!redeemable.isZero()) {
      const holders = [
        ...new Set([...(balanceByToken.get(yes)?.holders || []), ...(balanceByToken.get(no)?.holders || [])]),
      ];
      totalRedeemable = totalRedeemable.add(redeemable);
      details.push({ market: i + 1, yes, no, holders, redeemable });
    }
  }

  // Collect unpaired tokens for caller to log
  const warnings = [];
  for (const [tokenAddr, { symbol, total }] of balanceByToken) {
    if (!paired.has(tokenAddr) && !total.isZero()) {
      warnings.push(`${symbol} ${tokenAddr} — single-sided, cannot merge`);
    }
  }

  return { balance: totalRedeemable, details, warnings };
}

/**
 * Decompose Algebra LP positions to find amounts of target wrapped conditional tokens.
 */
async function getAlgebraLpAmounts({ provider, blockscoutApi, algebraPM, excludedAddresses, targetTokens }) {
  const pm = new Contract(algebraPM, ALGEBRA_PM_ABI, provider);

  // Discover Algebra NFT token IDs via Blockscout
  const tokenIdsByAddress = {};
  for (const addr of excludedAddresses) {
    const data = await fetchJson(`${blockscoutApi}/api/v2/addresses/${addr}/nft/collections`);
    for (const collection of data.items || data) {
      const collAddr = (collection.token?.address || collection.token?.address_hash || "").toLowerCase();
      if (collAddr !== algebraPM.toLowerCase()) continue;
      const ids = (collection.token_instances || []).map((inst) => BigNumber.from(inst.id));
      if (ids.length > 0) tokenIdsByAddress[addr] = ids;
    }
  }

  if (Object.keys(tokenIdsByAddress).length === 0) return [];

  // Get position data
  const allPositions = [];
  await Promise.all(
    Object.entries(tokenIdsByAddress).flatMap(([addr, tokenIds]) =>
      tokenIds.map((tokenId) =>
        retry(() => pm.positions(tokenId)).then((pos) => allPositions.push({ addr, tokenId, ...pos }))
      )
    )
  );

  // Filter to active positions involving target tokens
  const relevant = allPositions.filter(
    (pos) =>
      !pos.liquidity.isZero() &&
      (targetTokens.has(pos.token0.toLowerCase()) || targetTokens.has(pos.token1.toLowerCase()))
  );

  if (relevant.length === 0) return [];

  // Get pool prices
  const factoryAddr = await retry(() => pm.factory());
  const factory = new Contract(factoryAddr, ALGEBRA_FACTORY_ABI, provider);
  const poolCache = {};
  const poolKey = (pos) => `${pos.token0}-${pos.token1}`.toLowerCase();
  const uniquePoolKeys = [...new Set(relevant.map(poolKey))];

  await Promise.all(
    uniquePoolKeys.map(async (key) => {
      const pos = relevant.find((p) => poolKey(p) === key);
      const poolAddr = await retry(() => factory.poolByPair(pos.token0, pos.token1));
      const pool = new Contract(poolAddr, ALGEBRA_POOL_ABI, provider);
      poolCache[key] = await retry(() => pool.globalState());
    })
  );

  // Calculate amounts
  const results = [];
  for (const pos of relevant) {
    const state = poolCache[poolKey(pos)];
    const sqrtPriceX96 = BigInt(state.price.toString());
    const liquidity = BigInt(pos.liquidity.toString());
    const { amount0, amount1 } = getAmountsForLiquidity(sqrtPriceX96, pos.tickLower, pos.tickUpper, liquidity);

    const t0 = pos.token0.toLowerCase();
    const t1 = pos.token1.toLowerCase();
    if (targetTokens.has(t0)) results.push({ wrappedAddr: t0, amount: BigNumber.from(amount0.toString()) });
    if (targetTokens.has(t1)) results.push({ wrappedAddr: t1, amount: BigNumber.from(amount1.toString()) });
  }

  return results;
}
