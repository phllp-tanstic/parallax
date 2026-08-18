const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

describe("ParallaxVault", function () {
  const USDC_DECIMALS = 6;
  const usdcAmount = (n) => ethers.parseUnits(n.toString(), USDC_DECIMALS);

  const DEFAULT_DEPOSIT_CAP = usdcAmount(1_000_000);
  const DEFAULT_RATE_BPS = 500;
  const DEFAULT_MIN_DEPOSIT = usdcAmount(10);
  const DEFAULT_PENALTY_BPS = 500;

  async function deployVaultFixture() {
    const [owner, alice, bob] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", USDC_DECIMALS);

    const MockSafeLegManager = await ethers.getContractFactory("MockSafeLegManager");
    const safeLegManager = await MockSafeLegManager.deploy(await usdc.getAddress());

    const MockRiskLegManager = await ethers.getContractFactory("MockRiskLegManager");
    const riskLegManager = await MockRiskLegManager.deploy(await usdc.getAddress());

    const ParallaxVault = await ethers.getContractFactory("ParallaxVault");
    const vault = await ParallaxVault.deploy(
      await usdc.getAddress(),
      await safeLegManager.getAddress(),
      await riskLegManager.getAddress(),
      DEFAULT_DEPOSIT_CAP,
      DEFAULT_RATE_BPS,
      DEFAULT_MIN_DEPOSIT,
      DEFAULT_PENALTY_BPS
    );

    for (const user of [alice, bob]) {
      await usdc.mint(user.address, usdcAmount(1_000_000));
      await usdc.connect(user).approve(await vault.getAddress(), ethers.MaxUint256);
    }

    return { vault, usdc, safeLegManager, riskLegManager, owner, alice, bob };
  }

  describe("Deployment", function () {
    it("sets constructor parameters correctly", async function () {
      const { vault } = await loadFixture(deployVaultFixture);
      expect(await vault.depositCap()).to.equal(DEFAULT_DEPOSIT_CAP);
      expect(await vault.conservativeRateBps()).to.equal(DEFAULT_RATE_BPS);
      expect(await vault.minimumDeposit()).to.equal(DEFAULT_MIN_DEPOSIT);
      expect(await vault.earlyExitPenaltyBps()).to.equal(DEFAULT_PENALTY_BPS);
      expect(await vault.TERM_DURATION()).to.equal(365 * 24 * 60 * 60);
    });

    it("reverts if initial early exit penalty exceeds the 5000 bps ceiling", async function () {
      const { usdc, safeLegManager, riskLegManager } = await loadFixture(deployVaultFixture);
      const ParallaxVault = await ethers.getContractFactory("ParallaxVault");

      await expect(
        ParallaxVault.deploy(
          await usdc.getAddress(),
          await safeLegManager.getAddress(),
          await riskLegManager.getAddress(),
          DEFAULT_DEPOSIT_CAP,
          DEFAULT_RATE_BPS,
          DEFAULT_MIN_DEPOSIT,
          5_001
        )
      ).to.be.revertedWithCustomError(ParallaxVault, "EarlyExitPenaltyTooHigh");
    });

    it("accepts exactly the 5000 bps ceiling", async function () {
      const { usdc, safeLegManager, riskLegManager } = await loadFixture(deployVaultFixture);
      const ParallaxVault = await ethers.getContractFactory("ParallaxVault");

      const vault = await ParallaxVault.deploy(
        await usdc.getAddress(),
        await safeLegManager.getAddress(),
        await riskLegManager.getAddress(),
        DEFAULT_DEPOSIT_CAP,
        DEFAULT_RATE_BPS,
        DEFAULT_MIN_DEPOSIT,
        5_000
      );
      expect(await vault.earlyExitPenaltyBps()).to.equal(5_000);
    });
  });

  describe("issueNote", function () {
    it("reverts on zero principal", async function () {
      const { vault, alice } = await loadFixture(deployVaultFixture);
      await expect(vault.connect(alice).issueNote(0)).to.be.revertedWithCustomError(
        vault,
        "ZeroPrincipal"
      );
    });

    it("reverts when principal is below minimum deposit", async function () {
      const { vault, alice } = await loadFixture(deployVaultFixture);
      const belowMin = DEFAULT_MIN_DEPOSIT - 1n;
      await expect(vault.connect(alice).issueNote(belowMin))
        .to.be.revertedWithCustomError(vault, "BelowMinimumDeposit")
        .withArgs(belowMin, DEFAULT_MIN_DEPOSIT);
    });

    it("reverts when deposit would exceed the cap", async function () {
      const { vault, alice } = await loadFixture(deployVaultFixture);
      const overCap = DEFAULT_DEPOSIT_CAP + 1n;
      await expect(vault.connect(alice).issueNote(overCap))
        .to.be.revertedWithCustomError(vault, "DepositCapExceeded")
        .withArgs(overCap, DEFAULT_DEPOSIT_CAP);
    });

    it("reverts when paused", async function () {
      const { vault, owner, alice } = await loadFixture(deployVaultFixture);
      await vault.connect(owner).pause();
      await expect(vault.connect(alice).issueNote(usdcAmount(100))).to.be.revertedWithCustomError(
        vault,
        "EnforcedPause"
      );
    });

    it("splits principal into safe leg and risk leg per §9.1 formula", async function () {
      const { vault, alice } = await loadFixture(deployVaultFixture);
      const principal = usdcAmount(10_000);

      const tx = await vault.connect(alice).issueNote(principal);
      const receipt = await tx.wait();

      const event = receipt.logs
        .map((log) => {
          try {
            return vault.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed && parsed.name === "NoteIssued");

      expect(event).to.not.be.undefined;
      const { safeLegAmount, riskLegAmount } = event.args;

      const expectedSafeLeg = (principal * 10_000n) / (10_000n + BigInt(DEFAULT_RATE_BPS));
      expect(safeLegAmount).to.equal(expectedSafeLeg);
      expect(riskLegAmount).to.equal(principal - expectedSafeLeg);
      expect(safeLegAmount + riskLegAmount).to.equal(principal);
    });

    it("transfers principal from depositor and forwards legs to the managers", async function () {
      const { vault, usdc, safeLegManager, riskLegManager, alice } =
        await loadFixture(deployVaultFixture);
      const principal = usdcAmount(10_000);
      const aliceBalanceBefore = await usdc.balanceOf(alice.address);

      await vault.connect(alice).issueNote(principal);

      expect(await usdc.balanceOf(alice.address)).to.equal(aliceBalanceBefore - principal);
      expect(await usdc.balanceOf(await safeLegManager.getAddress())).to.be.gt(0);
      expect(await usdc.balanceOf(await riskLegManager.getAddress())).to.be.gt(0);
    });

    it("increments totalDeposited and enforces the cap across multiple deposits", async function () {
      const { vault, alice, bob } = await loadFixture(deployVaultFixture);
      const half = DEFAULT_DEPOSIT_CAP / 2n;

      await vault.connect(alice).issueNote(half);
      expect(await vault.totalDeposited()).to.equal(half);

      await vault.connect(bob).issueNote(half);
      expect(await vault.totalDeposited()).to.equal(half * 2n);

      await expect(vault.connect(alice).issueNote(DEFAULT_MIN_DEPOSIT)).to.be.revertedWithCustomError(
        vault,
        "DepositCapExceeded"
      );
    });

    it("sets maturesAt to issuedAt + TERM_DURATION and stores correct note data", async function () {
      const { vault, alice } = await loadFixture(deployVaultFixture);
      const principal = usdcAmount(5_000);

      const tx = await vault.connect(alice).issueNote(principal);
      const block = await ethers.provider.getBlock(tx.blockNumber);

      const note = await vault.getNote(0);
      expect(note.owner).to.equal(alice.address);
      expect(note.principal).to.equal(principal);
      expect(note.issuedAt).to.equal(block.timestamp);
      expect(note.maturesAt).to.equal(block.timestamp + 365 * 24 * 60 * 60);
      expect(note.redeemed).to.equal(false);
    });

    it("assigns sequential note IDs across multiple issuances", async function () {
      const { vault, alice, bob } = await loadFixture(deployVaultFixture);
      await vault.connect(alice).issueNote(usdcAmount(100));
      await vault.connect(bob).issueNote(usdcAmount(200));

      const note0 = await vault.getNote(0);
      const note1 = await vault.getNote(1);
      expect(note0.owner).to.equal(alice.address);
      expect(note1.owner).to.equal(bob.address);
    });
  });

  describe("getNote", function () {
    it("reverts for a nonexistent note", async function () {
      const { vault } = await loadFixture(deployVaultFixture);
      await expect(vault.getNote(999)).to.be.revertedWithCustomError(vault, "NoteNotFound");
    });
  });

  describe("redeemAtMaturity", function () {
    async function issueAndFastForward(vault, alice, principal) {
      await vault.connect(alice).issueNote(principal);
      const note = await vault.getNote(0);
      await time.increaseTo(note.maturesAt);
      return note;
    }

    it("reverts for a nonexistent note", async function () {
      const { vault, alice } = await loadFixture(deployVaultFixture);
      await expect(vault.connect(alice).redeemAtMaturity(0)).to.be.revertedWithCustomError(
        vault,
        "NoteNotFound"
      );
    });

    it("reverts if caller is not the note owner", async function () {
      const { vault, alice, bob } = await loadFixture(deployVaultFixture);
      const principal = usdcAmount(1_000);
      await issueAndFastForward(vault, alice, principal);

      await expect(vault.connect(bob).redeemAtMaturity(0))
        .to.be.revertedWithCustomError(vault, "NotNoteOwner")
        .withArgs(bob.address, 0);
    });

    it("reverts if called before maturity", async function () {
      const { vault, alice } = await loadFixture(deployVaultFixture);
      await vault.connect(alice).issueNote(usdcAmount(1_000));

      await expect(vault.connect(alice).redeemAtMaturity(0)).to.be.revertedWithCustomError(
        vault,
        "NoteNotYetMatured"
      );
    });

    it("reverts if already redeemed", async function () {
      const { vault, alice } = await loadFixture(deployVaultFixture);
      const principal = usdcAmount(1_000);
      await issueAndFastForward(vault, alice, principal);

      await vault.connect(alice).redeemAtMaturity(0);
      await expect(vault.connect(alice).redeemAtMaturity(0)).to.be.revertedWithCustomError(
        vault,
        "NoteAlreadyRedeemed"
      );
    });

    it("pays out safe leg (guaranteed) + risk leg with no penalty at maturity", async function () {
      const { vault, usdc, safeLegManager, riskLegManager, alice } =
        await loadFixture(deployVaultFixture);
      const principal = usdcAmount(10_000);
      const note = await issueAndFastForward(vault, alice, principal);

      await usdc.mint(await safeLegManager.getAddress(), principal);
      await safeLegManager.setWithdrawValue(0, principal);

      const depositedRiskLeg = note.riskLegAmount;
      const riskLegValueAtMaturity = depositedRiskLeg / 2n;
      await riskLegManager.setWithdrawValue(0, riskLegValueAtMaturity);

      const balanceBefore = await usdc.balanceOf(alice.address);
      const tx = await vault.connect(alice).redeemAtMaturity(0);
      await tx.wait();
      const balanceAfter = await usdc.balanceOf(alice.address);

      const expectedPayout = principal + riskLegValueAtMaturity;
      expect(balanceAfter - balanceBefore).to.equal(expectedPayout);
      expect(balanceAfter - balanceBefore).to.be.gte(principal);
    });

    it("marks the note as redeemed", async function () {
      const { vault, alice } = await loadFixture(deployVaultFixture);
      await issueAndFastForward(vault, alice, usdcAmount(1_000));
      await vault.connect(alice).redeemAtMaturity(0);

      const note = await vault.getNote(0);
      expect(note.redeemed).to.equal(true);
    });

    it("emits NoteRedeemed with wasEarlyExit = false", async function () {
      const { vault, alice } = await loadFixture(deployVaultFixture);
      await issueAndFastForward(vault, alice, usdcAmount(1_000));

      await expect(vault.connect(alice).redeemAtMaturity(0))
        .to.emit(vault, "NoteRedeemed")
        .withArgs(0, alice.address, anyValue, anyValue, anyValue, false);
    });
  });

  describe("redeemEarly", function () {
    it("reverts for a nonexistent note", async function () {
      const { vault, alice } = await loadFixture(deployVaultFixture);
      await expect(vault.connect(alice).redeemEarly(0)).to.be.revertedWithCustomError(
        vault,
        "NoteNotFound"
      );
    });

    it("reverts if caller is not the note owner", async function () {
      const { vault, alice, bob } = await loadFixture(deployVaultFixture);
      await vault.connect(alice).issueNote(usdcAmount(1_000));

      await expect(vault.connect(bob).redeemEarly(0))
        .to.be.revertedWithCustomError(vault, "NotNoteOwner")
        .withArgs(bob.address, 0);
    });

    it("reverts if already redeemed", async function () {
      const { vault, alice } = await loadFixture(deployVaultFixture);
      await vault.connect(alice).issueNote(usdcAmount(1_000));
      await vault.connect(alice).redeemEarly(0);

      await expect(vault.connect(alice).redeemEarly(0)).to.be.revertedWithCustomError(
        vault,
        "NoteAlreadyRedeemed"
      );
    });

    it("does NOT require maturity to have passed", async function () {
      const { vault, alice } = await loadFixture(deployVaultFixture);
      await vault.connect(alice).issueNote(usdcAmount(1_000));

      await expect(vault.connect(alice).redeemEarly(0)).to.not.be.reverted;
    });

    it("applies the penalty ONLY to the risk leg — safe leg passes through in full", async function () {
      const { vault, usdc, safeLegManager, riskLegManager, alice } =
        await loadFixture(deployVaultFixture);
      const principal = usdcAmount(10_000);
      await vault.connect(alice).issueNote(principal);

      const note = await vault.getNote(0);
      const safeLegAccrued = usdcAmount(9_630);
      const riskLegValue = note.riskLegAmount;

      await usdc.mint(await safeLegManager.getAddress(), usdcAmount(9_630));
      await safeLegManager.setWithdrawValue(0, safeLegAccrued);

      const balanceBefore = await usdc.balanceOf(alice.address);
      const tx = await vault.connect(alice).redeemEarly(0);
      await tx.wait();
      const balanceAfter = await usdc.balanceOf(alice.address);

      const riskLegPenalty = (riskLegValue * BigInt(DEFAULT_PENALTY_BPS)) / 10_000n;
      const expectedRiskLegPayout = riskLegValue - riskLegPenalty;
      const expectedTotal = safeLegAccrued + expectedRiskLegPayout;

      expect(balanceAfter - balanceBefore).to.equal(expectedTotal);

      const totalPenaltyIfAppliedToWhole =
        ((safeLegAccrued + riskLegValue) * BigInt(DEFAULT_PENALTY_BPS)) / 10_000n;
      expect(balanceAfter - balanceBefore).to.be.gt(
        safeLegAccrued + riskLegValue - totalPenaltyIfAppliedToWhole
      );
    });

    it("applies zero penalty when earlyExitPenaltyBps is 0", async function () {
      const { vault, owner, usdc, alice } = await loadFixture(deployVaultFixture);
      await vault.connect(owner).setEarlyExitPenaltyBps(0);

      const principal = usdcAmount(1_000);
      await vault.connect(alice).issueNote(principal);
      const note = await vault.getNote(0);

      const balanceBefore = await usdc.balanceOf(alice.address);
      await vault.connect(alice).redeemEarly(0);
      const balanceAfter = await usdc.balanceOf(alice.address);

      expect(balanceAfter - balanceBefore).to.equal(note.safeLegAmount + note.riskLegAmount);
    });

    it("marks the note as redeemed", async function () {
      const { vault, alice } = await loadFixture(deployVaultFixture);
      await vault.connect(alice).issueNote(usdcAmount(1_000));
      await vault.connect(alice).redeemEarly(0);

      const note = await vault.getNote(0);
      expect(note.redeemed).to.equal(true);
    });

    it("emits NoteRedeemed with wasEarlyExit = true and post-penalty riskLegPayout", async function () {
      const { vault, alice } = await loadFixture(deployVaultFixture);
      const principal = usdcAmount(1_000);
      await vault.connect(alice).issueNote(principal);
      const note = await vault.getNote(0);

      const expectedRiskLegPenalty =
        (note.riskLegAmount * BigInt(DEFAULT_PENALTY_BPS)) / 10_000n;
      const expectedRiskLegPayout = note.riskLegAmount - expectedRiskLegPenalty;

      await expect(vault.connect(alice).redeemEarly(0))
        .to.emit(vault, "NoteRedeemed")
        .withArgs(
          0,
          alice.address,
          note.safeLegAmount,
          expectedRiskLegPayout,
          note.safeLegAmount + expectedRiskLegPayout,
          true
        );
    });
  });

  describe("Admin functions", function () {
    it("only owner can set deposit cap", async function () {
      const { vault, alice } = await loadFixture(deployVaultFixture);
      await expect(vault.connect(alice).setDepositCap(usdcAmount(1))).to.be.revertedWithCustomError(
        vault,
        "OwnableUnauthorizedAccount"
      );
    });

    it("owner can update deposit cap and event is emitted", async function () {
      const { vault, owner } = await loadFixture(deployVaultFixture);
      const newCap = usdcAmount(2_000_000);
      await expect(vault.connect(owner).setDepositCap(newCap))
        .to.emit(vault, "DepositCapUpdated")
        .withArgs(DEFAULT_DEPOSIT_CAP, newCap);
      expect(await vault.depositCap()).to.equal(newCap);
    });

    it("only owner can set conservative rate", async function () {
      const { vault, alice } = await loadFixture(deployVaultFixture);
      await expect(vault.connect(alice).setConservativeRateBps(600)).to.be.revertedWithCustomError(
        vault,
        "OwnableUnauthorizedAccount"
      );
    });

    it("only owner can set minimum deposit", async function () {
      const { vault, alice } = await loadFixture(deployVaultFixture);
      await expect(
        vault.connect(alice).setMinimumDeposit(usdcAmount(50))
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("only owner can set early exit penalty", async function () {
      const { vault, alice } = await loadFixture(deployVaultFixture);
      await expect(
        vault.connect(alice).setEarlyExitPenaltyBps(100)
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("reverts when setting early exit penalty above the ceiling", async function () {
      const { vault, owner } = await loadFixture(deployVaultFixture);
      await expect(
        vault.connect(owner).setEarlyExitPenaltyBps(5_001)
      ).to.be.revertedWithCustomError(vault, "EarlyExitPenaltyTooHigh");
    });

    it("only owner can pause/unpause", async function () {
      const { vault, alice } = await loadFixture(deployVaultFixture);
      await expect(vault.connect(alice).pause()).to.be.revertedWithCustomError(
        vault,
        "OwnableUnauthorizedAccount"
      );
    });

    it("owner can pause and unpause", async function () {
      const { vault, owner, alice } = await loadFixture(deployVaultFixture);
      await vault.connect(owner).pause();
      await expect(vault.connect(alice).issueNote(usdcAmount(100))).to.be.revertedWithCustomError(
        vault,
        "EnforcedPause"
      );

      await vault.connect(owner).unpause();
      await expect(vault.connect(alice).issueNote(usdcAmount(100))).to.not.be.reverted;
    });
  });

  function anyValue() {
    return true;
  }
});