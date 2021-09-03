#!/bin/bash
# npx hardhat flatten src/MerkleRedeem.sol 2> /dev/null | awk '/SPDX-License-Identifier/&&c++>0 {next} 1' | awk '/pragma experimental ABIEncoderV2;/&&c++>0 {next} 1'
npx hardhat flatten src/MerkleRedeem.sol 2> /dev/null
