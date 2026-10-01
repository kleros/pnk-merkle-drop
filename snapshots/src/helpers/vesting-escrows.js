import { BigNumber, Contract } from "ethers";
import { retry } from "./retry.js";

const FACTORY_ABI = [
  "event VestingEscrowCreated(address indexed funder, address indexed token, address indexed recipient, address escrow, uint256 amount, uint256 vesting_start, uint256 vesting_duration, uint256 cliff_length, bool open_claim)",
  "function escrows_length() view returns (uint256)",
];

const ESCROW_ABI = ["function owner() view returns (address)", "function locked() view returns (uint256)"];

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

/**
 * Calculate the PNK the Cooperative can still claw back from LlamaPay vesting escrows it funded and owns.
 * LlamaPay's VestingEscrowSimple is a fork of Yearn's yearn-vesting-escrow v0.3.0, deployed as minimal
 * proxies by a factory that logs every escrow it creates.
 *
 * Until the vesting ends, the owner can `revoke()` an escrow and get back its unvested part, which is
 * exactly what `locked()` reports. The vested part belongs to the recipient, so it is not excluded.
 * Both `revoke()` and `disown()` clear the owner, and neither can be undone, so an escrow only counts
 * while an excluded address still owns it — after `disown()` the unvested PNK can no longer be clawed
 * back, yet `locked()` keeps reporting it.
 *
 * Only escrows an excluded address paid for are considered. Anyone can use the factory and name any
 * owner, so otherwise anyone could lock their own PNK under a Cooperative owner just before the period
 * ends, have it excluded, and claim it back right after.
 *
 * Everything is read at `blockTag`, so escrows created after the period are left out and `locked()`
 * is evaluated at the period's end.
 *
 * @param {string} factory The LlamaPay vesting factory the escrows are discovered from.
 * @param {number} fromBlock The block the factory was deployed at, where the event scan starts.
 * @param {number} blockTag The block the escrows are read at.
 * @returns {{ balance: BigNumber, details: Array<{ escrow: string, owner: string, pnk: BigNumber }> }}
 */
export async function getCoopVestingEscrowPnk({
  provider,
  factory,
  fromBlock,
  pnkAddress,
  excludedAddresses,
  blockTag,
}) {
  const excludedSet = new Set(excludedAddresses.map((a) => a.toLowerCase()));
  const pnkAddr = pnkAddress.toLowerCase();

  // The factory logs every escrow it deploys and counts it in `escrows_length`, so the two must agree. If
  // they don't, the event above isn't the one this factory logs (LlamaPay's v1 factory logs another one),
  // `fromBlock` is past some of its escrows, or the RPC returned partial logs. Each of those would leave
  // escrows out without an error, so the run fails instead.
  const factoryContract = new Contract(factory, FACTORY_ABI, provider);
  const [allEvents, escrowCount] = await Promise.all([
    retry(() => factoryContract.queryFilter(factoryContract.filters.VestingEscrowCreated(), fromBlock, blockTag)),
    retry(() => factoryContract.escrows_length({ blockTag })),
  ]);
  if (!escrowCount.eq(allEvents.length)) {
    throw new Error(
      `Vesting factory ${factory} had created ${escrowCount} escrows by block ${blockTag}, ` +
        `but ${allEvents.length} VestingEscrowCreated events were found from block ${fromBlock}`
    );
  }

  // Only PNK escrows the Cooperative paid for.
  const events = allEvents.filter(
    (event) => excludedSet.has(event.args.funder.toLowerCase()) && event.args.token.toLowerCase() === pnkAddr
  );

  const pnkToken = new Contract(pnkAddress, ERC20_ABI, provider);
  let balance = BigNumber.from(0);
  const details = [];
  for (const event of events) {
    const address = event.args.escrow.toLowerCase();
    const escrow = new Contract(address, ESCROW_ABI, provider);
    const [owner, locked] = await Promise.all([
      retry(() => escrow.owner({ blockTag })),
      retry(() => escrow.locked({ blockTag })),
    ]);
    if (!excludedSet.has(owner.toLowerCase()) || locked.isZero()) continue;

    // The escrow always holds at least what is still locked. If it doesn't, it doesn't work the way
    // described above, so rather than exclude a wrong amount, stop the run and have it looked at.
    const pnkBalance = await retry(() => pnkToken.balanceOf(address, { blockTag }));
    if (locked.gt(pnkBalance)) {
      throw new Error(`Vesting escrow ${address} reports ${locked} wei locked but only holds ${pnkBalance} wei of PNK`);
    }

    details.push({ escrow: address, owner: owner.toLowerCase(), pnk: locked });
    balance = balance.add(locked);
  }

  return { balance, details };
}
