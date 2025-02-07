import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { OpenPepe } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("OpenPepe Gas Analysis", function () {
  async function deployOpenPepeFixture() {
    const [owner, user1, user2] = await ethers.getSigners();
    const OpenPepe = await ethers.getContractFactory("OpenPepe");
    const openPepe = await OpenPepe.deploy();
    await openPepe.waitForDeployment();
    return { openPepe, owner, user1, user2 };
  }

  describe("Gas Usage", function () {
    it("Should measure gas for first stake vs subsequent stakes", async function () {
      const { openPepe, user1 } = await loadFixture(deployOpenPepeFixture);
      const stakeAmount = ethers.parseEther("1");
      const stakeDuration = 7n;

      const tx1 = await openPepe
        .connect(user1)
        .stake(stakeDuration, { value: stakeAmount });
      const receipt1 = await tx1.wait();
      console.log("Gas used for first stake:", receipt1?.gasUsed.toString());

      const tx2 = await openPepe
        .connect(user1)
        .stake(stakeDuration, { value: stakeAmount });
      const receipt2 = await tx2.wait();
      console.log("Gas used for second stake:", receipt2?.gasUsed.toString());

      expect(receipt2?.gasUsed).to.be.lt(receipt1?.gasUsed);

      const stakes = await openPepe.getActiveStakes(user1.address);
      expect(stakes.length).to.equal(2);
    });

    it("Should measure gas for unstaking", async function () {
      const { openPepe, user1 } = await loadFixture(deployOpenPepeFixture);
      const stakeAmount = ethers.parseEther("1");

      await openPepe.connect(user1).stake(7n, { value: stakeAmount });
      const initialBalance = await ethers.provider.getBalance(user1.address);

      await time.increase(time.duration.days(7));

      const txUnstake = await openPepe.connect(user1).unstake(0);
      const receiptUnstake = await txUnstake.wait();
      console.log(
        "Gas used for successful unstake:",
        receiptUnstake?.gasUsed.toString()
      );

      const finalBalance = await ethers.provider.getBalance(user1.address);
      expect(finalBalance).to.be.gt(initialBalance);

      await expect(openPepe.connect(user1).unstake(0)).to.be.revertedWith(
        "Stake already withdrawn"
      );
    });

    it("Should measure gas for claiming rewards", async function () {
      const { openPepe, user1 } = await loadFixture(deployOpenPepeFixture);
      const stakeAmount = ethers.parseEther("1");

      await openPepe.connect(user1).stake(7n, { value: stakeAmount });
      await time.increase(time.duration.days(1));

      const txClaim = await openPepe.connect(user1).claimRewards(0);
      const receiptClaim = await txClaim.wait();
      console.log(
        "Gas used for first reward claim:",
        receiptClaim?.gasUsed.toString()
      );

      const balance = await openPepe.balanceOf(user1.address);
      expect(balance).to.be.gt(0);

      await expect(openPepe.connect(user1).claimRewards(0)).to.be.revertedWith(
        "Rewards already claimed for this day"
      );
    });

    it("Should measure gas for ETH tracking functions", async function () {
      const { openPepe, user1, user2 } = await loadFixture(
        deployOpenPepeFixture
      );

      await openPepe
        .connect(user1)
        .stake(7n, { value: ethers.parseEther("1") });
      await openPepe
        .connect(user2)
        .stake(14n, { value: ethers.parseEther("2") });

      const totalLocked = await openPepe.getTotalLockedEth();
      const gasForTotal = await ethers.provider.estimateGas({
        to: await openPepe.getAddress(),
        data: openPepe.interface.encodeFunctionData("getTotalLockedEth"),
      });
      console.log(
        "Gas used for getTotalLockedEth view call:",
        gasForTotal.toString()
      );
      expect(totalLocked).to.equal(ethers.parseEther("3"));

      const [currentLocked, activeDays, averageStakeSize] =
        await openPepe.getLockedEthMetrics();
      const gasForMetrics = await ethers.provider.estimateGas({
        to: await openPepe.getAddress(),
        data: openPepe.interface.encodeFunctionData("getLockedEthMetrics"),
      });
      console.log(
        "Gas used for getLockedEthMetrics view call:",
        gasForMetrics.toString()
      );

      expect(currentLocked).to.equal(ethers.parseEther("3"));
      expect(activeDays).to.be.gt(0);
      expect(averageStakeSize).to.equal(ethers.parseEther("1.5"));
    });

    it("Should measure gas impact of stake duration", async function () {
      const { openPepe, user1 } = await loadFixture(deployOpenPepeFixture);
      const stakeAmount = ethers.parseEther("1");
      const durations = [1n, 7n, 30n, 365n];

      for (const duration of durations) {
        const tx = await openPepe
          .connect(user1)
          .stake(duration, { value: stakeAmount });
        const receipt = await tx.wait();
        console.log(
          `Gas used for ${duration} day stake:`,
          receipt?.gasUsed.toString()
        );

        const stakes = await openPepe.getActiveStakes(user1.address);
        const lastStake = stakes[stakes.length - 1];
        expect(lastStake.duration).to.equal(duration);
        expect(lastStake.amount).to.equal(stakeAmount);
      }
    });

    it("Should measure gas for composite operations", async function () {
      const { openPepe, user1 } = await loadFixture(deployOpenPepeFixture);
      const stakeAmount = ethers.parseEther("1");
      let totalGas = 0n;

      // Initial balance check
      const initialBalance = await ethers.provider.getBalance(user1.address);

      // 1. Stake
      const txStake = await openPepe
        .connect(user1)
        .stake(7n, { value: stakeAmount });
      const receiptStake = await txStake.wait();
      totalGas += receiptStake?.gasUsed;

      // Verify stake
      let stakes = await openPepe.getActiveStakes(user1.address);
      expect(stakes.length).to.equal(1);

      // 2. Wait and claim rewards
      await time.increase(time.duration.days(1));
      const txClaim = await openPepe.connect(user1).claimRewards(0);
      const receiptClaim = await txClaim.wait();
      totalGas += receiptClaim?.gasUsed;

      // Verify rewards
      const tokenBalance = await openPepe.balanceOf(user1.address);
      expect(tokenBalance).to.be.gt(0);

      // 3. Wait and unstake
      await time.increase(time.duration.days(6));
      const txUnstake = await openPepe.connect(user1).unstake(0);
      const receiptUnstake = await txUnstake.wait();
      totalGas += receiptUnstake?.gasUsed;

      // Verify unstake
      const finalBalance = await ethers.provider.getBalance(user1.address);
      expect(finalBalance).to.be.gt(initialBalance - ethers.parseEther("0.1")); // Account for gas

      console.log(
        "Total gas used for complete lifecycle:",
        totalGas.toString()
      );
      console.log(
        "Approximate gas cost in ETH at 50 gwei:",
        ethers.formatEther(totalGas * 50n * 1000000000n)
      );
    });
  });
});
