import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

describe("OpenPepe", function () {
  // Fixture that deploys the contract
  async function deployOpenPepeFixture() {
    const [owner, user1, user2] = await ethers.getSigners();

    const OpenPepe = await ethers.getContractFactory("OpenPepe");
    const openPepe = await OpenPepe.deploy();
    await openPepe.waitForDeployment();

    return { openPepe, owner, user1, user2 };
  }

  describe("Deployment", function () {
    it("Should set the correct token name and symbol", async function () {
      const { openPepe } = await loadFixture(deployOpenPepeFixture);

      expect(await openPepe.name()).to.equal("OpenPepe");
      expect(await openPepe.symbol()).to.equal("PLEB");
    });

    it("Should set the launch time to deployment time", async function () {
      const { openPepe } = await loadFixture(deployOpenPepeFixture);
      const blockTimestamp = await time.latest();

      expect(await openPepe.launchTime()).to.be.closeTo(
        BigInt(blockTimestamp),
        BigInt(2)
      );
    });
  });

  describe("Staking", function () {
    it("Should allow staking ETH and emit correct events", async function () {
      const { openPepe, user1 } = await loadFixture(deployOpenPepeFixture);
      const stakeAmount = ethers.parseEther("1");
      const stakeDuration = 7n;

      // Check for both Staked and StakerAdded events
      await expect(
        openPepe.connect(user1).stake(stakeDuration, { value: stakeAmount })
      )
        .to.emit(openPepe, "Staked")
        .withArgs(user1.address, stakeAmount, stakeDuration, 0n, stakeDuration)
        .and.to.emit(openPepe, "StakerAdded")
        .withArgs(user1.address)
        .and.to.emit(openPepe, "TotalLockedEthUpdated")
        .withArgs(stakeAmount);

      const stakes = await openPepe.getActiveStakes(user1.address);
      expect(stakes.length).to.equal(1);
      expect(stakes[0].amount).to.equal(stakeAmount);
      expect(stakes[0].duration).to.equal(stakeDuration);
    });

    it("Should track stakers correctly", async function () {
      const { openPepe, user1, user2 } = await loadFixture(
        deployOpenPepeFixture
      );
      const stakeAmount = ethers.parseEther("1");

      // First stake from user1
      await openPepe.connect(user1).stake(7n, { value: stakeAmount });

      let stakers = await openPepe.getAllStakers();
      expect(stakers.length).to.equal(1);
      expect(stakers[0]).to.equal(user1.address);

      // Second stake from user1 shouldn't add duplicate
      await openPepe.connect(user1).stake(7n, { value: stakeAmount });
      stakers = await openPepe.getAllStakers();
      expect(stakers.length).to.equal(1);

      // Stake from user2 should add new staker
      await openPepe.connect(user2).stake(7n, { value: stakeAmount });
      stakers = await openPepe.getAllStakers();
      expect(stakers.length).to.equal(2);
      expect(stakers[1]).to.equal(user2.address);
    });

    it("Should reject zero ETH stake", async function () {
      const { openPepe, user1 } = await loadFixture(deployOpenPepeFixture);

      await expect(
        openPepe.connect(user1).stake(7n, { value: 0 })
      ).to.be.revertedWith("Cannot stake 0 ETH");
    });

    it("Should reject zero duration stake", async function () {
      const { openPepe, user1 } = await loadFixture(deployOpenPepeFixture);

      await expect(
        openPepe.connect(user1).stake(0n, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("Minimum lock duration is 1 day");
    });

    it("Should update daily total stake correctly", async function () {
      const { openPepe, user1 } = await loadFixture(deployOpenPepeFixture);
      const stakeAmount = ethers.parseEther("1");
      const stakeDuration = 3n;

      await openPepe
        .connect(user1)
        .stake(stakeDuration, { value: stakeAmount });

      // Check daily totals (amount * duration for each day)
      for (let day = 0n; day < stakeDuration; day++) {
        const dailyTotal = await openPepe.dailyTotalStake(day);
        expect(dailyTotal).to.equal(stakeAmount * stakeDuration);
      }
    });
  });

  describe("ETH Tracking", function () {
    it("Should track total locked ETH correctly", async function () {
      const { openPepe, user1, user2 } = await loadFixture(
        deployOpenPepeFixture
      );
      const stakeAmount1 = ethers.parseEther("1");
      const stakeAmount2 = ethers.parseEther("2");

      // Initial state
      expect(await openPepe.getTotalLockedEth()).to.equal(0);

      // After first stake
      await openPepe.connect(user1).stake(7n, { value: stakeAmount1 });
      expect(await openPepe.getTotalLockedEth()).to.equal(stakeAmount1);

      // After second stake
      await openPepe.connect(user2).stake(7n, { value: stakeAmount2 });
      expect(await openPepe.getTotalLockedEth()).to.equal(
        stakeAmount1 + stakeAmount2
      );

      // After unstaking (need to move forward in time first)
      await time.increase(time.duration.days(7));
      await openPepe.connect(user1).unstake(0);
      expect(await openPepe.getTotalLockedEth()).to.equal(stakeAmount2);
    });

    it("Should calculate locked ETH metrics correctly", async function () {
      const { openPepe, user1, user2 } = await loadFixture(
        deployOpenPepeFixture
      );

      // Initial state
      let metrics = await openPepe.getLockedEthMetrics();
      expect(metrics.currentLocked).to.equal(0);
      expect(metrics.activeDays).to.equal(0);
      expect(metrics.averageStakeSize).to.equal(0);

      // Add two stakes of different durations
      const stakeAmount1 = ethers.parseEther("1");
      const stakeAmount2 = ethers.parseEther("2");
      const duration1 = 7n;
      const duration2 = 14n;

      await openPepe.connect(user1).stake(duration1, { value: stakeAmount1 });
      await openPepe.connect(user2).stake(duration2, { value: stakeAmount2 });

      metrics = await openPepe.getLockedEthMetrics();

      // Check current locked amount
      expect(metrics.currentLocked).to.equal(stakeAmount1 + stakeAmount2);

      // Check active days (should be 14 days - the longer of the two stakes)
      expect(metrics.activeDays).to.equal(14n);

      // Check average stake size (total locked / number of stakes)
      expect(metrics.averageStakeSize).to.equal(
        (stakeAmount1 + stakeAmount2) / 2n
      );
    });

    it("Should emit TotalLockedEthUpdated event on unstake", async function () {
      const { openPepe, user1 } = await loadFixture(deployOpenPepeFixture);
      const stakeAmount = ethers.parseEther("1");

      await openPepe.connect(user1).stake(7n, { value: stakeAmount });
      await time.increase(time.duration.days(7));

      await expect(openPepe.connect(user1).unstake(0))
        .to.emit(openPepe, "TotalLockedEthUpdated")
        .withArgs(0); // After unstaking, balance should be 0
    });
  });

  describe("Unstaking", function () {
    it("Should allow unstaking after lock period", async function () {
      const { openPepe, user1 } = await loadFixture(deployOpenPepeFixture);
      const stakeAmount = ethers.parseEther("1");
      const stakeDuration = 7n;

      await openPepe
        .connect(user1)
        .stake(stakeDuration, { value: stakeAmount });

      // Fast forward past lock period
      await time.increase(time.duration.days(7));

      const provider = network.provider;
      const initialBalance = await provider.send("eth_getBalance", [
        user1.address,
      ]);
      await openPepe.connect(user1).unstake(0);
      const finalBalance = await provider.send("eth_getBalance", [
        user1.address,
      ]);

      expect(BigInt(finalBalance)).to.be.gt(BigInt(initialBalance)); // Account for gas costs
    });

    it("Should prevent unstaking during lock period", async function () {
      const { openPepe, user1 } = await loadFixture(deployOpenPepeFixture);
      const stakeAmount = ethers.parseEther("1");
      const stakeDuration = 7n;

      await openPepe
        .connect(user1)
        .stake(stakeDuration, { value: stakeAmount });

      await expect(openPepe.connect(user1).unstake(0)).to.be.revertedWith(
        "Stake still locked"
      );
    });

    it("Should prevent unstaking already withdrawn stakes", async function () {
      const { openPepe, user1 } = await loadFixture(deployOpenPepeFixture);
      const stakeAmount = ethers.parseEther("1");
      const stakeDuration = 7n;

      await openPepe
        .connect(user1)
        .stake(stakeDuration, { value: stakeAmount });
      await time.increase(time.duration.days(7));
      await openPepe.connect(user1).unstake(0);

      await expect(openPepe.connect(user1).unstake(0)).to.be.revertedWith(
        "Stake already withdrawn"
      );
    });
  });

  describe("Rewards", function () {
    it("Should calculate daily emission correctly", async function () {
      const { openPepe } = await loadFixture(deployOpenPepeFixture);
      const START_VALUE = ethers.parseEther("1000000000"); // 1B tokens

      // Day 0 emission should be START_VALUE
      expect(await openPepe.getDailyEmission(0n)).to.equal(START_VALUE);

      // Get emissions for different days
      const day1Emission = await openPepe.getDailyEmission(1n);
      const day4Emission = await openPepe.getDailyEmission(4n);
      const day9Emission = await openPepe.getDailyEmission(9n);

      // The contract multiplies by 1e18 before division for precision
      const SCALING_FACTOR = ethers.parseUnits("1", 18);
      const scaledStartValue = START_VALUE * SCALING_FACTOR;

      // Verify the scaled emissions
      expect(day1Emission).to.equal(scaledStartValue / 1n); // sqrt(1) = 1
      expect(day4Emission).to.equal(scaledStartValue / 2n); // sqrt(4) = 2
      expect(day9Emission).to.equal(scaledStartValue / 3n); // sqrt(9) = 3

      // Verify decreasing pattern
      expect(day4Emission).to.be.lt(day1Emission);
      expect(day9Emission).to.be.lt(day4Emission);
    });

    it("Should allow claiming rewards after stake period", async function () {
      const { openPepe, user1 } = await loadFixture(deployOpenPepeFixture);
      const stakeAmount = ethers.parseEther("1");
      const stakeDuration = 2n;

      await openPepe
        .connect(user1)
        .stake(stakeDuration, { value: stakeAmount });

      // Move forward one day
      await time.increase(time.duration.days(1));

      // Should be able to claim rewards for day 0
      await expect(openPepe.connect(user1).claimRewards(0)).to.emit(
        openPepe,
        "RewardClaimed"
      );

      const balance = await openPepe.balanceOf(user1.address);
      expect(balance).to.be.gt(0n);
    });

    it("Should prevent double claiming rewards", async function () {
      const { openPepe, user1 } = await loadFixture(deployOpenPepeFixture);
      const stakeAmount = ethers.parseEther("1");
      const stakeDuration = 2n;

      await openPepe
        .connect(user1)
        .stake(stakeDuration, { value: stakeAmount });
      await time.increase(time.duration.days(1));
      await openPepe.connect(user1).claimRewards(0);

      await expect(openPepe.connect(user1).claimRewards(0)).to.be.revertedWith(
        "Rewards already claimed for this day"
      );
    });

    it("Should prevent claiming rewards for future days", async function () {
      const { openPepe, user1 } = await loadFixture(deployOpenPepeFixture);
      const stakeAmount = ethers.parseEther("1");
      const stakeDuration = 7n;

      await openPepe
        .connect(user1)
        .stake(stakeDuration, { value: stakeAmount });

      await expect(openPepe.connect(user1).claimRewards(1)).to.be.revertedWith(
        "Day not completed"
      );
    });
  });

  describe("Direct ETH transfers", function () {
    it("Should reject direct ETH transfers", async function () {
      const { openPepe, user1 } = await loadFixture(deployOpenPepeFixture);
      const openPepeAddress = await openPepe.getAddress();

      await expect(
        user1.sendTransaction({
          to: openPepeAddress,
          value: ethers.parseEther("1"),
        })
      ).to.be.revertedWith("Use stake() to stake ETH");
    });
  });
});
