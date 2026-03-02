import { BigNumber, utils } from "ethers";
import fetch from "node-fetch";
import { createInterface } from "readline";

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
          orderDirection: asc,
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
    headers: {
      "Content-Type": "application/json",
    },
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
    const sets = await fetchStakeSets(blockStart, blockEnd, subgraphEndpoint, lastId);
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

const getEndpoints = (chainId) => {
  let gateway, studio;
  if (chainId === 1) {
    gateway = process.env.SUBGRAPH_GATEWAY_MAINNET;
    studio = process.env.SUBGRAPH_STUDIO_MAINNET;
  } else if (chainId === 100) {
    gateway = process.env.SUBGRAPH_GATEWAY_GNOSIS;
    studio = process.env.SUBGRAPH_STUDIO_GNOSIS;
  } else {
    throw new Error("Unsupported Chain, nor mainnet nor gnosis");
  }

  if (!gateway) {
    throw new Error(`Missing SUBGRAPH_GATEWAY_${chainId === 1 ? "MAINNET" : "GNOSIS"} in .env`);
  }

  return { gateway, studio: studio || null };
};

/**
 * Compares raw stake set arrays from two subgraph endpoints.
 * Returns null if they match, or a detailed diff object if they don't.
 */
const compareStakeSets = (gatewaySets, studioSets) => {
  if (gatewaySets.length === studioSets.length) {
    let allMatch = true;
    for (let i = 0; i < gatewaySets.length; i++) {
      const g = gatewaySets[i];
      const s = studioSets[i];
      if (
        g.id !== s.id ||
        g.address !== s.address ||
        g.subcourtID !== s.subcourtID ||
        g.stake !== s.stake ||
        g.newTotalStake !== s.newTotalStake ||
        g.logIndex !== s.logIndex ||
        g.blocknumber !== s.blocknumber
      ) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) return null;
  }

  const gatewayById = new Map(gatewaySets.map((s) => [s.id, s]));
  const studioById = new Map(studioSets.map((s) => [s.id, s]));

  const onlyInGateway = gatewaySets.filter((s) => !studioById.has(s.id));
  const onlyInStudio = studioSets.filter((s) => !gatewayById.has(s.id));

  const fieldMismatches = [];
  for (const [id, g] of gatewayById) {
    const s = studioById.get(id);
    if (!s) continue;
    const diffs = [];
    for (const field of ["address", "subcourtID", "stake", "newTotalStake", "logIndex", "blocknumber"]) {
      if (String(g[field]) !== String(s[field])) {
        diffs.push({ field, gateway: g[field], studio: s[field] });
      }
    }
    if (diffs.length > 0) {
      fieldMismatches.push({ id, diffs });
    }
  }

  return {
    gatewayCount: gatewaySets.length,
    studioCount: studioSets.length,
    onlyInGateway,
    onlyInStudio,
    fieldMismatches,
  };
};

const truncAddr = (addr) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;
const truncId = (id) => (id.length > 20 ? `${id.slice(0, 10)}...${id.slice(-6)}` : id);

const formatStakeSet = (s) =>
  `        └─ block ${s.blocknumber} | log ${s.logIndex} | ${truncAddr(s.address)} | court ${s.subcourtID} | stake ${
    s.stake
  }`;

const askConfirmation = async (message) => {
  if (!process.stdin.isTTY) {
    console.error("      [Integrity] Non-interactive mode, cannot prompt. Aborting.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith("y"));
    });
  });
};

// Remembers user's mismatch decision per chain so we only prompt once per run.
// Key: chainId, Value: "winner" | "merge"
const mismatchDecisions = new Map();

const mergeSets = (primarySets, secondarySets) => {
  const byId = new Map();
  for (const s of primarySets) byId.set(s.id, s);
  for (const s of secondarySets) byId.set(s.id, s);
  return Array.from(byId.values());
};

const logExclusiveEvents = (events, sourceName) => {
  if (events.length === 0) return;
  console.error(`      Missing from ${sourceName} (${events.length}):`);
  for (const s of events.slice(0, 20)) {
    console.error(formatStakeSet(s));
  }
  if (events.length > 20) {
    console.error(`        ... and ${events.length - 20} more`);
  }
};

/**
 * Handles a mismatch between gateway and studio subgraph data.
 *
 * - Field mismatches (same ID, different values): HARD ABORT, data corruption.
 * - One is a strict superset: prompt user to use the more complete one.
 * - Both have exclusive events: prompt user to merge both datasets.
 */
