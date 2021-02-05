// SPDX-License-Identifier: MIT

/**
 * Original code taken from: https://github.com/balancer-labs/erc20-redeemable/blob/13d478a043ec7bfce7abefe708d027dfe3e2ea84/merkle/contracts/MerkleRedeem.sol
 * Only comments were added, some variable names changed for clarity and the compiler version was upgraded to 0.7.x.
 *
 * @reviewers: [@hbarcelos]
 * @auditors: []
 * @bounties: []
 * @deployments: []
 */
pragma solidity ^0.7.6;
pragma abicoder v2;

import "@openzeppelin/contracts/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title Distribution of tokens in a recurrent fashion.
 */
contract MerkleRedeem is Ownable {
    /// @dev The address of the token being distributed.
    IERC20 public token;

    struct Claim {
        uint256 week; // The week the claim is related to.
        uint256 balance; // The amount being claimed.
        bytes32[] merkleProof; // The merkle proof for the claim, sorted from the leaf to the root of the tree.
    }

    /// @dev The merkle roots of each week. periodToMerkleRoot[week].
    mapping(uint256 => bytes32) public weekMerkleRoots;

    /// @dev Keeps track of the claim status for the given period and claimant. claimed[period][claimant].
    mapping(uint256 => mapping(address => bool)) public claimed;

    /**
     * @dev To be emitted when a claim is made.
     * @param _claimant The address of the juror.
     * @param _balance The amount being claimed.
     */
    event Claimed(address _claimant, uint256 _balance);

    /**
     * @param _token The address of the token being distributed.
     */
    constructor(IERC20 _token) {
        token = _token;
    }

    /**
     * @dev Effectively pays a claimant.
     * @param _claimant The address of the claimant.
     * @param _balance The amount being claimed.
     */
    function disburse(address _claimant, uint256 _balance) private {
        if (_balance > 0) {
            emit Claimed(_claimant, _balance);
            require(token.transfer(_claimant, _balance), "ERR_TRANSFER_FAILED");
        }
    }

    /**
     * @notice Makes a claim for a given juror in a week.
     * @param _claimant The address of the claimant.
     * @param _week The week for the claim.
     * @param _claimedBalance The amount being claimed.
     * @param _merkleProof The merkle proof for the claim, sorted from the leaf to the root of the tree.
     */
    function claimWeek(
        address _claimant,
        uint256 _week,
        uint256 _claimedBalance,
        bytes32[] memory _merkleProof
    ) public {
        require(!claimed[_week][_claimant]);
        require(verifyClaim(_claimant, _week, _claimedBalance, _merkleProof), "Incorrect merkle proof");

        claimed[_week][_claimant] = true;
        disburse(_claimant, _claimedBalance);
    }

    /**
     * @notice Makes multiple claims for a given juror.
     * @param _claimant The address of the juror.
     * @param _claims An array of claims containing the week, balance and the merkle proof.
     */
    function claimWeeks(address _claimant, Claim[] memory _claims) public {
        uint256 totalBalance = 0;
        Claim memory claim;
        for (uint256 i = 0; i < _claims.length; i++) {
            claim = _claims[i];

            require(!claimed[claim.week][_claimant]);
            require(verifyClaim(_claimant, claim.week, claim.balance, claim.merkleProof), "Incorrect merkle proof");

            totalBalance += claim.balance;
            claimed[claim.week][_claimant] = true;
        }
        disburse(_claimant, totalBalance);
    }

    /**
     * @notice Gets the claim status for given claimant from `_begin` to `_end` weeks.
     * @param _begin The week to start with (inclusive).
     * @param _end The week to end with (inclusive).
     */
    function claimStatus(
        address _claimant,
        uint256 _begin,
        uint256 _end
    ) external view returns (bool[] memory) {
        uint256 size = 1 + _end - _begin;
        bool[] memory arr = new bool[](size);
        for (uint256 i = 0; i < size; i++) {
            arr[i] = claimed[_begin + i][_claimant];
        }
        return arr;
    }

    /**
     * @notice Gets all merkle roots for from `_begin` to `_end` weeks.
     * @param _begin The week to start with (inclusive).
     * @param _end The week to end with (inclusive).
     */
    function merkleRoots(uint256 _begin, uint256 _end) external view returns (bytes32[] memory) {
        uint256 size = 1 + _end - _begin;
        bytes32[] memory arr = new bytes32[](size);
        for (uint256 i = 0; i < size; i++) {
            arr[i] = weekMerkleRoots[_begin + i];
        }
        return arr;
    }

    /**
     * @notice Verifies a claim.
     * @param _claimant The address of the claimant.
     * @param _week The week for the claim.
     * @param _claimedBalance The amount being claimed.
     * @param _merkleProof The merkle proof for the claim, sorted from the leaf to the root of the tree.
     */
    function verifyClaim(
        address _claimant,
        uint256 _week,
        uint256 _claimedBalance,
        bytes32[] memory _merkleProof
    ) public view returns (bool valid) {
        bytes32 leaf = keccak256(abi.encodePacked(_claimant, _claimedBalance));
        return MerkleProof.verify(_merkleProof, weekMerkleRoots[_week], leaf);
    }

    /**
     * @notice Seeds a new round for the airdrop.
     * @dev Will transfer tokens from the owner to this contract.
     * @param _week The airdrop week.
     * @param _merkleRoot The merkle root of the claims for that period.
     * @param _totalAllocation The amount of tokens allocated for the distribution.
     */
    function seedAllocations(
        uint256 _week,
        bytes32 _merkleRoot,
        uint256 _totalAllocation
    ) external onlyOwner {
        require(weekMerkleRoots[_week] == bytes32(0), "cannot rewrite merkle root");
        weekMerkleRoots[_week] = _merkleRoot;

        require(token.transferFrom(msg.sender, address(this), _totalAllocation), "ERR_TRANSFER_FAILED");
    }
}
