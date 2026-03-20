import { BigNumber, Contract } from "ethers";
import { getAmountsForLiquidity } from "./uniswap-math.js";

const V3_PM_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
];

const V3_FACTORY_ABI = ["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"];

const V3_POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
];

// V3 Factory is the same address on ETH and Arbitrum (CREATE2)
const V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";

/**
 * Calculate exact PNK held by excluded addresses in Uniswap V3 positions.
 * V3 PM is ERC721Enumerable, so we can use tokenOfOwnerByIndex directly.
 *
 * @returns {{ balance: BigNumber, details: Array<{ address: string, pnk: BigNumber }> }}
 */
export async function getCoopV3Pnk({ provider, positionManager, pnkAddress, excludedAddresses }) {
  const v3Pm = new Contract(positionManager, V3_PM_ABI, provider);
  const factory = new Contract(V3_FACTORY, V3_FACTORY_ABI, provider);

  // 1. Get NFT counts per excluded address
  const nftCounts = await Promise.all(excludedAddresses.map((addr) => v3Pm.balanceOf(addr)));

  // 2. Enumerate token IDs via tokenOfOwnerByIndex (V3 PM is ERC721Enumerable)
  const tokenIdQueries = [];
  for (let i = 0; i < excludedAddresses.length; i++) {
    const count = nftCounts[i].toNumber();
    for (let j = 0; j < count; j++) {
      tokenIdQueries.push(
        v3Pm.tokenOfOwnerByIndex(excludedAddresses[i], j).then((tokenId) => ({
          address: excludedAddresses[i],
          tokenId,
        }))
      );
    }
  }
  const tokenIdResults = await Promise.all(tokenIdQueries);

  if (tokenIdResults.length === 0) return { balance: BigNumber.from(0), details: [] };

  // 3. Get position data for all tokens
  const positionData = await Promise.all(
    tokenIdResults.map(async ({ address, tokenId }) => {
      const pos = await v3Pm.positions(tokenId);
      return { address, tokenId, ...pos };
    })
  );

  // 4. Filter to PNK positions only
  const pnkAddr = pnkAddress.toLowerCase();
  const pnkPositions = positionData.filter(
    (pos) => pos.token0.toLowerCase() === pnkAddr || pos.token1.toLowerCase() === pnkAddr
  );

  // Skip positions with zero liquidity (withdrawn but NFT not burned)
  const activePositions = pnkPositions.filter((pos) => !pos.liquidity.isZero());

  if (activePositions.length === 0) return { balance: BigNumber.from(0), details: [] };

  // 5. Get sqrtPriceX96 for each unique pool
  const poolCache = {};
  const poolKey = (pos) => `${pos.token0}-${pos.token1}-${pos.fee}`;

  await Promise.all(
    activePositions
      .filter((pos) => !poolCache[poolKey(pos)])
      .map(async (pos) => {
        const key = poolKey(pos);
        if (poolCache[key]) return;
        const poolAddr = await factory.getPool(pos.token0, pos.token1, pos.fee);
        const pool = new Contract(poolAddr, V3_POOL_ABI, provider);
        const slot0 = await pool.slot0();
        poolCache[key] = slot0;
      })
  );

  // 6. Calculate exact PNK amounts per position
  const pnkByAddress = {};
  for (const pos of activePositions) {
    const slot0 = poolCache[poolKey(pos)];
    const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96.toString());
    const liquidity = BigInt(pos.liquidity.toString());
    const { amount0, amount1 } = getAmountsForLiquidity(sqrtPriceX96, pos.tickLower, pos.tickUpper, liquidity);

    const isPnkToken0 = pos.token0.toLowerCase() === pnkAddr;
    const pnkAmount = BigNumber.from((isPnkToken0 ? amount0 : amount1).toString());

    if (!pnkByAddress[pos.address]) pnkByAddress[pos.address] = BigNumber.from(0);
    pnkByAddress[pos.address] = pnkByAddress[pos.address].add(pnkAmount);
  }

  // 7. Build result
  let balance = BigNumber.from(0);
  const details = [];
  for (const [address, pnk] of Object.entries(pnkByAddress)) {
    if (!pnk.isZero()) {
      details.push({ address, pnk });
      balance = balance.add(pnk);
    }
  }

  return { balance, details };
}
