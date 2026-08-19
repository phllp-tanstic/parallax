// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @notice EIP-712 signed allocation scheme per docs/parallax_litepaper.md §9.8.
/// @dev Domain-separated by chain ID + contract address (via OZ's EIP712 base,
///      which derives both automatically) so a signature valid on X Layer mainnet
///      (chain 196) cannot be replayed on testnet (chain 1952) or against a
///      different deployed vault instance.
///
///      Signer verification goes through OZ's SignatureChecker, which supports
///      BOTH plain ECDSA signatures (current MVP: single EOA, §9.8) AND ERC-1271
///      contract signatures (Phase 3/4: Gnosis Safe multisig) with zero interface
///      change when the signer is upgraded from an EOA to a Safe address later —
///      see the note on RiskLegManager.setRiskServiceSigner.
abstract contract AllocationSigning is EIP712 {
    using ECDSA for bytes32;

    // keccak256("SignedAllocation(address[] assets,uint256[] weights,uint256 nonce,uint256 expiry)")
    bytes32 private constant ALLOCATION_TYPEHASH =
        keccak256(
            "SignedAllocation(address[] assets,uint256[] weights,uint256 nonce,uint256 expiry)"
        );

    struct SignedAllocation {
        address[] assets;   // must match asset_universe.yaml order exactly — validated
                             // against the on-chain address whitelist in HardBounds,
                             // never resolved by symbol (§9.8, §10.6)
        uint256[] weights;  // basis points (1e4 = 100%), sum must equal 10_000
        uint256 nonce;      // strictly increasing, replay protection (§9.8)
        uint256 expiry;     // unix timestamp; signature invalid once block.timestamp
                             // exceeds this (§9.8)
    }

    constructor(string memory name, string memory version) EIP712(name, version) {}

    /// @dev Hashes the struct per EIP-712 typed-data encoding. Array fields are
    ///      hashed via keccak256(abi.encodePacked(...)) per the EIP-712 spec for
    ///      dynamic array types within a struct.
    function _hashAllocation(SignedAllocation memory allocation)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                ALLOCATION_TYPEHASH,
                keccak256(abi.encodePacked(allocation.assets)),
                keccak256(abi.encodePacked(allocation.weights)),
                allocation.nonce,
                allocation.expiry
            )
        );
        return _hashTypedDataV4(structHash);
    }

    /// @notice Verifies a signed allocation against `signer`, supporting both EOA
    ///         (ECDSA) and contract (ERC-1271, e.g. Gnosis Safe) signers.
    /// @dev This is the single point where signer-type upgrades (EOA -> Safe) take
    ///      effect — no other code path needs to change when `signer` is later set
    ///      to a Safe address instead of an EOA.
    function _verifyAllocationSignature(
        SignedAllocation memory allocation,
        bytes memory signature,
        address signer
    ) internal view returns (bool) {
        bytes32 digest = _hashAllocation(allocation);
        return SignatureChecker.isValidSignatureNow(signer, digest, signature);
    }
}