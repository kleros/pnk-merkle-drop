# PNK Merkle Drop Contracts

Smart Contracts to manage and redeem PNK airdrops.

## Deployments

- `kovan`: [deployment](./deployments/kovan/MerkleRedeem.json#L2)
- `mainnet`: [deployment](./deployments/mainnet/MerkleRedeem.json#L2)

## Usage

### 0. Generate the Snapshot

To generate the snapshot for the current `period`, please follow the instructions on the `snapshots` package [README](../snapshots/README.md).

The file can be found at:
```
https://pnk-airdrop-snapshots.s3.us-east-2.amazonaws.com/snapshot-{{period}}.json
```

Where `{{period}}` is the numeric sequential number of the distribution, starting from `1`.

### 1. Fund the Deployer Wallet

Send to the deployer account (`0x76BFB6AE7463f5c0Aad6DFeaF360EB2e0e0Bdc83`) the amount of PNK being allocated for the current `period`.

### 2. Seed the Allocation

Once you got the snapshot JSON file stored, you will need to get the following values from there:

- `merkleTree.root`: This is the root of the merkle tree.
- `droppedAmount`: The amount allocated for this round of the airdrop.

Then you need to submit the following transaction:

```solidity
seedAllocations(period, merkleRoot, droppedAmount)
```

from the deployer account.

If you don't have the private key for that account, ask Annabele or @hbarcelos for it and import it to your wallet.

**NOTICE:** after this transaction is mined, the PNK balance is transfered from the deployer account to the contract.

### 3. Claim the Rewards

In order to claim the rewards, one need to provide :

- `{{address}}`: The address of the juror (`string`).
- `{{period}}`: The period of the claim (`number`).

and also the following data from the snapshot file:

- `merkleTree.claims[{{address}}].value`: The amount being claimed (`number`)
- `merkleTree.claims[{{address}}].proof`: The merkle proof for that claim (`string[]`)
