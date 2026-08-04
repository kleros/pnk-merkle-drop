# PNK Airdrop Snapshot Generator

This utility generates a snapshot for the PNK Airdrop and uploads it to S3.

The file will be put into the `pnk-airdrop-snapshots` bucket, which is public for readers.

The URL will have the following template:
```
https://pnk-airdrop-snapshots.s3.us-east-2.amazonaws.com/snapshot-{{period}}.json
```

Where `{{period}}` is the ID of the period of the distribution.

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
accidentally running twice in the same month would regenerate the period from live balances and
overwrite the published S3 snapshot with different amounts than the ones already seeded on-chain.
To catch this, the run aborts if the index already lists a snapshot of the period it is about to
generate, for any chain. To bypass the check (e.g. redoing a bad run on purpose):

```sh
node cli.js --force
```

The check can only see snapshots that have reached the index, so it protects against re-running an
already disbursed month — not against back-to-back runs before the kleros/court PR is merged.

## Usage

```
Usage: cli.js --amount={n} --period={n} --kleros-liquid-address={s} --chain-id={n} --start-date={YYYY-MM-DD} --end-date={YYYY-MM-DD}

Options:
      --amount                 The amount of tokens being distributed [required]
      --period                 The numeric period ID of the distribution
                                                                      [required]
      --start-date             The start date (inclusive) to start collecting the balances [YYYY-MM-DD]                            [required]
      --end-date               The end date (exclusive) to stop collecting the balances [YYYY-MM-DD]                               [required]
      --kleros-liquid-address  The KlerosLiquid address      [string] [required]
      --chain-id               The chain ID as a decimal number       [required]
      --save-s3                Submit the snapshot to the S3 bucket
                                                                [default: false]
      --save-ipfs              Submit the snapshot to IPFS      [default: false]
      --save-local             Save the snapshot to a local file inside .cache
                                                                 [default: true]
      --from-block             The block to start querying events from  [number]
      --to-block               The block to end the query for events    [number]
      --infura-api-key         The Infura API key                       [string]
      --etherscan-api-key      The Etherscan API key                    [string]
      --alchemy-api-key        The Alchemy API key                      [string]
  -h, --help                   Show help                               [boolean]
  -V, --version                Show version number                     [boolean]

Alternatively you can set the same params in the .env file. Check .env.example.
```

Some of those CLI params are better stored as environment variables in the `.env` file:

```sh
PNK_DROP_CHAIN_ID=1
PNK_DROP_KLEROS_LIQUID_ADDRESS=0x988b3a538b618c7a603e1c11ab82cd16dbe28069
PNK_DROP_FROM_BLOCK=7303699
# 1MM tokens per month
PNK_DROP_AMOUNT=1000000
```

By doing so the invocation of this tool is simplified to:

```
<command> --period=1 --start-date=2021-01-01 --end-date=2021-01-31
```

## Implementation Details

The algorithm to generate the average stakes for the period requires the events being associated with a timestamp.

Unfortunately neither `ethers.js` or `web3.js` returns that information when querying for events.

This requires querying the block info for each block which had a `StakeSet` event emitted, which is **A LOT**.
When querying data from the free providers, we are subject to throttling, which would cause a big delay on the execution.

To prevent this issue we introduced a local `.cache` directory which hosts a `leveldb` instance with the metadata for the blocks.

**IMPORTANT:** Notice that this directory is not in version control, so if you are running a fresh script, it might take a while to run.

For more info on the block downloading, please use the `NODE_DEBUG` env var to see some outputs on the screen:

```
NODE_DEBUG=blocks <command> ...args
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
