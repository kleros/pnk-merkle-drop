/*
 * What the seeding page does, kept out of the page so that the offline suite runs this same code against a
 * fake wallet (test/signer.test.js). The browser loads it as a plain module, so it imports nothing: the
 * chains come from config.js through the server (signerChains in ../seeding.js).
 *
 * The page's link carries the chain and the calldata. Any link that isn't a seedAllocations call to that
 * chain's MerkleRedeem is refused. The page then checks through the wallet that the owner can seed that week
 * right now, and only then hands the wallet exactly that transaction, with no value.
 */

// The selectors of the functions the page calls, which it can't hash itself. The suite holds each to its signature.
export const SELECTORS = {
  seedAllocations: "0x4cd488ab", // seedAllocations(uint256,bytes32,uint256)
  weekMerkleRoots: "0xdd8c9c9d", // weekMerkleRoots(uint256)
  owner: "0x8da5cb5b", // owner()
  token: "0xfc0c546a", // token()
  balanceOf: "0x70a08231", // balanceOf(address)
  allowance: "0xdd62ed3e", // allowance(address,address)
};

const WORD = 64; // hex digits in a 32-byte ABI word
const ZERO_WORD = `0x${"0".repeat(WORD)}`;
const PARAMETERS = ["chainId", "to", "data"];

const encodeUint = (value) => BigInt(value).toString(16).padStart(WORD, "0");
const encodeAddress = (address) => address.toLowerCase().slice(2).padStart(WORD, "0");
const hexQuantity = (n) => `0x${n.toString(16)}`; // a chain ID or block number as JSON-RPC writes it

/** An amount of wei in tokens, the way ethers' formatEther writes it (e.g. "2921589.95768397462577333", "1.0"). */
export function formatAmount(amount) {
  const unit = 10n ** 18n;
  const fraction = (amount % unit).toString().padStart(18, "0").replace(/0+$/, "");
  return `${amount / unit}.${fraction || "0"}`;
}

/**
 * The seeding a link describes: its chain, and the week, root and amount its calldata seeds. Throws on any
 * link that cli.js and verify-snapshot.js wouldn't print.
 *
 * @param {string} search The link's query string, e.g. "?chainId=1&to=0x…&data=0x…".
 * @param {object} chains The chains the drop is seeded on, by chain ID, as signerChains in ../seeding.js has them.
 */
export function readSeeding(search, chains) {
  const params = new URLSearchParams(search);
  for (const name of new Set(params.keys())) {
    if (!PARAMETERS.includes(name)) throw new Error(`The link has a "${name}" parameter, which the CLI never prints`);
  }
  for (const name of PARAMETERS) {
    if (params.getAll(name).length !== 1) throw new Error(`The link has to have exactly one "${name}" parameter`);
  }

  const chainId = params.get("chainId");
  if (!/^[1-9][0-9]*$/.test(chainId) || !chains[chainId]) {
    throw new Error(`chainId ${chainId} isn't a chain the drop is seeded on`);
  }
  const chain = chains[chainId];
  const to = params.get("to");
  if (to.toLowerCase() !== chain.merkleRedeem.toLowerCase()) {
    throw new Error(`to ${to} isn't ${chain.name}'s MerkleRedeem ${chain.merkleRedeem}`);
  }
  const data = params.get("data").toLowerCase();
  if (!new RegExp(`^${SELECTORS.seedAllocations}[0-9a-f]{${3 * WORD}}$`).test(data)) {
    throw new Error("data isn't a call to seedAllocations(uint256,bytes32,uint256)");
  }

  const word = (index) => data.slice(10 + index * WORD, 10 + (index + 1) * WORD);
  const week = BigInt(`0x${word(0)}`);
  const root = `0x${word(1)}`;
  const amount = BigInt(`0x${word(2)}`);
  // the week before has to be seeded already, so the first week can't be seeded from here
  if (week < 1n || week > 1000000n) throw new Error(`Week ${week} isn't a week the drop could be seeding`);
  if (root === ZERO_WORD) throw new Error("The merkle root is zero");
  if (amount === 0n) throw new Error("The amount is zero");
  return { chainId: Number(chainId), chain, to: chain.merkleRedeem, data, week: Number(week), root, amount };
}

// A read through the wallet's node, at the latest block unless told another, answered by a single 32-byte word.
// Anything else, such as the "0x" of an address without code, is refused rather than read as zero.
async function readWord(provider, to, data, what, blockTag = "latest") {
  const answer = await provider.request({ method: "eth_call", params: [{ to, data }, blockTag] });
  if (typeof answer !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(answer)) {
    throw new Error(`${what} answered ${answer}, not a 32-byte word`);
  }
  return answer.toLowerCase();
}

/**
 * Checks through the wallet everything the seeding needs, and throws at the first thing that fails: the wallet's
 * account is the owner, and the wallet is on the chain; the owner has no transaction pending; the MerkleRedeem has
 * that owner and distributes the chain's token; the week isn't seeded and comes right after a seeded one; the owner
 * holds the amount and has allowed the MerkleRedeem to take it; the transaction succeeds when simulated as the
 * owner; and the wallet is still on that account and chain at the end.
 *
 * @param {{ request: Function }} provider The wallet (EIP-1193).
 * @param {object} seeding What readSeeding read from the link.
 * @param {(line: string, kind?: string) => void} report Told each check that passed, and, as a "note", what
 *   couldn't be checked.
 */
