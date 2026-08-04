import { BigNumber } from "ethers";
import { fetchJson } from "./fetch-json.js";

// Index of every snapshot the Court frontend serves, as `<cid>/<filename>` entries keyed by chain ID.
// Source of truth: https://github.com/kleros/court/blob/master/public/snapshots.json
export const SNAPSHOTS_INDEX_URL = "https://court.kleros.io/snapshots.json";
export const IPFS_GATEWAY = "https://cdn.kleros.link/ipfs";

/** Naming convention used when uploading a snapshot. */
// edit when arbitrum inclusion
export const snapshotFilename = (chainId, period) => {
  const prefix = { 1: "", 100: "xdai-" }[Number(chainId)];
  if (prefix === undefined) {
    throw new Error(`No known snapshot filename convention for chain ${chainId} — add its prefix to snapshotFilename`);
  }
  return `${prefix}snapshot-${period}.json`;
};

/** Fetches the snapshots index, so callers needing several lookups only pay for it once. */
export const fetchSnapshotsIndex = () => fetchJson(SNAPSHOTS_INDEX_URL);

/**
 * The chain IDs (as strings, like the index keys) that already list a snapshot for the period.
 * Matching on the period suffix alone, so files are detected whatever prefix a chain's files use —
 * reading them back still expects the prefixes `snapshotFilename` knows about.
 */
export const publishedChainsForPeriod = (index, period) =>
  Object.keys(index).filter(
    (chainId) => Array.isArray(index[chainId]) && index[chainId].some((it) => it.endsWith(`snapshot-${period}.json`))
  );

async function getPublishedDrop({ index, chainId, period }) {
  const entries = index[String(chainId)];
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${SNAPSHOTS_INDEX_URL} lists no snapshots for chain ${chainId}`);
  }

  // Entries look like `<cid>/<filename>`. Scanning from the end picks the latest CID for the period,
  // in case it ever had to be re-uploaded.
  const filename = snapshotFilename(chainId, period);
  const entry = entries.filter((it) => it.endsWith(`/${filename}`)).pop();
  if (!entry) {
    throw new Error(
      `${SNAPSHOTS_INDEX_URL} has no ${filename} for chain ${chainId} (latest listed: ${
        entries[entries.length - 1]
      }). ` +
        `Either it has not been published to kleros/court yet, or you can pass --lastamount={wei} to skip this lookup.`
    );
  }

  const url = `${IPFS_GATEWAY}/${entry}`;
  const snapshot = await fetchJson(url);

  // Guards against a CID being listed under the wrong filename: every amount being summed has to
  // belong to the period being read.
  if (!String(snapshot.startDate).startsWith(period)) {
    throw new Error(`${url} is listed as ${filename} but covers ${snapshot.startDate} instead of ${period}`);
  }
  if (snapshot.droppedAmount == null) {
    throw new Error(`${url} has no droppedAmount`);
  }

  // Amounts are serialized as `{ type: "BigNumber", hex: "0x..." }`, in wei.
  return { chainId, droppedAmount: BigNumber.from(snapshot.droppedAmount), url };
}

/**
 * Reads back how much each chain dropped in an already published period.
 *
 * Snapshots are immutable once published, so these are exactly the amounts the jurors were able to
 * claim. Every chain read must have published that period — a partial answer would understate the
 * total without any sign of it, so a missing one throws instead.
 *
 * `chainIds` says which chains take part in the distribution *now*, but the total has to be whatever
 * was actually dropped back then. Any other chain the index shows publishing that period is summed
 * as well, so a chain that has since left the distribution cannot quietly go missing from the total.
 *
 * @param {Object} options
 * @param {number[]} options.chainIds The chains that take part in the distribution.
 * @param {string} options.period The period of the distribution, as `YYYY-MM`.
 * @param {Object} [options.index] An already fetched snapshots index, to save refetching it.
 * @returns {Promise<Array<{chainId: number, droppedAmount: BigNumber, url: string}>>} One entry per chain, in wei.
 */
export async function getPublishedDrops({ chainIds, period, index }) {
  index = index ?? (await fetchSnapshotsIndex());

  // Index keys are strings, `chainIds` are numbers: compare as strings so a chain is never read twice.
  const requested = new Set(chainIds.map(String));
  const alsoPublished = publishedChainsForPeriod(index, period).filter((chainId) => !requested.has(chainId));

  const allChainIds = [...chainIds, ...alsoPublished.map(Number)];

  return Promise.all(allChainIds.map((chainId) => getPublishedDrop({ index, chainId, period })));
}
