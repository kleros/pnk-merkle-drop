import { BigNumber, Contract } from "ethers";
import { defaultAbiCoder, keccak256 } from "ethers/lib/utils.js";
import { getAmountsForLiquidity, buildPnkResult } from "./uniswap-math.js";
import { retry } from "./retry.js";

// V4-specific: Decode packed PositionInfo uint256 → { tickLower, tickUpper }
// Layout (LSB→MSB): [hasSubscriber: 8 bits][tickLower: 24 bits][tickUpper: 24 bits][poolId: 200 bits]
// Source: https://github.com/Uniswap/v4-periphery/blob/main/src/libraries/PositionInfoLibrary.sol
function decodePositionInfo(info) {
  const n = BigInt(info.toString());
  const tickLower = Number(BigInt.asIntN(24, (n >> 8n) & 0xffffffn));
  const tickUpper = Number(BigInt.asIntN(24, (n >> 32n) & 0xffffffn));
  return { tickLower, tickUpper };
}

// Compute PoolId = keccak256(abi.encode(PoolKey))
function computePoolId(poolKey) {
  return keccak256(
    defaultAbiCoder.encode(
      ["address", "address", "uint24", "int24", "address"],
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
    )
  );
}

const V4_PM_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function getPoolAndPositionInfo(uint256 tokenId) view returns (tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)",
  "function getPositionLiquidity(uint256 tokenId) view returns (uint128)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

const STATEVIEW_ABI = [
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
];

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

/**
 * Calculate exact PNK held by excluded addresses in Uniswap V4 positions.
 * Enumerates position NFTs via Transfer events (V4 PM is not ERC721Enumerable),
 * reads tick ranges & liquidity, and computes precise token amounts.
 *
 * @param {string} poolManager The chain's PoolManager, which holds the tokens of every V4 pool.
 * @param {number} blockTag The block the positions are read at.
 * @returns {{ balance: BigNumber, details: Array<{ address: string, pnk: BigNumber }> }}
 */
export async function getCoopV4Pnk({
  provider,
  positionManager,
  stateView,
  poolManager,
  pnkAddress,
  excludedAddresses,
  blockTag,
}) {
  const v4Pm = new Contract(positionManager, V4_PM_ABI, provider);
  const sv = new Contract(stateView, STATEVIEW_ABI, provider);

  // 1. Get NFT counts per excluded address
  const nftCounts = await Promise.all(excludedAddresses.map((addr) => retry(() => v4Pm.balanceOf(addr, { blockTag }))));

  // 2. Discover token IDs via Transfer events (PM is not ERC721Enumerable)
  // The event scan stops at `blockTag` too: a transfer after the period would otherwise change
  // which NFTs are counted, and disagree with the balanceOf cross-check below.
  const addressesWithNfts = excludedAddresses.filter((_, i) => !nftCounts[i].isZero());
  const tokenIdsByAddress = {};

  await Promise.all(
    addressesWithNfts.map(async (addr) => {
      const [inEvents, outEvents] = await Promise.all([
        retry(() => v4Pm.queryFilter(v4Pm.filters.Transfer(null, addr), 0, blockTag)),
        retry(() => v4Pm.queryFilter(v4Pm.filters.Transfer(addr, null), 0, blockTag)),
      ]);
      // Replay the address's transfers in chain order: a position that left and came back, or that was
      // sent to the address itself, shows up both in and out, and is held only if it came in last.
      const transfers = new Map([...inEvents, ...outEvents].map((e) => [`${e.blockNumber}:${e.logIndex}`, e]));
      const held = new Map();
      for (const e of [...transfers.values()].sort(
        (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex
      )) {
        if (e.args.from.toLowerCase() === addr.toLowerCase()) held.delete(e.args.tokenId.toString());
        if (e.args.to.toLowerCase() === addr.toLowerCase()) held.set(e.args.tokenId.toString(), e.args.tokenId);
      }
      // A position the events don't account for would be left out of the exclusion, so they must add up
      // to what the PositionManager says the address holds.
      const expected = nftCounts[excludedAddresses.indexOf(addr)].toNumber();
      if (held.size !== expected) {
        throw new Error(
          `V4 NFT mismatch for ${addr}: its Transfer events up to block ${blockTag} leave it ${held.size} ` +
            `positions, but balanceOf is ${expected}`
        );
      }
      tokenIdsByAddress[addr] = [...held.values()];
    })
  );

  // 3. Get position info + liquidity for all discovered tokens
  const allPositions = [];
  const positionQueries = [];
  for (const [addr, tokenIds] of Object.entries(tokenIdsByAddress)) {
    for (const tokenId of tokenIds) {
      positionQueries.push(
        Promise.all([
          retry(() => v4Pm.getPoolAndPositionInfo(tokenId, { blockTag })),
          retry(() => v4Pm.getPositionLiquidity(tokenId, { blockTag })),
        ]).then(([poolAndInfo, liquidity]) => {
          allPositions.push({
            address: addr,
            tokenId,
            poolKey: poolAndInfo.poolKey,
            info: poolAndInfo.info,
            liquidity,
          });
        })
      );
    }
  }
  await Promise.all(positionQueries);

  // 4. Filter to PNK pools only and get sqrtPriceX96 for each unique pool
  const pnkAddr = pnkAddress.toLowerCase();
  const pnkPositions = allPositions.filter((pos) => {
    const c0 = pos.poolKey.currency0.toLowerCase();
    const c1 = pos.poolKey.currency1.toLowerCase();
    return c0 === pnkAddr || c1 === pnkAddr;
  });

  const poolStates = {};
  const uniquePoolIds = new Set();
  for (const pos of pnkPositions) {
    const poolId = computePoolId(pos.poolKey);
    pos.poolId = poolId;
    uniquePoolIds.add(poolId);
  }

  await Promise.all(
    [...uniquePoolIds].map(async (poolId) => {
      poolStates[poolId] = await retry(() => sv.getSlot0(poolId, { blockTag }));
    })
  );

  // 5. Calculate exact PNK amounts per position
  const pnkByAddress = {};
  for (const pos of pnkPositions) {
    if (pos.liquidity.isZero()) continue;

    const { tickLower, tickUpper } = decodePositionInfo(pos.info);
    const sqrtPriceX96 = BigInt(poolStates[pos.poolId].sqrtPriceX96.toString());
    const liquidity = BigInt(pos.liquidity.toString());
    const { amount0, amount1 } = getAmountsForLiquidity(sqrtPriceX96, tickLower, tickUpper, liquidity);

    const isPnkToken0 = pos.poolKey.currency0.toLowerCase() === pnkAddr;
    const pnkAmount = BigNumber.from((isPnkToken0 ? amount0 : amount1).toString());

    if (!pnkByAddress[pos.address]) pnkByAddress[pos.address] = BigNumber.from(0);
    pnkByAddress[pos.address] = pnkByAddress[pos.address].add(pnkAmount);
  }

  const result = buildPnkResult(pnkByAddress);

  // Every V4 pool's tokens sit in the PoolManager, so no set of positions can hold more PNK than it does.
  const pnkToken = new Contract(pnkAddress, ERC20_ABI, provider);
  const poolManagerPnk = await retry(() => pnkToken.balanceOf(poolManager, { blockTag }));
  if (result.balance.gt(poolManagerPnk)) {
    throw new Error(
      `The Cooperative's V4 positions add up to ${result.balance} wei of PNK, more than the ${poolManagerPnk} wei ` +
        `the PoolManager ${poolManager} holds at block ${blockTag}`
    );
  }
  return result;
}
