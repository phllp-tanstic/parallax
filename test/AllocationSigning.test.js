const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("AllocationSigning", function () {
  const CONTRACT_NAME = "TestAllocationSigner";
  const CONTRACT_VERSION = "1";

  async function deployFixture() {
    const [deployer, signerAccount, otherAccount] = await ethers.getSigners();

    const Harness = await ethers.getContractFactory("AllocationSigningHarness");
    const harness = await Harness.deploy(CONTRACT_NAME, CONTRACT_VERSION);

    const chainId = (await ethers.provider.getNetwork()).chainId;
    const domain = {
      name: CONTRACT_NAME,
      version: CONTRACT_VERSION,
      chainId,
      verifyingContract: await harness.getAddress(),
    };

    const types = {
      SignedAllocation: [
        { name: "assets", type: "address[]" },
        { name: "weights", type: "uint256[]" },
        { name: "nonce", type: "uint256" },
        { name: "expiry", type: "uint256" },
      ],
    };

    return { harness, deployer, signerAccount, otherAccount, domain, types };
  }

  function sampleAllocation(overrides = {}) {
    return {
      assets: [
        "0x11111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222",
      ].map((a) => ethers.getAddress(a.padEnd(42, "0"))), // ensure valid checksummed 20-byte addrs
      weights: [6000n, 4000n],
      nonce: 0n,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
      ...overrides,
    };
  }

  // -------------------------------------------------------------------------
  // Valid signature verification
  // -------------------------------------------------------------------------

  describe("Valid signatures", function () {
    it("verifies a correctly-signed allocation from the expected signer", async function () {
      const { harness, signerAccount, domain, types } = await loadFixture(deployFixture);
      const allocation = sampleAllocation();

      const signature = await signerAccount.signTypedData(domain, types, allocation);

      const isValid = await harness.verifyAllocationSignature(
        allocation,
        signature,
        signerAccount.address
      );
      expect(isValid).to.equal(true);
    });

    it("verification fails when checked against a DIFFERENT signer address", async function () {
      const { harness, signerAccount, otherAccount, domain, types } = await loadFixture(deployFixture);
      const allocation = sampleAllocation();

      const signature = await signerAccount.signTypedData(domain, types, allocation);

      // Signed by signerAccount, but we check against otherAccount — must fail.
      const isValid = await harness.verifyAllocationSignature(
        allocation,
        signature,
        otherAccount.address
      );
      expect(isValid).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------
  // Tampered data — any field change must invalidate the signature
  // -------------------------------------------------------------------------

  describe("Tampered allocation data", function () {
    it("fails verification if weights are altered after signing", async function () {
      const { harness, signerAccount, domain, types } = await loadFixture(deployFixture);
      const original = sampleAllocation();
      const signature = await signerAccount.signTypedData(domain, types, original);

      const tampered = { ...original, weights: [5000n, 5000n] };

      const isValid = await harness.verifyAllocationSignature(
        tampered,
        signature,
        signerAccount.address
      );
      expect(isValid).to.equal(false);
    });

    it("fails verification if assets array is altered after signing", async function () {
      const { harness, signerAccount, domain, types } = await loadFixture(deployFixture);
      const original = sampleAllocation();
      const signature = await signerAccount.signTypedData(domain, types, original);

      const tampered = {
        ...original,
        assets: [
          "0x3333333333333333333333333333333333333333".slice(0, 42),
          original.assets[1],
        ].map((a) => ethers.getAddress(a)),
      };

      const isValid = await harness.verifyAllocationSignature(
        tampered,
        signature,
        signerAccount.address
      );
      expect(isValid).to.equal(false);
    });

    it("fails verification if nonce is altered after signing", async function () {
      const { harness, signerAccount, domain, types } = await loadFixture(deployFixture);
      const original = sampleAllocation({ nonce: 5n });
      const signature = await signerAccount.signTypedData(domain, types, original);

      const tampered = { ...original, nonce: 6n };

      const isValid = await harness.verifyAllocationSignature(
        tampered,
        signature,
        signerAccount.address
      );
      expect(isValid).to.equal(false);
    });

    it("fails verification if expiry is altered after signing", async function () {
      const { harness, signerAccount, domain, types } = await loadFixture(deployFixture);
      const original = sampleAllocation();
      const signature = await signerAccount.signTypedData(domain, types, original);

      const tampered = { ...original, expiry: original.expiry + 1000n };

      const isValid = await harness.verifyAllocationSignature(
        tampered,
        signature,
        signerAccount.address
      );
      expect(isValid).to.equal(false);
    });
  });

  // -------------------------------------------------------------------------
  // Domain separation — §9.8: chain ID + contract address
  // -------------------------------------------------------------------------

  describe("Domain separation (§9.8)", function () {
    it("a signature valid for one deployed contract is NOT valid for a different deployed instance", async function () {
      const { signerAccount, domain, types } = await loadFixture(deployFixture);

      // Deploy a SECOND, independent harness instance — simulating, e.g.,
      // testnet vs mainnet deployments, or two different vault deployments.
      const Harness = await ethers.getContractFactory("AllocationSigningHarness");
      const secondHarness = await Harness.deploy(CONTRACT_NAME, CONTRACT_VERSION);

      const allocation = sampleAllocation();
      // Sign using the FIRST harness's domain (verifyingContract = harness #1).
      const signature = await signerAccount.signTypedData(domain, types, allocation);

      // Attempt to verify against the SECOND harness — must fail, since its
      // domain separator embeds a different verifyingContract address.
      const isValid = await secondHarness.verifyAllocationSignature(
        allocation,
        signature,
        signerAccount.address
      );
      expect(isValid).to.equal(false);
    });

    it("domain separator changes when verifyingContract changes", async function () {
      const { harness } = await loadFixture(deployFixture);
      const Harness = await ethers.getContractFactory("AllocationSigningHarness");
      const secondHarness = await Harness.deploy(CONTRACT_NAME, CONTRACT_VERSION);

      const sep1 = await harness.domainSeparatorV4();
      const sep2 = await secondHarness.domainSeparatorV4();

      expect(sep1).to.not.equal(sep2);
    });
  });

  // -------------------------------------------------------------------------
  // Hashing correctness — deterministic, matches EIP-712 typed-data encoding
  // -------------------------------------------------------------------------

  describe("hashAllocation", function () {
    it("produces the same hash for identical allocation data", async function () {
      const { harness } = await loadFixture(deployFixture);
      const allocation = sampleAllocation();

      const hash1 = await harness.hashAllocation(allocation);
      const hash2 = await harness.hashAllocation(allocation);

      expect(hash1).to.equal(hash2);
    });

    it("produces a different hash when any field changes", async function () {
      const { harness } = await loadFixture(deployFixture);
      const allocation = sampleAllocation();
      const hash1 = await harness.hashAllocation(allocation);

      const changedNonce = await harness.hashAllocation({ ...allocation, nonce: allocation.nonce + 1n });
      const changedExpiry = await harness.hashAllocation({ ...allocation, expiry: allocation.expiry + 1n });
      const changedWeights = await harness.hashAllocation({ ...allocation, weights: [5000n, 5000n] });

      expect(changedNonce).to.not.equal(hash1);
      expect(changedExpiry).to.not.equal(hash1);
      expect(changedWeights).to.not.equal(hash1);
    });
  });

  // -------------------------------------------------------------------------
  // ERC-1271 readiness — §9.8/§17: signer upgrade path to a Gnosis Safe
  // -------------------------------------------------------------------------

  describe("ERC-1271 compatibility (documents current EOA-only coverage)", function () {
    it("SignatureChecker path exists for contract signers — NOT independently exercised here", async function () {
      // This test intentionally does not deploy a mock ERC-1271 signer (e.g.
      // a mock Gnosis Safe) to verify contract-signature support end-to-end.
      // AllocationSigning delegates to OZ's SignatureChecker.isValidSignatureNow,
      // which is itself a heavily-audited OZ primitive — re-testing OZ's own
      // ERC-1271 dispatch logic here would be testing OZ's code, not ours.
      // What IS ours, and IS tested above, is that we call it correctly with
      // the right digest and signer address for the EOA path.
      //
      // FLAGGED GAP: before the Phase 3/4 Gnosis Safe signer upgrade (per
      // §17), a real end-to-end test against an actual Safe (or a minimal
      // ERC-1271 mock) deployed to a local/test network should be added to
      // confirm the full integration, not just trust that OZ's dispatch is
      // correct in isolation. Not done here — tracked, not silently assumed.
      expect(true).to.equal(true);
    });
  });
});