import { BigNumber, utils } from "ethers";
import fetch from "node-fetch";

const fetchStakeSets = async (blockStart, blockEnd, subgraphEndpoint, lastId) => {
  const subgraphQuery = {
    query: `
        {
          stakeSets(where: {
            blocknumber_gte: ${blockStart},
            blocknumber_lt: ${blockEnd},
            id_gt: "${lastId}"
          },
          orderBy: id,
          orderDir: asc,
          first: 1000) {
            id
            address
            subcourtID
            stake
            newTotalStake
            logIndex
            blocknumber
          }
        }
      `,
  };
  const response = await fetch(subgraphEndpoint, {
    method: "POST",
    body: JSON.stringify(subgraphQuery),
  });

  const { data } = await response.json();
  const stakeSets = data.stakeSets;

  return stakeSets;
};

const fetchAllStakeSets = async (blockStart, blockEnd, subgraphEndpoint) => {
  const batches = [];
  let lastId = "";
  for (let i = 0; i < 1000; i++) {
    console.log("Stake sets batch", batches.length);
    const sets = await fetchStakeSets(blockStart, blockEnd, subgraphEndpoint, lastId);
    console.log("Batch got length:", sets.length);
    batches.push(sets);
    if (sets.length < 1000) break;
    lastId = sets[999].id;
  }
  return batches.flat(1);
};

const parseStakeSetsIntoEvents = (subgraphStakeSets) => {
  return subgraphStakeSets.map((s) => {
    return {
      args: {
        _address: utils.getAddress(s.address), // to checksum
        _subcourtID: BigNumber.from(s.subcourtID),
        _stake: BigNumber.from(s.stake),
        _newTotalStake: BigNumber.from(s.newTotalStake),
      },
      logIndex: Number(s.logIndex),
      blockNumber: Number(s.blocknumber),
    };
  });
};

export const getStakeSets = async (blockStart, blockEnd, chainId) => {
  let endpoint;
  if (chainId === 1) {
    endpoint = "https://api.thegraph.com/subgraphs/name/greenlucid/kleros-display-mainnet";
  } else if (chainId === 100) {
    endpoint = "https://api.thegraph.com/subgraphs/name/greenlucid/kleros-display";
  } else {
    throw new Error("Unsupported Chain, nor mainnet nor gnosis");
  }
  const subgraphStakeSets = await fetchAllStakeSets(blockStart, blockEnd, endpoint);
  const parsed = parseStakeSetsIntoEvents(subgraphStakeSets);
  const sorted = parsed.sort((a, b) => {
    if (a.blockNumber === b.blockNumber) {
      return a.logIndex - b.logIndex;
    } else return a.blockNumber - b.blockNumber;
  });
  return sorted;
};
