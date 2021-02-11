# PNK Airdrop Snapshot Generator

This utility generates a snapshot for the PNK Airdrop and uploads it to S3.

The file will be put into the `pnk-airdrop-snapshots` buckket, which is public for readers.

The URL will have the following template:
```
https://pnk-airdrop-snapshots.s3.us-east-2.amazonaws.com/snapshot-{{period}}.json
```

Where `{{period}}` is the ID of the period of the distribution.

## Usage

```
Usage: cli.js --period={n} --start-date={YYYY-MM-DD} --end-date={YYYY-MM-DD} \
    --kleros-liquid-address={s}  --amount={n}  --chain-id={n}

Options:
    --amount                 The amount of tokens being distributed           [required]
    --period                 The numeric period ID of the distribution        [required]
    --start-date             The start date to start collecting the balances  [YYYY-MM-DD] [required]
    --end-date               The end date to stop collecting the balances     [YYYY-MM-DD]                               [required]
    --kleros-liquid-address  The KlerosLiquid address                         [string] [required]
    --chain-id               The chain ID as a decimal number                 [required]
    --save                   If false, instead of submitting the snapshot
                             to the S3 bucket, it will output the content to
                             thescreen                                        [default: true]
    --from-block             The block to start querying events from          [number]
    --to-block               The block to end the query for events            [number]
    --infura-api-key         The Infura API key                               [string]
    --etherscan-api-key      The Etherscan API key                            [string]
    --alchemy-api-key        The Alchemy API key                              [string]
    -h, --help               Show help                                        [boolean]
    -V, --version            Show version number                              [boolean]

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
