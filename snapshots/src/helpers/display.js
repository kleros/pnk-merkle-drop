import { formatEther } from "ethers/lib/utils.js";

/** Format a PNK wei amount to a human-readable string (e.g. "96.77M PNK" or "58K PNK") */
export const displayPnk = (wei) => {
  const n = parseFloat(formatEther(wei));
  return n >= 1000000 ? `${(n / 1000000).toFixed(2)}M` : `${(n / 1000).toFixed(0)}K`;
};
