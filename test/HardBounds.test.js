const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("HardBounds", function () {
  async function deployHarnessFixture() {
    const [, assetA, assetB, assetC] = await ethers.getSigners(); // use signer
    // addresses as stand-in asset identifiers — HardBounds only cares about
    // `address`, never resolving anything by symbol, per §10.6.
    const HardBoundsHarness = await ethers.getContractFactory("HardBoundsHarness");
    const harness = await HardBoundsHarness.deploy();
    return { harness, assetA: assetA.address, assetB: assetB.address, assetC: assetC.address };
  }

  // -------------------------------------------------------------------------
  // checkNotExpired — §9.8 expiry timestamp
  // -------------------------------------------------------------------------

  describe("checkNotExpired", function () {
    it("does not revert when expiry is in the future", async function () {
      const { harness } = await loadFixture(deployHarnessFixture);
      const future = (await ethers.provider.getBlock("latest")).timestamp + 3600;
      await expect(harness.checkNotExpired(future)).to.not.be.reverted;
    });

    it("does not revert when expiry equals current block timestamp exactly", async function () {
      const { harness } = await loadFixture(deployHarnessFixture);
      // Mine a block first, then use its own timestamp — boundary case:
      // expiry == block.timestamp should PASS (only block.timestamp > expiry
      // reverts, per the strict-greater-than check in the library).
      const latest = await ethers.provider.getBlock("latest");
      const nextTimestamp = latest.timestamp + 1;
      await ethers.provider.send("evm_setNextBlockTimestamp", [nextTimestamp]);
      await ethers.provider.send("evm_mine");
      await expect(harness.checkNotExpired(nextTimestamp)).to.not.be.reverted;
    });

    it("reverts when expiry is in the past", async function () {
      const { harness } = await loadFixture(deployHarnessFixture);
      const past = 1; // unix epoch + 1 second, guaranteed in the past
      await expect(harness.checkNotExpired(past)).to.be.revertedWithCustomError(
        harness,
        "ExpiredAllocation"
      );
    });

    it("reverts when expiry is exactly one second in the past", async function () {
      const { harness } = await loadFixture(deployHarnessFixture);
      const latest = await ethers.provider.getBlock("latest");
      await expect(harness.checkNotExpired(latest.timestamp - 1)).to.be.revertedWithCustomError(
        harness,
        "ExpiredAllocation"
      );
    });
  });

  // -------------------------------------------------------------------------
  // checkNonce — §9.8 replay protection
  // -------------------------------------------------------------------------

  describe("checkNonce", function () {
    it("does not revert when nonce matches expected", async function () {
      const { harness } = await loadFixture(deployHarnessFixture);
      await expect(harness.checkNonce(5, 5)).to.not.be.reverted;
    });

    it("reverts when provided nonce is behind expected (replay attempt)", async function () {
      const { harness } = await loadFixture(deployHarnessFixture);
      await expect(harness.checkNonce(5, 4))
        .to.be.revertedWithCustomError(harness, "InvalidNonce")
        .withArgs(5, 4);
    });

    it("reverts when provided nonce skips ahead (gap not permitted)", async function () {
      const { harness } = await loadFixture(deployHarnessFixture);
      await expect(harness.checkNonce(5, 7))
        .to.be.revertedWithCustomError(harness, "InvalidNonce")
        .withArgs(5, 7);
    });

    it("handles nonce zero correctly (first-ever allocation)", async function () {
      const { harness } = await loadFixture(deployHarnessFixture);
      await expect(harness.checkNonce(0, 0)).to.not.be.reverted;
      await expect(harness.checkNonce(0, 1)).to.be.revertedWithCustomError(harness, "InvalidNonce");
    });
  });

  // -------------------------------------------------------------------------
  // checkWhitelisted — §9.8, §10.6 address-based, never symbol-resolved
  // -------------------------------------------------------------------------

  describe("checkWhitelisted", function () {
    it("does not revert for a whitelisted asset", async function () {
      const { harness, assetA } = await loadFixture(deployHarnessFixture);
      await harness.setWhitelisted(assetA, true);
      await expect(harness.checkWhitelisted(assetA)).to.not.be.reverted;
    });

    it("reverts for a non-whitelisted asset", async function () {
      const { harness, assetA } = await loadFixture(deployHarnessFixture);
      await expect(harness.checkWhitelisted(assetA))
        .to.be.revertedWithCustomError(harness, "UnwhitelistedAsset")
        .withArgs(assetA);
    });

    it("reverts for an asset removed from the whitelist after being added", async function () {
      const { harness, assetA } = await loadFixture(deployHarnessFixture);
      await harness.setWhitelisted(assetA, true);
      await harness.setWhitelisted(assetA, false);
      await expect(harness.checkWhitelisted(assetA)).to.be.revertedWithCustomError(
        harness,
        "UnwhitelistedAsset"
      );
    });

    it("does not treat a similarly-named/adjacent address as whitelisted — direct lookalike-token regression guard (§10.6)", async function () {
      const { harness, assetA, assetB } = await loadFixture(deployHarnessFixture);
      // assetA and assetB are two DISTINCT addresses (from different signers).
      // Whitelisting one must never implicitly cover the other — this is the
      // exact class of bug that would let a lookalike token slip through if
      // whitelisting were ever done by some derived/pattern-matched key
      // instead of exact address equality.
      await harness.setWhitelisted(assetA, true);
      await expect(harness.checkWhitelisted(assetB)).to.be.revertedWithCustomError(
        harness,
        "UnwhitelistedAsset"
      );
    });
  });

  // -------------------------------------------------------------------------
  // checkConcentrationCap — §9.3/§9.8, 60% max per asset
  // -------------------------------------------------------------------------

  describe("checkConcentrationCap", function () {
    it("does not revert at exactly the 60% cap", async function () {
      const { harness, assetA } = await loadFixture(deployHarnessFixture);
      const cap = await harness.maxConcentrationBps();
      await expect(harness.checkConcentrationCap(assetA, cap)).to.not.be.reverted;
    });

    it("does not revert below the cap", async function () {
      const { harness, assetA } = await loadFixture(deployHarnessFixture);
      await expect(harness.checkConcentrationCap(assetA, 100)).to.not.be.reverted;
    });

    it("reverts one basis point above the cap", async function () {
      const { harness, assetA } = await loadFixture(deployHarnessFixture);
      const cap = await harness.maxConcentrationBps();
      await expect(harness.checkConcentrationCap(assetA, cap + 1n))
        .to.be.revertedWithCustomError(harness, "ConcentrationCapExceeded")
        .withArgs(assetA, cap + 1n);
    });

    it("reverts at 100% (10000 bps)", async function () {
      const { harness, assetA } = await loadFixture(deployHarnessFixture);
      await expect(harness.checkConcentrationCap(assetA, 10_000)).to.be.revertedWithCustomError(
        harness,
        "ConcentrationCapExceeded"
      );
    });

    it("does not revert at zero weight", async function () {
      const { harness, assetA } = await loadFixture(deployHarnessFixture);
      await expect(harness.checkConcentrationCap(assetA, 0)).to.not.be.reverted;
    });
  });

  // -------------------------------------------------------------------------
  // checkMaxDelta — §9.8, 20pp max move per allocation update
  // -------------------------------------------------------------------------

  describe("checkMaxDelta", function () {
    it("does not revert at exactly the 20pp delta ceiling (increase)", async function () {
      const { harness, assetA } = await loadFixture(deployHarnessFixture);
      const maxDelta = await harness.maxDeltaBps();
      await expect(harness.checkMaxDelta(assetA, 1000, 1000n + maxDelta)).to.not.be.reverted;
    });

    it("does not revert at exactly the 20pp delta ceiling (decrease)", async function () {
      const { harness, assetA } = await loadFixture(deployHarnessFixture);
      const maxDelta = await harness.maxDeltaBps();
      await expect(harness.checkMaxDelta(assetA, 3000, 3000n - maxDelta)).to.not.be.reverted;
    });

    it("reverts one basis point above the delta ceiling (increase)", async function () {
      const { harness, assetA } = await loadFixture(deployHarnessFixture);
      const maxDelta = await harness.maxDeltaBps();
      await expect(
        harness.checkMaxDelta(assetA, 1000, 1000n + maxDelta + 1n)
      ).to.be.revertedWithCustomError(harness, "MaxDeltaExceeded");
    });

    it("reverts one basis point above the delta ceiling (decrease)", async function () {
      const { harness, assetA } = await loadFixture(deployHarnessFixture);
      const maxDelta = await harness.maxDeltaBps();
      await expect(
        harness.checkMaxDelta(assetA, 3000, 3000n - maxDelta - 1n)
      ).to.be.revertedWithCustomError(harness, "MaxDeltaExceeded");
    });

    it("does not revert when previous and new weights are identical (zero delta)", async function () {
      const { harness, assetA } = await loadFixture(deployHarnessFixture);
      await expect(harness.checkMaxDelta(assetA, 2500, 2500)).to.not.be.reverted;
    });

    it("computes delta correctly regardless of direction (symmetric abs check)", async function () {
      const { harness, assetA } = await loadFixture(deployHarnessFixture);
      const maxDelta = await harness.maxDeltaBps();
      // Confirm both orderings of the same magnitude behave identically —
      // guards against an accidental one-directional check (e.g. only
      // catching increases, not decreases, or vice versa).
      await expect(harness.checkMaxDelta(assetA, 1000, 1000n + maxDelta)).to.not.be.reverted;
      await expect(harness.checkMaxDelta(assetA, 1000n + maxDelta, 1000)).to.not.be.reverted;
    });

    it("handles a swing from 0 to the full concentration cap (60pp) correctly rejecting", async function () {
      const { harness, assetA } = await loadFixture(deployHarnessFixture);
      // 0 -> 6000 bps is a 60pp delta, well above the 20pp ceiling.
      await expect(harness.checkMaxDelta(assetA, 0, 6000)).to.be.revertedWithCustomError(
        harness,
        "MaxDeltaExceeded"
      );
    });
  });

  // -------------------------------------------------------------------------
  // checkWeightsSumToOne — §9.3, weights must sum to exactly 10000 bps
  // -------------------------------------------------------------------------

  describe("checkWeightsSumToOne", function () {
    it("does not revert when weights sum to exactly 10000", async function () {
      const { harness } = await loadFixture(deployHarnessFixture);
      await expect(harness.checkWeightsSumToOne([3000, 3000, 4000])).to.not.be.reverted;
    });

    it("does not revert for a single-asset 100% allocation", async function () {
      const { harness } = await loadFixture(deployHarnessFixture);
      await expect(harness.checkWeightsSumToOne([10_000])).to.not.be.reverted;
    });

    it("reverts when weights sum below 10000", async function () {
      const { harness } = await loadFixture(deployHarnessFixture);
      await expect(harness.checkWeightsSumToOne([3000, 3000, 3999]))
        .to.be.revertedWithCustomError(harness, "WeightsDoNotSumToOne")
        .withArgs(9999);
    });

    it("reverts when weights sum above 10000", async function () {
      const { harness } = await loadFixture(deployHarnessFixture);
      await expect(harness.checkWeightsSumToOne([3000, 3000, 4001]))
        .to.be.revertedWithCustomError(harness, "WeightsDoNotSumToOne")
        .withArgs(10_001);
    });

    it("reverts for an empty weights array (sums to zero)", async function () {
      const { harness } = await loadFixture(deployHarnessFixture);
      await expect(harness.checkWeightsSumToOne([]))
        .to.be.revertedWithCustomError(harness, "WeightsDoNotSumToOne")
        .withArgs(0);
    });

    it("does not revert for many small weights summing exactly to 10000", async function () {
      const { harness } = await loadFixture(deployHarnessFixture);
      const weights = new Array(10).fill(1000); // 10 * 1000 = 10000
      await expect(harness.checkWeightsSumToOne(weights)).to.not.be.reverted;
    });
  });

  // -------------------------------------------------------------------------
  // checkLiquidityFloor — §9.8, 10% USDC-equivalent minimum
  // -------------------------------------------------------------------------

  describe("checkLiquidityFloor", function () {
    it("does not revert at exactly the 10% floor", async function () {
      const { harness } = await loadFixture(deployHarnessFixture);
      const floor = await harness.minLiquidityFloorBps();
      await expect(harness.checkLiquidityFloor(floor)).to.not.be.reverted;
    });

    it("does not revert above the floor", async function () {
      const { harness } = await loadFixture(deployHarnessFixture);
      await expect(harness.checkLiquidityFloor(5000)).to.not.be.reverted;
    });

    it("reverts one basis point below the floor", async function () {
      const { harness } = await loadFixture(deployHarnessFixture);
      const floor = await harness.minLiquidityFloorBps();
      await expect(harness.checkLiquidityFloor(floor - 1n))
        .to.be.revertedWithCustomError(harness, "LiquidityFloorViolated")
        .withArgs(floor - 1n);
    });

    it("reverts at zero liquidity", async function () {
      const { harness } = await loadFixture(deployHarnessFixture);
      await expect(harness.checkLiquidityFloor(0)).to.be.revertedWithCustomError(
        harness,
        "LiquidityFloorViolated"
      );
    });

    it("does not revert at 100% liquidity (fully USDC, no risk-leg deployment)", async function () {
      const { harness } = await loadFixture(deployHarnessFixture);
      await expect(harness.checkLiquidityFloor(10_000)).to.not.be.reverted;
    });
  });

  // -------------------------------------------------------------------------
  // checkArrayLengthsMatch — defensive check against malformed allocations
  // -------------------------------------------------------------------------

  describe("checkArrayLengthsMatch", function () {
    it("does not revert when lengths match", async function () {
      const { harness } = await loadFixture(deployHarnessFixture);
      await expect(harness.checkArrayLengthsMatch(3, 3)).to.not.be.reverted;
    });

    it("does not revert when both lengths are zero", async function () {
      const { harness } = await loadFixture(deployHarnessFixture);
      await expect(harness.checkArrayLengthsMatch(0, 0)).to.not.be.reverted;
    });

    it("reverts when assets array is longer than weights array", async function () {
      const { harness } = await loadFixture(deployHarnessFixture);
      await expect(harness.checkArrayLengthsMatch(5, 3))
        .to.be.revertedWithCustomError(harness, "ArrayLengthMismatch")
        .withArgs(5, 3);
    });

    it("reverts when weights array is longer than assets array", async function () {
      const { harness } = await loadFixture(deployHarnessFixture);
      await expect(harness.checkArrayLengthsMatch(3, 5))
        .to.be.revertedWithCustomError(harness, "ArrayLengthMismatch")
        .withArgs(3, 5);
    });
  });

  // -------------------------------------------------------------------------
  // Fuzz-style property tests — §10.6 "fuzz test submitting out-of-bound
  // signed allocations ... confirming every one is rejected at the contract
  // level." True Solidity fuzzing needs Foundry, not available here — this
  // is a JS-driven randomized-input equivalent, exercising each bound with
  // many random values rather than a single hand-picked case.
  // -------------------------------------------------------------------------

  describe("Randomized property checks", function () {
    function randomBps(max) {
      return BigInt(Math.floor(Math.random() * (max + 1)));
    }

    it("checkConcentrationCap: every value <= cap passes, every value > cap reverts (100 random samples)", async function () {
      const { harness, assetA } = await loadFixture(deployHarnessFixture);
      const cap = await harness.maxConcentrationBps();

      for (let i = 0; i < 100; i++) {
        const weight = randomBps(10_000);
        if (weight <= cap) {
          await expect(harness.checkConcentrationCap(assetA, weight)).to.not.be.reverted;
        } else {
          await expect(
            harness.checkConcentrationCap(assetA, weight)
          ).to.be.revertedWithCustomError(harness, "ConcentrationCapExceeded");
        }
      }
    });

    it("checkMaxDelta: delta <= 20pp passes, delta > 20pp reverts, symmetric in direction (50 random samples)", async function () {
      const { harness, assetA } = await loadFixture(deployHarnessFixture);
      const maxDelta = await harness.maxDeltaBps();

      for (let i = 0; i < 50; i++) {
        const previous = randomBps(10_000);
        const next = randomBps(10_000);
        const delta = previous > next ? previous - next : next - previous;

        if (delta <= maxDelta) {
          await expect(harness.checkMaxDelta(assetA, previous, next)).to.not.be.reverted;
        } else {
          await expect(harness.checkMaxDelta(assetA, previous, next)).to.be.revertedWithCustomError(
            harness,
            "MaxDeltaExceeded"
          );
        }
      }
    });

    it("checkLiquidityFloor: value >= floor passes, value < floor reverts (100 random samples)", async function () {
      const { harness } = await loadFixture(deployHarnessFixture);
      const floor = await harness.minLiquidityFloorBps();

      for (let i = 0; i < 100; i++) {
        const value = randomBps(10_000);
        if (value >= floor) {
          await expect(harness.checkLiquidityFloor(value)).to.not.be.reverted;
        } else {
          await expect(harness.checkLiquidityFloor(value)).to.be.revertedWithCustomError(
            harness,
            "LiquidityFloorViolated"
          );
        }
      }
    });
  });
});