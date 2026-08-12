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
yarn install           # at the repo root
cd snapshots
cp .env.example .env   # then fill in the Alchemy RPC URLs and the Filebase token
```

All three `ALCHEMY_*` RPC URLs are needed: Mainnet and Gnosis for the snapshots themselves, and
Arbitrum for the KIP-86 supply exclusions. `FILEBASE_TOKEN` is used to pin the snapshots to IPFS
at the end of the run. The `SUBGRAPH_*` URLs, used to query juror stakes, come pre-filled in
`.env.example` and only need touching if those subgraph deployments move.

The monthly run is then, from inside this `snapshots/` directory:

```sh
node cli.js
```

That is the whole thing — no arguments needed. The period is derived from the calendar (running
any time during August, in UTC, generates the July drop), the amount to compound on is read back
from the previous period's published snapshots, and the reward formula does the rest. The output
ends with the IPFS URLs and pre-filled transaction links covered in [After the run](#after-the-run).

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
                published. The re-run would read live balances, so the
                amounts will differ from the published ones.
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

The adjusted supply is the PNK total supply minus the Kleros Cooperative's holdings — wallets, LP
positions and unvested Sablier streams across Mainnet, Gnosis and Arbitrum — per
[KIP-86](https://forum.kleros.io/t/kip-86-exclude-pnk-held-by-the-kleros-cooperative-from-kip-66/1423).
The run prints the excluded total with a reminder to cross-check it against the Cooperative's
[DeBank bundle](https://debank.com/bundles/69929/portfolio).

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

## Re-run protection

A run only decides *when* it happens — the period it generates is derived from the calendar, so
accidentally running twice in the same month would regenerate the period from live balances, with
different amounts than the ones already published and seeded on-chain.
To catch this, the run aborts if the index already lists a snapshot of the period it is about to
generate, for any chain. To bypass the check (e.g. redoing a bad run on purpose):

```sh
node cli.js --force
```

The check can only see snapshots that have reached the index, so it protects against re-running an
already disbursed month — not against back-to-back runs before the kleros/court PR is merged.

## After the run

The run ends with everything needed to make the drop claimable:

1. **Seed the drops on-chain**, following the printed execution steps in order: seed the Mainnet
   merkle drop contract, bridge Gnosis's share via the
   [Gnosis bridge](https://bridge.gnosischain.com/), wrap it xPNK → stPNK on
   [court.kleros.io](https://court.kleros.io), and seed the Gnosis merkle drop contract. The
   printed links are pre-filled transactions carrying the merkle roots and amounts of the
   snapshots just generated; the PNK (Mainnet) and stPNK (Gnosis) allowances for the merkle drop
   contracts must already be in place.
2. **Open a PR to [kleros/court](https://github.com/kleros/court)** adding the printed IPFS URLs
   to `public/snapshots.json`. Jurors cannot claim until it is merged — and neither the automatic
   `--lastamount` lookup nor the re-run protection can see the period until then, so don't leave
   it for later.

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
