// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AllocationSigning} from "../libraries/AllocationSigning.sol";

/// @notice Test harness exposing AllocationSigning's internal functions
///         externally, and its EIP-712 domain separator for off-chain
///         signature construction in tests. No production role.
contract AllocationSigningHarness is AllocationSigning {
    constructor(string memory name, string memory version) AllocationSigning(name, version) {}

    function hashAllocation(SignedAllocation memory allocation) external view returns (bytes32) {
        return _hashAllocation(allocation);
    }

    function verifyAllocationSignature(
        SignedAllocation memory allocation,
        bytes memory signature,
        address signer
    ) external view returns (bool) {
        return _verifyAllocationSignature(allocation, signature, signer);
    }

    /// @notice Exposes the EIP-712 domain separator so JS tests can construct
    ///         valid signatures off-chain using ethers' _signTypedData, which
    ///         needs to independently derive/match the same domain.
    function domainSeparatorV4() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}