// SPDX-License-Identifier: MIT

/**
 * @authors: [@hbarcelos]
 * @reviewers: []
 * @auditors: []
 * @bounties: []
 * @deployments: []
 *
 */
pragma solidity ^0.7.6;
pragma abicoder v2;

import "@openzeppelin/contracts/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title Distribution of PNK as a reward for staked jurors in a recurrent fashion.
 */
contract RecurrentMerkledrop {
    /// @dev The address of owner of the contract.
    address public immutable owner = msg.sender;

    /// @dev The timestamp of the block until which users can make claims.
    uint96 public immutable claimableUntil;

    /// @dev The address of the PNK token contract. TRUSTED.
    IERC20 public immutable pnk;

    struct Claim {
        // The period the claim is related to.
        uint256 period;
        // The amount that is being claimed.
        uint256 amount;
        // The merkle proof of the amount, sorted from the leaf to the root of the tree.
        bytes32[] merkleProof;
    }

    enum ClaimStatus {
        Pending, // The claim has not been made yet.
        Done // The claim has already being made.
    }

    /// @dev The merkle roots of each period. periodToMerkleRoot[period].
    mapping(uint256 => bytes32) public periodToMerkleRoot;

    /// @dev Keeps track of the claim status for the given juror and period. claimControl[juror][period].
    mapping(address => mapping(uint256 => ClaimStatus)) public claimControl;

    /**
     * @dev To be emitted when a claim is made.
     * @param _juror The address of the juror.
     * @param _period The period of the claim.
     * @param _amount The amount being clamed.
     */
    event Claimed(address indexed _juror, uint256 indexed _period, uint256 _amount);

    /**
     * @dev To be emitted when a new clame period has been seeded.
     * @param _period The airdrop period ID.
     * @param _allocation The amount of tokens allocated for the distribution.
     * @param _merkleRoot The merkle root for that period.
     */
    event Seeded(uint256 indexed _period, uint256 _allocation, bytes32 indexed _merkleRoot);

    /**
     * @param _pnk The address of the PNK contract.
     * @param _claimDuration The duration of the distribution (in seconds).
     */
    constructor(IERC20 _pnk, uint256 _claimDuration) {
        pnk = _pnk;
        claimableUntil = uint96(block.timestamp + _claimDuration);
    }

    /**
     * @notice Makes a claim for a given juror.
     * @param _juror The address of the juror.
     * @param _claim The claim containing the period, amount and the merkle proof.
     */
    function makeClaim(address _juror, Claim calldata _claim) external {
        require(block.timestamp < claimableUntil, "Claim period expired");
        require(claimControl[_juror][_claim.period] == ClaimStatus.Pending, "Claim already done");
        require(verifyClaim(_juror, _claim), "Invalid merkle proof");

        registerClaim(_juror, _claim.period, _claim.amount);
        require(pnk.transfer(_juror, _claim.amount), "PNK transfer failed");
    }

    /**
     * @notice Makes multiple claims for a given juror.
     * @param _juror The address of the juror.
     * @param _claims An array of claims containing the period, amount and the merkle proof.
     */
    function batchMakeClaims(address _juror, Claim[] calldata _claims) external {
        require(block.timestamp < claimableUntil, "Claim period expired");

        uint256 totalAmount = 0;

        for (uint256 i = 0; i < _claims.length; i++) {
            require(claimControl[_juror][_claims[i].period] == ClaimStatus.Pending, "Claim already done");
            require(verifyClaim(_juror, _claims[i]), "Invalid merkle proof");

            totalAmount += _claims[i].amount;
            registerClaim(_juror, _claims[i].period, _claims[i].amount);
        }

        require(pnk.transfer(_juror, totalAmount), "PNK transfer failed");
    }

    /**
     * @dev Registers a claim.
     * @param _juror The address of the juror.
     * @param _period The period related to the claim.
     * @param _amount The amount claimed.
     */
    function registerClaim(
        address _juror,
        uint256 _period,
        uint256 _amount
    ) private {
        claimControl[_juror][_period] = ClaimStatus.Done;
        emit Claimed(_juror, _period, _amount);
    }

    /**
     * @dev Verifies a claim for a given juror.
     * @param _juror The address of the juror.
     * @param _claim The claim containing the period, amount and the merkle proof.
     */
    function verifyClaim(address _juror, Claim calldata _claim) private view returns (bool) {
        bytes32 leaf = keccak256(abi.encodePacked(_juror, _claim.amount));
        return MerkleProof.verify(_claim.merkleProof, periodToMerkleRoot[_claim.period], leaf);
    }

    /**
     * @notice Seeds a new round for the airdrop.
     * @dev Will transfer tokens from the owner to this contract.
     * @param _period The airdrop period ID.
     * @param _allocation The amount of tokens allocated for the distribution.
     * @param _merkleRoot The merkle root of the claims for that period.
     */
    function seed(
        uint256 _period,
        uint256 _allocation,
        bytes32 _merkleRoot
    ) external {
        require(msg.sender == owner, "Only owner allowed");
        require(periodToMerkleRoot[_period] == bytes32(0), "Period already seeded");

        periodToMerkleRoot[_period] = _merkleRoot;

        require(pnk.transferFrom(owner, address(this), _allocation), "PNK transfer failed");

        emit Seeded(_period, _allocation, _merkleRoot);
    }

    /**
     * @notice Ends the airdrop distribution and submits the remaining tokens back to the owner.
     */
    function finalize() external {
        require(msg.sender == owner, "Only owner allowed");
        require(block.timestamp < claimableUntil, "Still in progress");

        uint256 balance = pnk.balanceOf(address(this));
        require(pnk.transfer(owner, balance), "PNK transfer failed");

        // Renders the contract unusable from now on.
        owner = address(0);
    }

    /**
     * @notice Gets all merkle roots for periods `_begin` to `_end` in order.
     * @param _begin The period ID to start with (inclusive).
     * @param _end The period ID to end with (inclusive).
     */
    function merkleRoots(uint256 _begin, uint256 _end) external view returns (bytes32[] memory) {
        uint256 size = 1 + _end - _begin;
        bytes32[] memory arr = new bytes32[](size);

        for (uint256 i = 0; i < size; i++) {
            arr[i] = weekMerkleRoots[_begin + i];
        }

        return arr;
    }
}