export async function checkSeeding(provider, seeding, report = () => {}) {
  const { chainId, chain, to, data, week, root, amount } = seeding;
  const owner = chain.owner.toLowerCase();
  const onOwnerAndChain = (accounts, walletChainId) =>
    Array.isArray(accounts) && String(accounts[0]).toLowerCase() === owner && Number(walletChainId) === chainId;

  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const account = Array.isArray(accounts) ? accounts[0] : undefined;
  if (String(account).toLowerCase() !== owner) {
    throw new Error(`The wallet's account is ${account}, not the owner ${chain.owner}: select the owner in the wallet`);
  }
  report(`The wallet's account is the owner, ${chain.owner}`);

  // A wallet that doesn't switch, or switches somewhere else, is caught by reading the chain again.
  if (Number(await provider.request({ method: "eth_chainId" })) !== chainId) {
    await provider
      .request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexQuantity(chainId) }] })
      .catch((error) => {
        // EIP-3326: the wallet doesn't have the chain. Adding it would mean picking a node for it, the user's call.
        if (error?.code !== 4902) throw error;
        throw new Error(
          `The wallet doesn't have ${chain.name} (chain ${chainId}): add it to the wallet, then Check again`
        );
      });
  }
  const walletChainId = Number(await provider.request({ method: "eth_chainId" }));
  if (walletChainId !== chainId) {
    throw new Error(`The wallet is on chain ${walletChainId}, not on ${chain.name} (chain ${chainId})`);
  }
  report(`The wallet is on ${chain.name} (chain ${chainId})`);

  // A transaction of the owner's still pending, such as this seeding sent from the page before it was reloaded,
  // would make this one its duplicate or keep it waiting. Not being able to tell doesn't stop the seeding.
  const transactionCount = (blockTag) =>
    provider.request({ method: "eth_getTransactionCount", params: [chain.owner, blockTag] });
  let pending;
  try {
    const [mined, sent] = await Promise.all([transactionCount("latest"), transactionCount("pending")]);
    pending = Number(sent) - Number(mined);
  } catch (error) {
    report(`Couldn't read whether the owner has a transaction pending (${error?.message}): check the wallet`, "note");
  }
  if (pending > 0) {
    throw new Error(`The owner has ${pending} transaction(s) pending: wait until mined, then Check again`);
  }
  if (pending === 0) report("The owner has no transaction pending");

  const contractOwner = await readWord(provider, to, SELECTORS.owner, "owner()");
  if (contractOwner !== `0x${encodeAddress(owner)}`) {
    throw new Error(`${to} is owned by 0x${contractOwner.slice(26)}, not by ${chain.owner}`);
  }
  const token = await readWord(provider, to, SELECTORS.token, "token()");
  if (token !== `0x${encodeAddress(chain.token)}`) {
    throw new Error(`${to} distributes 0x${token.slice(26)}, not ${chain.symbol} (${chain.token})`);
  }
  report(`${to} is owned by the owner and distributes ${chain.symbol}`);

  const weekRoot = (n) => readWord(provider, to, SELECTORS.weekMerkleRoots + encodeUint(n), `weekMerkleRoots(${n})`);
  const seededRoot = await weekRoot(week);
  if (seededRoot === root) throw new Error(`Week ${week} is already seeded with this root: there is nothing to sign`);
  if (seededRoot !== ZERO_WORD) throw new Error(`Week ${week} is already seeded, with another root: ${seededRoot}`);
  if ((await weekRoot(week - 1)) === ZERO_WORD) {
    throw new Error(`Week ${week - 1} isn't seeded, so week ${week} isn't the next one to seed`);
  }
  report(`Week ${week} isn't seeded yet, and week ${week - 1} is`);

  const balance = BigInt(
    await readWord(provider, chain.token, SELECTORS.balanceOf + encodeAddress(owner), "balanceOf(owner)")
  );
  if (balance < amount) {
    throw new Error(`The owner holds ${formatAmount(balance)} ${chain.symbol}, less than the ${formatAmount(amount)}`);
  }
  const allowance = BigInt(
    await readWord(
      provider,
      chain.token,
      SELECTORS.allowance + encodeAddress(owner) + encodeAddress(to),
      "allowance(owner, MerkleRedeem)"
    )
  );
  if (allowance < amount) {
    throw new Error(
      `The owner has approved ${formatAmount(allowance)} ${chain.symbol} to the MerkleRedeem, less than the ` +
        `${formatAmount(amount)}: approve it first`
    );
  }
  // 2^255 wei and up is the "unlimited" approval wallets offer, which reads better as such than as 78 digits
  const approved = allowance >= 2n ** 255n ? "an unlimited amount" : `${formatAmount(allowance)} ${chain.symbol}`;
  report(`The owner holds ${formatAmount(balance)} ${chain.symbol} and has approved ${approved}`);

  const simulated = await provider.request({
    method: "eth_call",
    params: [{ from: chain.owner, to, data, value: "0x0" }, "latest"],
  });
  if (simulated !== "0x") throw new Error(`Simulated as the owner, the seeding returned ${simulated} instead of 0x`);

  // Every answer above is about the account and chain the wallet was on when it gave it, and "0x" is also what an
  // address without code answers.
  const [accountsNow, chainIdNow] = await Promise.all([
    provider.request({ method: "eth_accounts" }),
    provider.request({ method: "eth_chainId" }),
  ]);
  if (!onOwnerAndChain(accountsNow, chainIdNow)) {
    throw new Error("The wallet's account or chain changed during the checks: Check again");
  }
  report("Simulated as the owner, the seeding succeeds");
}

