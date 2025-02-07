// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract OpenPepe is ERC20, ReentrancyGuard {
    // Constants
    uint256 public constant START_VALUE = 1_000_000_000 ether; // 1B tokens with 18 decimals
    uint256 public constant SECONDS_PER_DAY = 1 days;
    uint256 public constant MAX_DURATION = 365 days * 10; // 10 years max duration
    uint256 private constant BATCH_SIZE = 30; // Optimize gas usage for stake updates

    // State variables
    uint256 public immutable launchTime;
    mapping(address => Stake[]) public stakes;
    mapping(address => mapping(uint256 => bool)) public rewardsClaimed;
    mapping(uint256 => uint256) public dailyTotalStake;

    // Staker tracking
    address[] private stakers;
    mapping(address => bool) private isStaker;
    uint256 private totalActiveStakes;

    struct Stake {
        uint256 amount;
        uint256 duration;
        uint256 startDay;
        uint256 endDay;
        bool active;
    }

    // Events
    event Staked(
        address indexed user,
        uint256 amount,
        uint256 duration,
        uint256 startDay,
        uint256 endDay
    );
    event Unstaked(address indexed user, uint256 stakeIndex, uint256 amount);
    event RewardClaimed(address indexed user, uint256 day, uint256 amount);
    event TotalLockedEthUpdated(uint256 newTotal);
    event StakerAdded(address indexed staker);

    constructor() ERC20("OpenPepe", "PLEB") {
        launchTime = block.timestamp;
    }

    /**
     * @notice Create a new stake with ETH
     * @param duration Duration to lock the stake in days
     */
    function stake(uint256 duration) external payable nonReentrant {
        require(msg.value > 0, "Cannot stake 0 ETH");
        require(duration >= 1, "Minimum lock duration is 1 day");
        require(duration * 1 days <= MAX_DURATION, "Duration exceeds maximum");

        uint256 currentDay = getCurrentDay();
        uint256 startDay = currentDay;
        uint256 endDay = currentDay + duration;
        uint256 weightedAmount = msg.value * duration; // Calculate weighted amount

        // Create new stake
        stakes[msg.sender].push(
            Stake({
                amount: msg.value,
                duration: duration,
                startDay: startDay,
                endDay: endDay,
                active: true
            })
        );

        // Update daily total stakes in batches
        updateDailyTotalStake(startDay, endDay, weightedAmount);

        // Track new staker
        if (!isStaker[msg.sender]) {
            isStaker[msg.sender] = true;
            stakers.push(msg.sender);
            emit StakerAdded(msg.sender);
        }

        totalActiveStakes++;
        emit Staked(msg.sender, msg.value, duration, startDay, endDay);
        emit TotalLockedEthUpdated(address(this).balance);
    }

    /**
     * @notice Update daily total stake in batches to optimize gas usage
     * @param startDay Start day of the stake
     * @param endDay End day of the stake
     * @param weightedAmount Amount to add to each day (amount * duration)
     */
    function updateDailyTotalStake(
        uint256 startDay,
        uint256 endDay,
        uint256 weightedAmount
    ) internal {
        // For short durations, update directly
        if (endDay - startDay <= BATCH_SIZE) {
            for (uint256 day = startDay; day < endDay; day++) {
                dailyTotalStake[day] += weightedAmount;
            }
            return;
        }

        // For longer durations, update in batches
        uint256 completeBatches = (endDay - startDay) / BATCH_SIZE;
        uint256 remainder = (endDay - startDay) % BATCH_SIZE;

        // Update complete batches
        for (uint256 i = 0; i < completeBatches; i++) {
            uint256 batchStart = startDay + (i * BATCH_SIZE);
            for (
                uint256 day = batchStart;
                day < batchStart + BATCH_SIZE;
                day++
            ) {
                dailyTotalStake[day] += weightedAmount;
            }
        }

        // Update remainder
        if (remainder > 0) {
            uint256 remainderStart = startDay + (completeBatches * BATCH_SIZE);
            for (uint256 day = remainderStart; day < endDay; day++) {
                dailyTotalStake[day] += weightedAmount;
            }
        }
    }

    /**
     * @notice Calculate effective stake for a user on a specific day
     * @param user Address to calculate stake for
     * @param day Day number since launch
     * @return Total effective stake (amount * duration)
     */
    function calculateEffectiveStakeForDay(
        address user,
        uint256 day
    ) public view returns (uint256) {
        uint256 totalEffectiveStake = 0;
        Stake[] storage userStakes = stakes[user];

        for (uint256 i = 0; i < userStakes.length; i++) {
            Stake storage stakeEntry = userStakes[i];
            if (!stakeEntry.active) continue;

            // Only count if stake was active on this day
            if (stakeEntry.startDay <= day && stakeEntry.endDay > day) {
                totalEffectiveStake += stakeEntry.amount * stakeEntry.duration;
            }
        }

        return totalEffectiveStake;
    }

    /**
     * @notice Unstake ETH after lock period ends
     * @param stakeIndex Index of the stake to unstake
     */
    function unstake(uint256 stakeIndex) external nonReentrant {
        require(stakeIndex < stakes[msg.sender].length, "Invalid stake index");

        Stake storage userStake = stakes[msg.sender][stakeIndex];
        require(userStake.active, "Stake already withdrawn");
        require(getCurrentDay() >= userStake.endDay, "Stake still locked");

        uint256 amount = userStake.amount;
        userStake.active = false;
        totalActiveStakes--;

        // Transfer ETH back to user
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "ETH transfer failed");

        emit Unstaked(msg.sender, stakeIndex, amount);
        emit TotalLockedEthUpdated(address(this).balance);
    }

    /**
     * @notice Claim rewards for a specific day
     * @param day Day number since launch (0 = launch day)
     */
    function claimRewards(uint256 day) external nonReentrant {
        require(day < getCurrentDay(), "Day not completed");
        require(
            !rewardsClaimed[msg.sender][day],
            "Rewards already claimed for this day"
        );

        uint256 effectiveStake = calculateEffectiveStakeForDay(msg.sender, day);
        require(effectiveStake > 0, "No stake for this day");

        uint256 totalStakeForDay = dailyTotalStake[day];
        require(totalStakeForDay > 0, "No total stake for this day");

        uint256 emission = getDailyEmission(day);
        uint256 reward = (emission * effectiveStake) / totalStakeForDay;

        rewardsClaimed[msg.sender][day] = true;
        _mint(msg.sender, reward);

        emit RewardClaimed(msg.sender, day, reward);
    }

    // Rest of the contract remains the same...
    function getTotalLockedEth() external view returns (uint256) {
        return address(this).balance;
    }

    function getLockedEthMetrics()
        external
        view
        returns (
            uint256 currentLocked,
            uint256 activeDays,
            uint256 averageStakeSize
        )
    {
        currentLocked = address(this).balance;

        if (totalActiveStakes == 0) {
            return (currentLocked, 0, 0);
        }

        uint256 currentDay = getCurrentDay();
        uint256 maxEndDay = 0;
        uint256 activeCount = 0;

        // Calculate max end day across all active stakes
        for (uint256 i = 0; i < stakers.length; i++) {
            Stake[] memory userStakes = stakes[stakers[i]];
            for (uint256 j = 0; j < userStakes.length; j++) {
                if (userStakes[j].active && userStakes[j].endDay > currentDay) {
                    activeCount++;
                    if (userStakes[j].endDay > maxEndDay) {
                        maxEndDay = userStakes[j].endDay;
                    }
                }
            }
        }

        activeDays = maxEndDay > currentDay ? maxEndDay - currentDay : 0;
        averageStakeSize = activeCount > 0 ? currentLocked / activeCount : 0;
    }

    function getAllStakers() public view returns (address[] memory) {
        return stakers;
    }

    function getDailyEmission(uint256 day) public pure returns (uint256) {
        require(day >= 0, "Invalid day number");

        if (day == 0) {
            return START_VALUE;
        } else {
            return (START_VALUE * 1e18) / sqrt(day);
        }
    }

    function sqrt(uint256 x) public pure returns (uint256) {
        if (x == 0) return 0;

        uint256 z = (x + 1) / 2;
        uint256 y = x;

        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }

        return y;
    }

    function getCurrentDay() public view returns (uint256) {
        return (block.timestamp - launchTime) / SECONDS_PER_DAY;
    }

    function getActiveStakes(
        address user
    ) public view returns (Stake[] memory activeStakes) {
        Stake[] storage userStakes = stakes[user];
        uint256 activeCount = 0;

        // First count active stakes
        for (uint256 i = 0; i < userStakes.length; i++) {
            if (userStakes[i].active) activeCount++;
        }

        // Then create return array
        activeStakes = new Stake[](activeCount);
        uint256 j = 0;
        for (uint256 i = 0; i < userStakes.length && j < activeCount; i++) {
            if (userStakes[i].active) {
                activeStakes[j] = userStakes[i];
                j++;
            }
        }
    }

    receive() external payable {
        revert("Use stake() to stake ETH");
    }

    fallback() external payable {
        revert("Use stake() to stake ETH");
    }
}
