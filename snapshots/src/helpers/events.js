import { mapLimit as asyncMapLimit } from "awaity/esm/fp/index.js";
import { map, range, reduce } from "ramda";

export const DEFAULT_BLOCK_BATCH_SIZE = 1000000;

export const getLatestEvent = reduce(
  (latest, current) => (latest === undefined || latest.blockNumber <= current.blockNumber ? current : latest),
  undefined
);

export async function getEvents(
  contract,
  filter,
  { fromBlock, toBlock, concurrency, batchSize = DEFAULT_BLOCK_BATCH_SIZE }
) {
  const blockIntervals = splitBlockInterval({ fromBlock, toBlock, batchSize });

  const result = await asyncMapLimit(
    ({ from, to }) => contract.queryFilter(filter, from, to),
    concurrency,
    blockIntervals
  );

  return result.flat();
}

function splitBlockInterval({ fromBlock, toBlock, batchSize }) {
  const totalBlocks = toBlock - fromBlock + 1;
  if (totalBlocks <= 0) {
    return [];
  }

  const totalPages = Math.ceil(totalBlocks / batchSize);

  return map((currentPage) => {
    const from = fromBlock + currentPage * batchSize;
    const to = Math.min(from + batchSize - 1, toBlock);

    return { from, to };
  }, range(0, totalPages));
}
