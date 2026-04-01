import { BigNumber, Contract } from "ethers";
import { retry } from "./retry.js";

const AMM_V2_PAIR_ABI = [
  "function token0() view returns (address)",
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

/**
 * Calculate exact PNK held by excluded addresses in a V2-style AMM pair
 * (Uniswap V2, Swapr V2 / DXswap, etc.).
 * Computes each address's proportional share of the PNK reserve from their LP token balance.
 *
 * @returns {{ balance: BigNumber, details: Array<{ address: string, pnk: BigNumber }> }}
 */
export async function getCoopV2PairPnk({ provider, pairAddress, pnkAddress, excludedAddresses }) {
  const pair = new Contract(pairAddress, AMM_V2_PAIR_ABI, provider);
  const [token0, reserves, supply, ...lpBalances] = await Promise.all([
    retry(() => pair.token0()),
    retry(() => pair.getReserves()),
    retry(() => pair.totalSupply()),
    ...excludedAddresses.map((addr) => retry(() => pair.balanceOf(addr))),
  ]);

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
