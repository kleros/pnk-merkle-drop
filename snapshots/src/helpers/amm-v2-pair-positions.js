import { BigNumber, Contract } from "ethers";
import { retry } from "./retry.js";

const AMM_V2_PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

/**
 * Calculate exact PNK held by excluded addresses in a V2-style AMM pair
 * (Uniswap V2, Swapr V2 / DXswap, etc.).
 * Computes each address's proportional share of the PNK reserve from their LP token balance.
 *
 * @param {number} blockTag The block the pair is read at.
 * @returns {{ balance: BigNumber, details: Array<{ address: string, pnk: BigNumber }> }}
 */
export async function getCoopV2PairPnk({ provider, pairAddress, pnkAddress, excludedAddresses, blockTag }) {
  const pair = new Contract(pairAddress, AMM_V2_PAIR_ABI, provider);
  const [token0, token1, reserves, supply, ...lpBalances] = await Promise.all([
    retry(() => pair.token0({ blockTag })),
    retry(() => pair.token1({ blockTag })),
    retry(() => pair.getReserves({ blockTag })),
    retry(() => pair.totalSupply({ blockTag })),
    ...excludedAddresses.map((addr) => retry(() => pair.balanceOf(addr, { blockTag }))),
  ]);

  // Otherwise the reserve of whatever the pair trades would be counted as PNK.
  if (![token0, token1].some((token) => token.toLowerCase() === pnkAddress.toLowerCase())) {
    throw new Error(`Pair ${pairAddress} trades ${token0} for ${token1}, neither of which is PNK (${pnkAddress})`);
  }
  const pnkIsToken0 = token0.toLowerCase() === pnkAddress.toLowerCase();
  const pnkReserve = pnkIsToken0 ? reserves[0] : reserves[1];
  let coopLpTotal = BigNumber.from(0);
  const details = [];

  for (let i = 0; i < lpBalances.length; i++) {
    if (!lpBalances[i].isZero()) {
      const addrPnk = lpBalances[i].mul(pnkReserve).div(supply);
      details.push({ address: excludedAddresses[i], pnk: addrPnk });
      coopLpTotal = coopLpTotal.add(lpBalances[i]);
    }
  }

  const balance = supply.isZero() ? BigNumber.from(0) : coopLpTotal.mul(pnkReserve).div(supply);
  return { balance, details };
}
