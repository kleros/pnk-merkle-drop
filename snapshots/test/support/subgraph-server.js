import http from "http";
import { utils } from "ethers";

/**
 * Serves StakeSet events as the kleros-display subgraph does, for the queries getStakeSets makes: the
 * events with blocknumber_gte <= block < blocknumber_lt, ordered by id, `first` at a time after `id_gt`,
 * along with a `_meta` reporting the subgraph as indexed up to `indexedBlock`.
 *
 * @param {Object} options
 * @param {Array<{ address: string, blocknumber: number, logIndex: number, newTotalStake: string }>} options.events
 * @returns {Promise<{ url: string, close: Function }>}
 */
export async function startSubgraph({ events, indexedBlock, hasIndexingErrors = false }) {
  // Ids shaped like the real subgraph's, `<transaction hash>-<log index>` (with a stand-in hash, the same
  // on every run). Paging by id then hands the events over in no chain order, as the real subgraph does,
  // so that putting them in order stays getStakeSets' job, and the golden test fails if it stops doing it.
  const stakeSets = events
    .map(({ address, blocknumber, logIndex, newTotalStake }, i) => ({
      id: `${utils.id(`${blocknumber}-${logIndex}-${i}`)}-${logIndex}`,
      address,
      subcourtID: "0",
      stake: "0",
      newTotalStake,
      logIndex: String(logIndex),
      blocknumber: String(blocknumber),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const { query } = JSON.parse(body);
      const number = (name) => Number(new RegExp(`${name}: (\\d+)`).exec(query)[1]);
      const [from, to, first] = [number("blocknumber_gte"), number("blocknumber_lt"), number("first")];
      const lastId = /id_gt: "([^"]*)"/.exec(query)[1];
      const page = stakeSets
        .filter(({ id, blocknumber }) => Number(blocknumber) >= from && Number(blocknumber) < to && id > lastId)
        .slice(0, first);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          data: { _meta: { block: { number: indexedBlock }, hasIndexingErrors }, stakeSets: page },
        })
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Points getStakeSets at `url` for the chain while `fn` runs. */
export async function withSubgraph(chainId, url, fn) {
  const name = { 1: "SUBGRAPH_KLEROS_DISPLAY_MAINNET", 100: "SUBGRAPH_KLEROS_DISPLAY_GNOSIS" }[chainId];
  const previous = process.env[name];
  process.env[name] = url;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}