const handleMismatch = async (diff, gatewaySets, studioSets, chainId) => {
  const chainName = chainId === 1 ? "Mainnet" : "Gnosis";
  const sharedCount = diff.gatewayCount - diff.onlyInGateway.length;

  if (diff.fieldMismatches.length > 0) {
    console.error("");
    console.error("      !! SUBGRAPH DATA CORRUPTION — ABORTING");
    console.error("      ───────────────────────────────────────────────────────");
    console.error(`      Chain: ${chainName} (${chainId})`);
    console.error(`      ${diff.fieldMismatches.length} event(s) have DIFFERENT values between subgraphs.\n`);
    for (const m of diff.fieldMismatches.slice(0, 10)) {
      console.error(`        Event ${truncId(m.id)}:`);
      for (const d of m.diffs) {
        console.error(`          ${d.field}: gateway="${d.gateway}" vs studio="${d.studio}"`);
      }
    }
    if (diff.fieldMismatches.length > 10) {
      console.error(`        ... and ${diff.fieldMismatches.length - 10} more`);
    }
    console.error("");
    throw new Error(
      `Subgraph data corruption for chain ${chainId} (${chainName}). ` +
        `${diff.fieldMismatches.length} shared event(s) have different field values. Cannot proceed.`
    );
  }

  const bothHaveExclusives = diff.onlyInGateway.length > 0 && diff.onlyInStudio.length > 0;
  const winnerName = bothHaveExclusives ? "merge" : diff.gatewayCount >= diff.studioCount ? "Gateway" : "Studio";

  // If we already prompted for this chain in this run, reuse the decision.
  const priorDecision = mismatchDecisions.get(chainId);
  if (priorDecision) {
    console.error("");
    console.error(
      `      [Integrity] Mismatch again on ${chainName} (Gateway: ${diff.gatewayCount} | Studio: ${diff.studioCount})`
    );
    if (priorDecision === "merge") {
      const merged = mergeSets(gatewaySets, studioSets);
      console.error(`      [Integrity] Auto-applying previous decision: merge (${merged.length} events)\n`);
      return merged;
    }
    const winnerSets = priorDecision === "Gateway" ? gatewaySets : studioSets;
    console.error(
      `      [Integrity] Auto-applying previous decision: ${priorDecision} (${winnerSets.length} events)\n`
    );
    return winnerSets;
  }

  // First time seeing a mismatch on this chain — show full diff and prompt.
  console.error("");
  console.error("      !! SUBGRAPH DATA MISMATCH");
  console.error("      ───────────────────────────────────────────────────────");
  console.error(`      Chain: ${chainName} (${chainId})`);
  console.error(`      Gateway: ${diff.gatewayCount} events | Studio: ${diff.studioCount} events`);
  console.error(`      Shared: ${sharedCount} events (all match)\n`);

  logExclusiveEvents(diff.onlyInGateway, "Gateway");
  logExclusiveEvents(diff.onlyInStudio, "Studio");

  if (bothHaveExclusives) {
    const mergedCount = sharedCount + diff.onlyInGateway.length + diff.onlyInStudio.length;
    console.error(`\n      Both subgraphs are independently incomplete.`);
    console.error(`      → Merge both datasets (${mergedCount} unique events)?\n`);

    const confirmed = await askConfirmation("      Proceed with merge? [y/N] ");
    if (!confirmed) {
      throw new Error(`Subgraph integrity check failed for chain ${chainId} (${chainName}). Aborted by user.`);
    }

    mismatchDecisions.set(chainId, "merge");
    const merged = mergeSets(gatewaySets, studioSets);
    console.error(`      [Integrity] Proceeding with merged dataset (${merged.length} events)\n`);
    return merged;
  }

  const winnerSets = diff.gatewayCount >= diff.studioCount ? gatewaySets : studioSets;
  const extraCount = Math.abs(diff.gatewayCount - diff.studioCount);

  console.error(`\n      → ${winnerName} has ${extraCount} extra event(s), use it instead?\n`);

  const confirmed = await askConfirmation(`      Proceed with ${winnerName} (${winnerSets.length} events)? [y/N] `);
  if (!confirmed) {
    throw new Error(`Subgraph integrity check failed for chain ${chainId} (${chainName}). Aborted by user.`);
  }

  mismatchDecisions.set(chainId, winnerName);
  console.error(`      [Integrity] Proceeding with ${winnerName} (${winnerSets.length} events)\n`);
  return winnerSets;
};

export const getStakeSets = async (blockStart, blockEnd, chainId) => {
  const { gateway, studio } = getEndpoints(chainId);
  const chainName = chainId === 1 ? "Mainnet" : "Gnosis";

  const gatewaySets = await fetchAllStakeSets(blockStart, blockEnd, gateway);
  let finalSets = gatewaySets;

  if (studio) {
    console.log(
      `      [Integrity] Cross-checking ${chainName} subgraph data (${gatewaySets.length} gateway events)...`
    );
    const studioSets = await fetchAllStakeSets(blockStart, blockEnd, studio);
    console.log(`      [Integrity] Studio returned ${studioSets.length} events.`);

    const diff = compareStakeSets(gatewaySets, studioSets);
    if (diff) {
      finalSets = await handleMismatch(diff, gatewaySets, studioSets, chainId);
    } else {
      console.log(`      [Integrity] PASS — Both subgraphs returned identical data.`);
    }
  }

  const parsed = parseStakeSetsIntoEvents(finalSets);
  const sorted = parsed.sort((a, b) => {
    if (a.blockNumber === b.blockNumber) {
      return a.logIndex - b.logIndex;
    } else return a.blockNumber - b.blockNumber;
  });
  return sorted;
};
