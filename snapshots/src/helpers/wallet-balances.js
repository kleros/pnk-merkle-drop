import { Contract } from "ethers";
import { retry } from "./retry.js";

const ERC20_BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];

/**
 * Query PNK (+ additional PNK-equivalent token) balances for excluded addresses across all chains.
 * Returns an array of { chainId, address, balance } objects.
 */
export async function getCoopWalletBalances({ providers, pnkAddresses, additionalPnkTokens, excludedAddresses }) {
  const queries = [];

  for (const [chainId, provider] of Object.entries(providers)) {
    const pnkAddr = pnkAddresses[Number(chainId)];
    if (!pnkAddr) continue;

    const pnkContract = new Contract(pnkAddr, ERC20_BALANCE_ABI, provider);
    for (const addr of excludedAddresses) {
      queries.push(
        retry(() => pnkContract.balanceOf(addr)).then((bal) => ({
          chainId: Number(chainId),
          address: addr,
          balance: bal,
        }))
      );
    }

    // Also check additional PNK-equivalent tokens (e.g. stPNK on Gnosis)
    for (const tokenAddr of additionalPnkTokens[Number(chainId)] || []) {
      const token = new Contract(tokenAddr, ERC20_BALANCE_ABI, provider);
      for (const addr of excludedAddresses) {
        queries.push(
          retry(() => token.balanceOf(addr)).then((bal) => ({
            chainId: Number(chainId),
            address: addr,
            balance: bal,
          }))
        );
      }
    }
  }

  return Promise.all(queries);
}
