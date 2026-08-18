const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("RiskLegManager — rebalance decision layer (§9.3/§9.5/§9.6/§9.8)", function () {
  const CONTRACT_NAME = "ParallaxRiskLegManager";
  const CONTRACT_VERSION = "1";
  const AssetClass = { NONE: 0, CRYPTO: 1, EQUITY: 2 };

  function makeAddress(seed) {
    return ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(seed), 20));
  }

  async function deployFixture() {
    const [owner, riskServiceSigner, otherSigner, vaultSigner] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    const RiskLegManager = await ethers.getContractFactory("RiskLegManager");
    const manager = await RiskLegManager.deploy(await usdc.getAddress());

    await manager.connect(owner).setVault(vaultSigner.address);
    await manager.connect(owner).setRiskServiceSigner(riskServiceSigner.address);

    const btc = makeAddress(1);
    const eth = makeAddress(2);
    const nvda = makeAddress(3);
    const spy = makeAddress(4);

    await manager.connect(owner).configureAsset(btc, true, AssetClass.CRYPTO);
    await manager.connect(owner).configureAsset(eth, true, AssetClass.CRYPTO);
    await manager.connect(owner).configureAsset(nvda, true, AssetClass.EQUITY);
    await manager.connect(owner).configureAsset(spy, true, AssetClass.EQUITY);

    const chainId = (await ethers.provider.getNetwork()).chainId;
    const domain = {
      name: CONTRACT_NAME,
      version: CONTRACT_VERSION,
      chainId,
      verifyingContract: await manager.getAddress(),
    };
    const types = {
      SignedAllocation: [
        { name: "assets", type: "address[]" },
        { name: "weights", type: "uint256[]" },
        { name: "nonce", type: "uint256" },
        { name: "expiry", type: "uint256" },
      ],
    };

    return {
      manager, usdc, owner, riskServiceSigner, otherSigner, vaultSigner,
      btc, eth, nvda, spy, domain, types,
    };
  }

  async function futureExpiry(offsetSeconds = 3600) {
    const latest = await time.latest();
    return BigInt(latest + offsetSeconds);
  }

  async function signAllocation(signer, domain, types, allocation) {
    return signer.signTypedData(domain, types, allocation);
  }

  describe("configureAsset", function () {
    it("only owner can configure an asset", async function () {
      const { manager, otherSigner, btc } = await loadFixture(deployFixture);
      await expect(
        manager.connect(otherSigner).configureAsset(btc, true, AssetClass.CRYPTO)
      ).to.be.revertedWithCustomError(manager, "OwnableUnauthorizedAccount");
    });

    it("emits AssetConfigured with correct values", async function () {
      const { manager, owner } = await loadFixture(deployFixture);
      const newAsset = makeAddress(999);
      await expect(manager.connect(owner).configureAsset(newAsset, true, AssetClass.EQUITY))
        .to.emit(manager, "AssetConfigured")
        .withArgs(newAsset, true, AssetClass.EQUITY);
    });

    it("can de-whitelist a previously whitelisted asset", async function () {
      const { manager, owner, btc } = await loadFixture(deployFixture);
      await manager.connect(owner).configureAsset(btc, false, AssetClass.CRYPTO);
      expect(await manager.assetWhitelisted(btc)).to.equal(false);
    });
  });

  describe("setRiskServiceSigner", function () {
    it("only owner can set the signer", async function () {
      const { manager, otherSigner } = await loadFixture(deployFixture);
      await expect(
        manager.connect(otherSigner).setRiskServiceSigner(otherSigner.address)
      ).to.be.revertedWithCustomError(manager, "OwnableUnauthorizedAccount");
    });

    it("emits RiskServiceSignerUpdated", async function () {
      const { manager, owner, riskServiceSigner, otherSigner } = await loadFixture(deployFixture);
      await expect(manager.connect(owner).setRiskServiceSigner(otherSigner.address))
        .to.emit(manager, "RiskServiceSignerUpdated")
        .withArgs(riskServiceSigner.address, otherSigner.address);
    });
  });

  describe("submitRebalanceTarget — signature and bounds verification", function () {
    it("accepts a validly-signed, in-bounds allocation from the correct signer (bootstrap)", async function () {
      const { manager, riskServiceSigner, btc, nvda, domain, types } = await loadFixture(deployFixture);

      const allocation = { assets: [btc, nvda], weights: [4000n, 6000n], nonce: 0n, expiry: await futureExpiry() };
      const signature = await signAllocation(riskServiceSigner, domain, types, allocation);

      await expect(manager.submitRebalanceTarget(allocation, signature)).to.not.be.reverted;
      expect(await manager.allocationNonce()).to.equal(1n);
    });

    it("rejects a signature from a non-authorized signer", async function () {
      const { manager, otherSigner, btc, nvda, domain, types } = await loadFixture(deployFixture);
      const allocation = { assets: [btc, nvda], weights: [4000n, 6000n], nonce: 0n, expiry: await futureExpiry() };
      const signature = await signAllocation(otherSigner, domain, types, allocation);

      await expect(manager.submitRebalanceTarget(allocation, signature)).to.be.revertedWithCustomError(
        manager, "InvalidSignature"
      );
    });

    it("rejects a valid signature if the allocation payload is tampered after signing", async function () {
      const { manager, riskServiceSigner, btc, nvda, domain, types } = await loadFixture(deployFixture);
      const original = { assets: [btc, nvda], weights: [4000n, 6000n], nonce: 0n, expiry: await futureExpiry() };
      const signature = await signAllocation(riskServiceSigner, domain, types, original);
      const tampered = { ...original, weights: [3000n, 7000n] };

      await expect(manager.submitRebalanceTarget(tampered, signature)).to.be.revertedWithCustomError(
        manager, "InvalidSignature"
      );
    });

    it("rejects an expired allocation", async function () {
      const { manager, riskServiceSigner, btc, nvda, domain, types } = await loadFixture(deployFixture);
      const allocation = { assets: [btc, nvda], weights: [4000n, 6000n], nonce: 0n, expiry: 1n };
      const signature = await signAllocation(riskServiceSigner, domain, types, allocation);

      await expect(manager.submitRebalanceTarget(allocation, signature)).to.be.revertedWithCustomError(
        manager, "ExpiredAllocation"
      );
    });

    it("rejects a nonce that doesn't match the expected next value", async function () {
      const { manager, riskServiceSigner, btc, nvda, domain, types } = await loadFixture(deployFixture);
      const allocation = { assets: [btc, nvda], weights: [4000n, 6000n], nonce: 5n, expiry: await futureExpiry() };
      const signature = await signAllocation(riskServiceSigner, domain, types, allocation);

      await expect(manager.submitRebalanceTarget(allocation, signature)).to.be.revertedWithCustomError(
        manager, "InvalidNonce"
      );
    });

    it("rejects replay of the exact same allocation + signature after it was already consumed", async function () {
      const { manager, riskServiceSigner, btc, nvda, domain, types } = await loadFixture(deployFixture);
      const allocation = { assets: [btc, nvda], weights: [4000n, 6000n], nonce: 0n, expiry: await futureExpiry() };
      const signature = await signAllocation(riskServiceSigner, domain, types, allocation);

      await manager.submitRebalanceTarget(allocation, signature);
      await expect(manager.submitRebalanceTarget(allocation, signature)).to.be.revertedWithCustomError(
        manager, "InvalidNonce"
      );
    });

    it("rejects an allocation containing a non-whitelisted asset", async function () {
      const { manager, riskServiceSigner, btc, domain, types } = await loadFixture(deployFixture);
      const unlisted = makeAddress(666);
      const allocation = { assets: [btc, unlisted], weights: [4000n, 6000n], nonce: 0n, expiry: await futureExpiry() };
      const signature = await signAllocation(riskServiceSigner, domain, types, allocation);

      await expect(manager.submitRebalanceTarget(allocation, signature)).to.be.revertedWithCustomError(
        manager, "UnwhitelistedAsset"
      );
    });

    it("rejects an allocation where any single weight exceeds the 60% concentration cap", async function () {
      const { manager, riskServiceSigner, btc, nvda, domain, types } = await loadFixture(deployFixture);
      const allocation = { assets: [btc, nvda], weights: [6001n, 3999n], nonce: 0n, expiry: await futureExpiry() };
      const signature = await signAllocation(riskServiceSigner, domain, types, allocation);

      await expect(manager.submitRebalanceTarget(allocation, signature)).to.be.revertedWithCustomError(
        manager, "ConcentrationCapExceeded"
      );
    });

    it("rejects an allocation whose weights don't sum to 10000 bps", async function () {
      const { manager, riskServiceSigner, btc, nvda, domain, types } = await loadFixture(deployFixture);
      const allocation = { assets: [btc, nvda], weights: [4000n, 5000n], nonce: 0n, expiry: await futureExpiry() };
      const signature = await signAllocation(riskServiceSigner, domain, types, allocation);

      await expect(manager.submitRebalanceTarget(allocation, signature)).to.be.revertedWithCustomError(
        manager, "WeightsDoNotSumToOne"
      );
    });

    it("rejects an allocation where a single asset moves more than 20pp from its previous weight", async function () {
      const { manager, riskServiceSigner, btc, nvda, spy, domain, types } = await loadFixture(deployFixture);

      const first = { assets: [btc, nvda, spy], weights: [2000n, 4000n, 4000n], nonce: 0n, expiry: await futureExpiry() };
      await manager.submitRebalanceTarget(first, await signAllocation(riskServiceSigner, domain, types, first));

      // btc 20% -> 45%: a 25pp move, exceeds the cap. nvda/spy absorb the
      // rest, each moving only 12.5pp, well within bounds.
      const second = { assets: [btc, nvda, spy], weights: [4500n, 2750n, 2750n], nonce: 1n, expiry: await futureExpiry() };
      const signature = await signAllocation(riskServiceSigner, domain, types, second);

      await expect(manager.submitRebalanceTarget(second, signature)).to.be.revertedWithCustomError(
        manager, "MaxDeltaExceeded"
      );
    });

    it("accepts an allocation at exactly the 20pp delta boundary", async function () {
      const { manager, riskServiceSigner, btc, nvda, spy, domain, types } = await loadFixture(deployFixture);

      const first = { assets: [btc, nvda, spy], weights: [2000n, 4000n, 4000n], nonce: 0n, expiry: await futureExpiry() };
      await manager.submitRebalanceTarget(first, await signAllocation(riskServiceSigner, domain, types, first));

      // btc 20% -> 40%: exactly a 20pp move (boundary, must pass).
      const second = { assets: [btc, nvda, spy], weights: [4000n, 3000n, 3000n], nonce: 1n, expiry: await futureExpiry() };
      const signature = await signAllocation(riskServiceSigner, domain, types, second);

      await expect(manager.submitRebalanceTarget(second, signature)).to.not.be.reverted;
    });
  });

  describe("De-risk / re-risk classification", function () {
    it("executes IMMEDIATELY on the first-ever (bootstrap) allocation, regardless of crypto weight", async function () {
      const { manager, riskServiceSigner, btc, nvda, spy, domain, types } = await loadFixture(deployFixture);

      const first = { assets: [btc, nvda, spy], weights: [3000n, 3500n, 3500n], nonce: 0n, expiry: await futureExpiry() };
      await expect(
        manager.submitRebalanceTarget(first, await signAllocation(riskServiceSigner, domain, types, first))
      )
        .to.emit(manager, "RebalanceExecuted")
        .withArgs([btc, nvda, spy], [3000n, 3500n, 3500n], false);
    });

    it("executes IMMEDIATELY when crypto weight decreases (clear de-risk) after a prior allocation exists", async function () {
      const { manager, riskServiceSigner, btc, nvda, spy, domain, types } = await loadFixture(deployFixture);

      const first = { assets: [btc, nvda, spy], weights: [3000n, 3500n, 3500n], nonce: 0n, expiry: await futureExpiry() };
      await manager.submitRebalanceTarget(first, await signAllocation(riskServiceSigner, domain, types, first));

      // Crypto 30% -> 20%: decrease, de-risk, immediate.
      const second = { assets: [btc, nvda, spy], weights: [2000n, 4000n, 4000n], nonce: 1n, expiry: await futureExpiry() };
      await expect(
        manager.submitRebalanceTarget(second, await signAllocation(riskServiceSigner, domain, types, second))
      )
        .to.emit(manager, "RebalanceExecuted")
        .withArgs([btc, nvda, spy], [2000n, 4000n, 4000n], false);
    });

    it("does NOT execute immediately when crypto weight increases after a prior allocation exists (re-risk) — records a pending signal instead", async function () {
      const { manager, riskServiceSigner, btc, nvda, spy, domain, types } = await loadFixture(deployFixture);

      const first = { assets: [btc, nvda, spy], weights: [3000n, 3500n, 3500n], nonce: 0n, expiry: await futureExpiry() };
      await manager.submitRebalanceTarget(first, await signAllocation(riskServiceSigner, domain, types, first));

      // Crypto 30% -> 45%: increase, re-risk. Should NOT execute yet.
      const second = { assets: [btc, nvda, spy], weights: [4500n, 2750n, 2750n], nonce: 1n, expiry: await futureExpiry() };
      await expect(
        manager.submitRebalanceTarget(second, await signAllocation(riskServiceSigner, domain, types, second))
      )
        .to.emit(manager, "ReRiskSignalRecorded")
        .and.to.not.emit(manager, "RebalanceExecuted");

      const [, weights] = await manager.getCurrentAllocation();
      expect(weights).to.deep.equal([3000n, 3500n, 3500n]);

      const pending = await manager.pendingReRiskSignal();
      expect(pending.exists).to.equal(true);
    });

    it("aggregates crypto weight correctly across MULTIPLE crypto assets, not just one", async function () {
      const { manager, riskServiceSigner, btc, eth, nvda, spy, domain, types } = await loadFixture(deployFixture);

      // Baseline: btc 15% + eth 15% = 30% total crypto.
      const first = { assets: [btc, eth, nvda, spy], weights: [1500n, 1500n, 3500n, 3500n], nonce: 0n, expiry: await futureExpiry() };
      await manager.submitRebalanceTarget(first, await signAllocation(riskServiceSigner, domain, types, first));

      // New: btc 10% + eth 10% = 20% total crypto (DOWN from 30%) — total
      // crypto decreased even though both individual assets moved, so this
      // must classify as de-risk and execute immediately.
      const second = { assets: [btc, eth, nvda, spy], weights: [1000n, 1000n, 4000n, 4000n], nonce: 1n, expiry: await futureExpiry() };
      await expect(
        manager.submitRebalanceTarget(second, await signAllocation(riskServiceSigner, domain, types, second))
      )
        .to.emit(manager, "RebalanceExecuted")
        .withArgs([btc, eth, nvda, spy], [1000n, 1000n, 4000n, 4000n], false);
    });
  });

  describe("Re-risk confirmation delay (§9.6)", function () {
    async function establishBaseline(manager, riskServiceSigner, btc, nvda, spy, domain, types) {
      const baseline = { assets: [btc, nvda, spy], weights: [3000n, 3500n, 3500n], nonce: 0n, expiry: await futureExpiry() };
      await manager.submitRebalanceTarget(baseline, await signAllocation(riskServiceSigner, domain, types, baseline));
    }

    it("does not execute a re-risk signal before 5 days have passed", async function () {
      const { manager, riskServiceSigner, btc, nvda, spy, domain, types } = await loadFixture(deployFixture);
      await establishBaseline(manager, riskServiceSigner, btc, nvda, spy, domain, types);

      const reRisk = { assets: [btc, nvda, spy], weights: [4500n, 2750n, 2750n], nonce: 1n, expiry: await futureExpiry() };
      await manager.submitRebalanceTarget(reRisk, await signAllocation(riskServiceSigner, domain, types, reRisk));

      await time.increase(4 * 24 * 60 * 60);

      const secondSubmission = { ...reRisk, nonce: 2n, expiry: await futureExpiry() };
      await expect(
        manager.submitRebalanceTarget(
          secondSubmission,
          await signAllocation(riskServiceSigner, domain, types, secondSubmission)
        )
      ).to.not.emit(manager, "RebalanceExecuted");

      const pending = await manager.pendingReRiskSignal();
      expect(pending.exists).to.equal(true);
    });

    it("executes at exactly 5 days with FRESH target weights, not the stale day-1 weights", async function () {
      const { manager, riskServiceSigner, btc, nvda, spy, domain, types } = await loadFixture(deployFixture);
      await establishBaseline(manager, riskServiceSigner, btc, nvda, spy, domain, types);

      const day1 = { assets: [btc, nvda, spy], weights: [4500n, 2750n, 2750n], nonce: 1n, expiry: await futureExpiry() };
      const day1Tx = await manager.submitRebalanceTarget(day1, await signAllocation(riskServiceSigner, domain, types, day1));
      const day1Receipt = await day1Tx.wait();
      const day1Block = await ethers.provider.getBlock(day1Receipt.blockNumber);

      const fiveDays = 5 * 24 * 60 * 60;
      await time.increaseTo(day1Block.timestamp + fiveDays);

      // Day 5: fresher weights — 50% crypto, not day 1's 45%. Also exactly
      // a 20pp delta from baseline (30% -> 50%), the boundary case.
      const day5 = { assets: [btc, nvda, spy], weights: [5000n, 2500n, 2500n], nonce: 2n, expiry: await futureExpiry() };
      await expect(
        manager.submitRebalanceTarget(day5, await signAllocation(riskServiceSigner, domain, types, day5))
      )
        .to.emit(manager, "RebalanceExecuted")
        .withArgs([btc, nvda, spy], [5000n, 2500n, 2500n], true);

      const [, weights] = await manager.getCurrentAllocation();
      expect(weights).to.deep.equal([5000n, 2500n, 2500n]);

      const pending = await manager.pendingReRiskSignal();
      expect(pending.exists).to.equal(false);
    });

    it("a whipsaw (re-risk reversed to de-risk before 5 days) clears the pending signal without executing the re-risk", async function () {
      const { manager, riskServiceSigner, btc, nvda, spy, domain, types } = await loadFixture(deployFixture);
      await establishBaseline(manager, riskServiceSigner, btc, nvda, spy, domain, types);

      const day1 = { assets: [btc, nvda, spy], weights: [4500n, 2750n, 2750n], nonce: 1n, expiry: await futureExpiry() };
      await manager.submitRebalanceTarget(day1, await signAllocation(riskServiceSigner, domain, types, day1));

      let pending = await manager.pendingReRiskSignal();
      expect(pending.exists).to.equal(true);

      await time.increase(2 * 24 * 60 * 60);

      // Reverses below the baseline (30% -> 20%) — a clear de-risk relative
      // to the last EXECUTED allocation, not the pending (never-executed) one.
      const whipsaw = { assets: [btc, nvda, spy], weights: [2000n, 4000n, 4000n], nonce: 2n, expiry: await futureExpiry() };
      await expect(
        manager.submitRebalanceTarget(whipsaw, await signAllocation(riskServiceSigner, domain, types, whipsaw))
      )
        .to.emit(manager, "RebalanceExecuted")
        .withArgs([btc, nvda, spy], [2000n, 4000n, 4000n], false);

      pending = await manager.pendingReRiskSignal();
      expect(pending.exists).to.equal(false);
    });

    it("nonce still advances even while a re-risk signal is only being recorded, not executed", async function () {
      const { manager, riskServiceSigner, btc, nvda, spy, domain, types } = await loadFixture(deployFixture);
      await establishBaseline(manager, riskServiceSigner, btc, nvda, spy, domain, types);

      const reRisk = { assets: [btc, nvda, spy], weights: [4500n, 2750n, 2750n], nonce: 1n, expiry: await futureExpiry() };
      await manager.submitRebalanceTarget(reRisk, await signAllocation(riskServiceSigner, domain, types, reRisk));

      expect(await manager.allocationNonce()).to.equal(2n);
    });
  });
});
