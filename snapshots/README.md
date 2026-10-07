# PNK Airdrop Snapshot Generator

This utility generates the monthly snapshots for the PNK airdrop — one per chain, containing every
juror's claimable amount as a merkle tree — pins them to IPFS, and prints the transactions that
seed the drops on-chain.

Jurors claim against the snapshots listed in
[kleros/court's `snapshots.json`](https://github.com/kleros/court/blob/master/public/snapshots.json),
which the Court frontend serves at
[`https://court.kleros.io/snapshots.json`](https://court.kleros.io/snapshots.json) — a run is not
live until that file lists its IPFS URLs (see [After the run](#after-the-run)).

## Usage

One-time setup — install at the repo root (this is a yarn workspace), configure inside
`snapshots/`:

```sh
nvm install            # at the repo root: the Node.js version in .nvmrc, the one CI tests with
yarn install           # at the repo root
cd snapshots
cp .env.example .env   # then fill in the Alchemy RPC URLs and the Filebase token
```

All three `ALCHEMY_*` RPC URLs are needed: Mainnet and Gnosis for the snapshots themselves, and
Arbitrum for the KIP-86 supply exclusions. They have to serve archive data, since the run reads
chain state as of the last block of the period rather than as of now (see
[The reward formula](#the-reward-formula)) — Alchemy does on every plan, so its URLs work as they
are. `FILEBASE_TOKEN` is used to pin the snapshots to IPFS at the end of the run. The `SUBGRAPH_*`
URLs are used to query juror stakes: the Mainnet one comes pre-filled in `.env.example`, while the
Gnosis subgraph is only served through The Graph's gateway, so its URL needs your own
[API key](https://thegraph.com/studio/apikeys/) filled in.

The monthly run is then, from inside this `snapshots/` directory:

```sh
nvm use          # the Node.js version in .nvmrc
yarn test:live   # about 20 seconds, see below
node cli.js
```

That is the whole thing — no arguments needed. The period is derived from the calendar (running
any time during August, in UTC, generates the July drop), the amount to compound on is read back
from the previous period's published snapshots, and the reward formula does the rest. The output
ends with the IPFS URLs and the seeding steps covered in [After the run](#after-the-run).
Along the way the run checks itself, and stops rather than publish a drop that can't be right — see
[Safety checks](#safety-checks). `yarn test:live` comes first because the run can't check two things
itself: that no KIP-86 source has gone missing from the configuration, and that the RPCs still support
the `eth_call` state overrides its checks rely on.

The only flags are the escape hatches explained in the sections below:

```
Usage: cli.js [--lastamount={n}] [--force]

Options:
  --help        Show help                                              [boolean]
  --version     Show version number                                    [boolean]
  --lastamount  The amount of tokens, in wei, that were distributed in the
                last period. Defaults to the sum read back from all of the
                last period's published snapshots.                      [string]
  --force       Regenerate the period even if its snapshots are already
                published. Chain state is read at the period's last
                block, so the amounts should come out the same.
                                                      [boolean] [default: false]
```

The first run takes a long time: it has to download the metadata of every block that ever emitted
a `StakeSet` event (see [Implementation Details](#implementation-details)). Later runs reuse the
local `.cache` directory and are much faster.

## The reward formula

The total reward for a period compounds on the previous period's drop:

```
reward = lastDrop × (1 + target − staked)
```

where `staked` is the share of the adjusted supply staked in Court, averaged over the period and
summed across chains, and `target` is the staking level the drop incentivizes: 33% for September
2025, increasing by 0.2% each period, capped at 50%. Staking below the target makes the reward
grow; staking above it makes it shrink.

The adjusted supply is the PNK total supply minus the Kleros Cooperative's holdings — its wallets
and LP positions across Mainnet, Gnosis and Arbitrum, plus the unvested part of its Sablier streams
and LlamaPay vesting escrows on Mainnet and Arbitrum, which it can still claw back — per
[KIP-86](https://forum.kleros.io/t/kip-86-exclude-pnk-held-by-the-kleros-cooperative-from-kip-66/1423).
The run prints the excluded total with a reminder to cross-check it against the Cooperative's
[DeBank bundle](https://debank.com/bundles/69929/portfolio). DeBank does not show the LlamaPay
escrows (as of October 2026), so they are not part of the bundle's total.

Both the total supply and the Cooperative's holdings are read **at the last block of the period**,
one block per chain — the same UTC instant is a different height on Mainnet, Gnosis and Arbitrum, so
each is resolved separately and printed. This is what makes a period reproducible: read live, the
exclusions drift with the clock, because Sablier streams and vesting escrows keep vesting and LP
positions keep moving.
For July 2026 the drift over the first twelve days of August was 6.28M PNK, 0.82% of the adjusted
supply — enough to change the reward. It also means the DeBank cross-check is only approximate,
since DeBank shows the holdings of today rather than those of the period's last block.

The reward is then split 90% to Mainnet and 10% to Gnosis, and within each chain every juror
claims pro rata to their average stake over the month.

## Last period's drop

The reward formula compounds on the total amount dropped in the previous period, which no longer has
to be passed in by hand: the CLI looks up the previous period in
[`https://court.kleros.io/snapshots.json`](https://court.kleros.io/snapshots.json) and adds up the
`droppedAmount` (in wei) of every chain's snapshot for that period — both the chains it distributes
to today and any other chain the index shows published that period, so a chain that has since left
cannot go missing from the total. That sum is exactly what the jurors were able to claim, so no
assumption is made about how the drop was split between chains.

This means the previous period must already be listed in
[kleros/court](https://github.com/kleros/court/blob/master/public/snapshots.json) **for every chain**
— a missing one would understate the total, so the run aborts with an explicit error instead. To
bypass the lookup (e.g. the PR is not merged yet), pass the total explicitly:

```sh
node cli.js --lastamount=4548884914717575249957358
```

The same snapshots are what the formula's stake is checked against (see [Safety checks](#safety-checks)),
so with `--lastamount` the run doesn't check the stake, and says so.

## Re-run protection

A run only decides _when_ it happens — the period it generates is derived from the calendar, so
accidentally running twice in the same month regenerates a period that has already been published
and seeded on-chain. Every chain read is pinned to the period's last block, and a run aborts rather
than use a subgraph that hasn't indexed past the period, so the amounts come out the same — but the
drop would still end up seeded twice.
To catch this, the run aborts if the index already lists a snapshot of the period it is about to
generate, for any chain. To bypass the check (e.g. redoing a bad run on purpose):

```sh
node cli.js --force
```

The check can only see snapshots that have reached the index, so it protects against re-running an
already disbursed month — not against back-to-back runs before the kleros/court PR is merged.

## After the run

The run ends with everything needed to make the drop claimable:

1. **Seed the drops on-chain**, following the printed execution steps in order (the snapshot files
   can be checked once more right before, see
   [Verifying snapshots before seeding](#verifying-snapshots-before-seeding)): seed the Mainnet
   merkle drop contract, bridge Gnosis's share via the
   [Gnosis bridge](https://bridge.gnosischain.com/), wrap it xPNK → stPNK on
   [court.kleros.io](https://court.kleros.io), and seed the Gnosis merkle drop contract. Each
   seeding is signed as described in [Signing](#signing): the run prints what the hardware wallet
   should show and the `cast` commands that simulate and sign the transaction. The owner has to hold
   the month's PNK (Mainnet) and stPNK (Gnosis), and its allowances for the merkle drop contracts
   must already be in place.
2. **Open a PR to [kleros/court](https://github.com/kleros/court)** adding the printed IPFS URLs
   to `public/snapshots.json`. Jurors cannot claim until it is merged — and neither the automatic
   `--lastamount` lookup nor the re-run protection can see the period until then, so don't leave
   it for later.

## Safety checks

A seeded drop can't be undone: `MerkleRedeem` can't replace a week's root, and it has no way to give
tokens back, so PNK seeded against a root nobody can claim from stays locked in it. A run therefore
stops, before it uploads anything or prints the seeding transactions, as soon as something it
computed can't be right:

- **Self-test.** Before anything else, the run runs the offline test suite (see [Tests](#tests)) and
  doesn't start if any of it fails, so code or dependency versions that break it never produce a drop.
- **Stake.** The formula's stake is the previous period's, which the run reads from the subgraph again.
  Each chain's stake has to be, to the wei, the `averageTotalStaked` of its published snapshot of that
  period, so a subgraph whose stake history now adds up to another stake stops the run.
- **Pinned blocks.** Each chain's block has to be its last one before the period ends.
- **KIP-86 exclusions.** The helpers stop on what would otherwise be silently miscounted: Uniswap V4
  positions their Transfer events don't account for, V4 positions holding more PNK than the
  PoolManager, a V2 pair that doesn't trade PNK, Sablier streams refunding more PNK than their
  contract holds, a LlamaPay factory whose events miss escrows, an escrow holding less than it
  reports locked.
- **Reward.** The exclusions have to leave a positive supply, the stake has to be a share of it, and
  the target has to be the one the KIP-66 schedule sets for the period.
- **Before publishing**, on each snapshot exactly as it will be uploaded: every claim is its pro-rata
  share of the drop, under its checksummed address, for no KIP-86 address, with a leaf and a proof
  that the contract's own MerkleProof accepts, under a root that commits to exactly those claims;
  and the chains' drops split the reward. Then on-chain: the previous week is seeded and this one
  isn't (or already holds this exact root), the chain's MerkleRedeem distributes the chain's token,
  and the deployed MerkleRedeem accepts every claim, through an `eth_call` that writes the root into
  the week's storage slot.

The checks are in [`src/invariants.js`](src/invariants.js). What none of them can catch is a new
kind of Cooperative position the run doesn't look for at all (the DeBank cross-check is still the
way to notice one), or a wrong input the checks take from the same place the computation does, such
as the subgraph's stake history for the period being generated (the next run checks it against the
snapshots this run publishes, but by then they have been seeded).

### Verifying snapshots before seeding

The per-file and on-chain checks can be run again on snapshot files, by anyone, e.g. by a second
person right before seeding:

```sh
node verify-snapshot.js .cache/snapshot-2026-09.json .cache/xdai-snapshot-2026-09.json
```

They catch a file that was corrupted, edited carelessly, or built for the wrong period, block, week
or contract, and they bound what a bad file can cost: its claims can't add up to more than the amount
the seeding transaction carries, which the device shows. They don't recompute the drop: they take the
stakes, the adjusted supply and the amount from the files, and don't repeat the run's reward, supply
or KIP-86 checks. So a file that is wrong but consistent with itself passes them, whether a wrong
input made it so or it was forged on the machine that ran `cli.js`.

It takes the week a file would be seeded as from [`snapshots.json`](https://court.kleros.io/snapshots.json)
(the position the file has, or will be appended at) and needs the RPC URLs in `.env`. To check what
was pinned to IPFS rather than a local copy, download it first under its own name, e.g.
`curl -o snapshot-2026-09.json https://cdn.kleros.link/ipfs/<cid>/snapshot-2026-09.json`. Once every
check has passed, it prints, for each week that isn't seeded yet, the seeding transaction the way the
hardware wallet will show it. Given only one chain's file, it says it couldn't check the split
between the chains, and it refuses two files of the same chain and period.

### Signing

The seeding transactions are what make a drop permanent. Each one is built from the run's output and
checked on the hardware wallet against a block computed independently, on another machine:

1. Someone other than the person who ran `cli.js` checks out a reviewed commit of `master` on their
   own machine, downloads the files from IPFS, runs `verify-snapshot.js` on them with their own RPC
   URLs, and sends the signer the block it prints for each unseeded week, over a different channel
   from the one the IPFS links came through.
2. The signer runs, from `snapshots/`, the commands `cli.js` printed. The first loads the chain's RPC
   URL from `.env` without running `.env` as a script. `cast chain-id` has to print the chain's ID,
   because `cast call` against the wrong chain can print `0x` too. `cast call` simulates the
   transaction as the owner and has to print `0x`, which needs the owner to hold the month's tokens.
   Then `cast send` signs it on the owner's Trezor; cast refuses to sign from any account other than
   the owner. If the owner isn't the device's first account, add `--mnemonic-index <n>`. With a Ledger
   instead, replace `--trezor` with `--ledger` (for a legacy-path Ledger account, use
   `--hd-path "m/44'/60'/0'/<n>"`, in quotes, instead of `--mnemonic-index`). For a key in an
   encrypted keystore, use `--account <name>`, never `--private-key`. A key that lives only in a
   browser wallet can't sign with cast.
3. On the device, every value is checked against the block from step 1, not against the one `cli.js`
   printed: the To address and the data. On the Trezor, "View data and hash" shows the 100 bytes of
   data, and on a Safe 5 or Safe 7 their ERC-8213 digest; on other models, compare the whole data. A
   Trezor shows neither the sending account nor the network: `--from` and `--chain` in the command,
   and the `cast chain-id` step, take care of those. A Ledger, with Blind signing and Debug contracts
   on, also shows the From address, names the network for Gnosis, and shows the selector `4CD488AB`
   and each parameter, to compare group by group. Any difference means rejecting the transaction.

This catches a web page, browser extension or laptop that changes the transaction between the files
and the device, and a file edited after the run. It can't catch a file that is wrong from the start
but consistent with itself: the second person checks that the files are what gets signed, not that
the drop is right.

## Tests

```sh
yarn test        # offline, a few seconds: what the run itself runs first
yarn test:live   # reads the chains through the RPC URLs in .env, about 20 seconds
```

- `test/golden.test.js` regenerates the August 2026 drop from the stake events the subgraph served for
  it, served in the same scrambled order, and requires the published snapshots, byte for byte, along
  with the reward that produced them. The inputs are in `test/fixtures/golden-2026-08.json`, recorded
  by `test/fixtures/generate-golden.js`. `test/subgraph-events.test.js` checks that a stake history
  is refused while the subgraph lags behind the period or reports indexing errors.
- `test/stake-averaging.test.js`, `test/reward.test.js` and `test/merkle.test.js` pin the averaging,
  the formula and the merkle tree, the last one against the contract's own leaf and proof rules.
- `test/config.test.js` pins `KIP_86_EXCLUDED_ADDRESSES` to the list in the KIP. Changing it takes a
  KIP, and means changing the test too, citing it.
- `test/kip86-helpers.test.js` runs the exclusion helpers against fake contracts that only answer at
  the pinned block, and `test/invariants.test.js` makes the run's checks stop, except five guards no
  test reaches yet: a zero total or per-juror average stake, a malformed proof, an
  `averageTotalStaked` that isn't the sum of the claims' stakes, and a short Multicall3 answer. Two
  more, claims adding up to more than the drop and more than a wei of dust per claim, can't fail
  once the per-claim checks before them pass; they stay as a backstop.
- `test/seeding.test.js` pins the seeding commands and every device line to the September 2026
  seeding; `test/redact.test.js` checks that errors print without the API keys, and
  `test/self-test.test.js` that none of them reaches the suite.
- `test/live` reads the September 2026 exclusions at that period's blocks, where they can't change
  any more. It reads them from every source that held PNK at those blocks, so dropping one of those
  from the configuration fails it; a contract that held none can still be dropped unnoticed. It also
  checks the August 2026 claims against the deployed MerkleRedeem contracts, on their own week and
  through the state override on a week that will never be seeded, and that the contracts are still
  owned by the account the signing commands sign from.

## Implementation Details

The algorithm to generate the average stakes for the period requires the events being associated with a timestamp.

Unfortunately neither `ethers.js` or `web3.js` returns that information when querying for events.

This requires querying the block info for each block which had a `StakeSet` event emitted, which is **A LOT**.
When querying data from the free providers, we are subject to throttling, which would cause a big delay on the execution.

To prevent this issue we introduced a local `.cache` directory which hosts a `leveldb` instance with the metadata for the blocks.

**IMPORTANT:** Notice that this directory is not in version control, so if you are running a fresh script, it might take a while to run.

For more info on the block downloading, please use the `NODE_DEBUG` env var to see some outputs on the screen:

```
NODE_DEBUG=blocks node cli.js
```

## Rationale

The total stake for a juror is a discrete function of the time as represented below:

       A
       |            .                                                               .
       |            .                                                               .
       |            .                              +- Event                         .
     T |            .                              |                                .
     o |            .                              v                                .
     t |            .                              o                                .
     a |            .                                                               .
     l |            .                                                               .
       |   o        .                                                               .
     S |            .                                                               .
     t |            .                                                               .
     a |            .                                                               .
     k |            .        o                                                      .
     e |            .                                                               .
     d |            .                                                               .
       |            .                                                     o         .
       |            .                                                               .
       +------------+---------------------------------------------------------------+--->
                    .                  Time                                         .
               Start Date                                                        End Date

For this specific case, each point represents a `StakeSet` event.

In order to get the average amount of tokens staked between Start Date and End Date,
we need to transform the discrete function above into a step function like this:

       A
       |            .                                                               .
       |            .                                                               .
       |            .                                                               .
     T |            .                                                               .
     o |            .                                                               .
     t |            .                              o----------------------+         .
     a |            .                                                               .
     l |            .                                                               .
       |   o--------.--------+                                                      .
     S |            .                                                               .
     t |            .                                                               .
     a |            .                                                               .
     k |            .        o---------------------+                                .
     e |            .                                                               .
     d |            .                                                               .
       |            .                                                     o---------.-----
       |            .                                                               .
       +------------+---------------------------------------------------------------+--->
                    .                  Time                                         .
               Start Date                                                        End Date

For the beginning of the interval, we must take the value of the last event **before**
and make the function assume its value from Start Date until the next event within the

For the end of the interval, we must take the value of the last event within the inter
and make the function assume its value from that point until End Date.

Then we calculate the average of the values (heights) of the steps weighted by their duration (widths).
It's important however be careful with the widths at the edge of the interval, as the step should be "clamped".

### Special cases:

1. There are no events before Start Date:

   ```
      A
      |            .                                                               .
      |            .                                                               .
      |            .                              +- Event                         .
    T |            .                              |                                .
    o |            .                              v                                .
    t |            .                              o----------------------+         .
    a |            .                                                               .
    l |            .                                                               .
      |            .                                                               .
    S |            .                                                               .
    t |            .                                                               .
    a |            .                                                               .
    k |            .        o---------------------+                                .
    e |            .                                                               .
    d |            .   +- Assume value zero until the first event                  .
      |            .   |                                                 o---------.-----
      |            .   v                                                           .
      +------------+........+------------------------------------------------------+--->
                   .                  Time                                         .
              Start Date                                                        End Date
   ```

2. There are no events within the interval, but there it:

   ```
      A
      |            .                                                               .
      |            .                                                               .
      |            .                                                               .
    T |            .                                                               .
    o |            .                                                               .
    t |            .       +- Assume a constant value for the period               .
    a |            .       |                                                       .
    l |            .       v                                                       .
      |   o--------.---------------------------------------------------------------.---
    S |            .                                                               .
    t |            .                                                               .
    a |            .                                                               .
    k |            .                                                               .
    e |            .                                                               .
    d |            .                                                               .
      |            .                                                               .
      |            .                                                               .
      +------------+---------------------------------------------------------------+--->
                   .                  Time                                         .
              Start Date                                                        End Date
   ```

3. There are no events within the interval, neither before it:

   ```
      A
      |            .                                                               .
      |            .                                                               .
      |            .                                                               .
    T |            .                                                               .
    o |            .                                                               .
    t |            .                Event out ou the interval is not computed -----.---+
    a |            .                                                               .   |
    l |            .                                                               .   v
      |            .                                                               .   o
    S |            .                                                               .
    t |            .                                                               .
    a |            .                                                               .
    k |            .                                                               .
    e |            .                                                               .
    d |            .                                                               .
      |            .                                                               .
      |            .                                                               .
      +------------+---------------------------------------------------------------+--->
                   .                  Time                                         .
              Start Date                                                        End Date
   ```