/**
 * Runs every check again, then hands the wallet the seeding and nothing else: from the owner, to the MerkleRedeem,
 * with the link's calldata, no value, and the chain's ID, which the wallet holds against the chain it is on.
 * An error thrown once the wallet has been asked carries `sent: true` unless the user rejected the request, as the
 * wallet may then have sent it.
 *
 * @returns {Promise<string>} The transaction's hash.
 */
export async function checkAndSend(provider, seeding, report = () => {}) {
  await checkSeeding(provider, seeding, report);
  let hash;
  try {
    hash = await provider.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: seeding.chain.owner,
          to: seeding.to,
          data: seeding.data,
          value: "0x0",
          chainId: hexQuantity(seeding.chainId),
        },
      ],
    });
  } catch (error) {
    // EIP-1193's 4001: the user rejected it, so nothing was sent
    throw Object.assign(new Error(error?.message ?? String(error)), { code: error?.code, sent: error?.code !== 4001 });
  }
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw Object.assign(new Error(`The wallet answered ${hash} instead of a transaction hash`), { sent: true });
  }
  return hash.toLowerCase();
}

/**
 * The page's state for one seeding. Send is offered only after a Check that no change of the wallet's account or
 * chain interrupted, and once the wallet may have sent the seeding, never again: reloading the page checks the
 * week, and any transaction of the owner's still pending, afresh.
 *
 * @param {(event: string, couldSend: boolean) => void} onVoided Told when the wallet's account or chain changed,
 *   voiding the last Check, and whether Send was being offered.
 * @returns {{ canCheck: () => boolean, canSend: () => boolean, check: (report) => Promise<void>,
 *   send: (report) => Promise<string> }}
 */
export function seedingSession(provider, seeding, onVoided = () => {}) {
  let changes = 0;
  let checked = false;
  let sent = false;
  const alreadySent = "The wallet may have sent this seeding already: reload the page once it is mined";
  // Any change of the wallet's account or chain voids a Check, made before or during it, except one onto the owner
  // or the seeding's chain: that is what the Check itself asks the wallet for when it isn't there yet.
  const owner = seeding.chain.owner.toLowerCase();
  for (const event of ["accountsChanged", "chainChanged"]) {
    provider.on?.(event, (value) => {
      const ontoTheSeeding =
        event === "chainChanged"
          ? Number(value) === seeding.chainId
          : Array.isArray(value) && String(value[0]).toLowerCase() === owner;
      if (ontoTheSeeding) return;
      const couldSend = checked && !sent;
      changes += 1;
      checked = false;
      onVoided(event, couldSend);
    });
  }
  return {
    canCheck: () => !sent,
    canSend: () => checked && !sent,
    async check(report) {
      if (sent) throw new Error(alreadySent);
      checked = false;
      const before = changes;
      await checkSeeding(provider, seeding, report);
      if (changes !== before) throw new Error("The wallet's account or chain changed during the checks: Check again");
      checked = true;
    },
    async send(report) {
      if (sent) throw new Error(alreadySent);
      if (!checked) throw new Error("Check first");
      checked = false;
      try {
        const hash = await checkAndSend(provider, seeding, report);
        sent = true;
        return hash;
      } catch (error) {
        if (error.sent) sent = true;
        throw error;
      }
    },
  };
}

/**
 * Polls the wallet until the transaction is mined, then checks that it succeeded and that the week now has the
 * seeding's root.
 *
 * @returns {Promise<number>} The block it was mined in.
 */
export async function waitForSeeding(provider, seeding, hash, { intervalMs = 4000, sleep } = {}) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    const receipt = await provider.request({ method: "eth_getTransactionReceipt", params: [hash] });
    if (receipt) {
      const block = Number(receipt.blockNumber);
      if (Number(receipt.status) !== 1) throw new Error(`The seeding was mined in block ${block}, and reverted`);
      const { to, week, root } = seeding;
      // read at the block it was mined in: a node that hasn't caught up with it would answer from before it
      const seededRoot = await readWord(
        provider,
        to,
        SELECTORS.weekMerkleRoots + encodeUint(week),
        "weekMerkleRoots",
        hexQuantity(block)
      );
      if (seededRoot !== root) throw new Error(`Mined in block ${block}, but week ${week}'s root is ${seededRoot}`);
      return block;
    }
    await wait(intervalMs);
  }
}
