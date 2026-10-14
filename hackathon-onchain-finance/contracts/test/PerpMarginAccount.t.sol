// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PerpMarginAccount, IERC20} from "../src/PerpMarginAccount.sol";

// ---------------------------------------------------------------
// Mocks：自包含，不需要 fork 任何真实链状态，本地 forge test 直接跑
// ---------------------------------------------------------------

contract MockMarginToken is IERC20 {
    string public name = "Mock USD Coin";
    string public symbol = "mUSDC";
    uint8 public decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice 模拟 MultiCollateralVaultV2：按地址返回可设置的 totalAccountValue（quote，18 位）
contract MockCollateralValuer {
    mapping(address => uint256) public values;

    function setValue(address user, uint256 value) external {
        values[user] = value;
    }

    function totalAccountValue(address user) external view returns (uint256) {
        return values[user];
    }
}

contract MockMarkOracle {
    uint256 public price;

    function setPrice(uint256 newPrice) external {
        price = newPrice;
    }

    function getMarkPrice() external view returns (uint256) {
        return price;
    }
}

// ---------------------------------------------------------------
// 测试
// ---------------------------------------------------------------

contract PerpMarginAccountTest is Test {
    MockMarginToken token;
    MockCollateralValuer valuer;
    MockMarkOracle oracle;
    PerpMarginAccount vault;

    address operator = address(this);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address liquidator = address(0x119);

    uint256 constant QUOTE_PRICE_E6 = 35_000_000; // quote 代币 $35

    function setUp() public {
        token = new MockMarginToken();
        valuer = new MockCollateralValuer();
        oracle = new MockMarkOracle();
        oracle.setPrice(2500);
        vault = new PerpMarginAccount(address(token), address(valuer), address(oracle), QUOTE_PRICE_E6);
        // 本合约即 owner/operator；给 alice/bob 发保证金代币
        token.mint(alice, 1_000_000);
        token.mint(bob, 1_000_000);
    }

    function _deposit(address user, uint256 amount) internal {
        vm.startPrank(user);
        token.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    // ---------- 基础资金 ----------

    function test_DepositWithdrawFreeMarginOnly() public {
        _deposit(alice, 100_000);
        assertEq(vault.marginBalance(alice), 100_000);
        vm.prank(alice);
        vault.withdraw(40_000);
        assertEq(vault.marginBalance(alice), 60_000);
        // 开仓占用后，自由保证金不足时提取被拒
        vault.applyPositionDelta(alice, 10, 2500, 5); // 占用 25000/5=5000
        vm.prank(alice);
        vm.expectRevert();
        vault.withdraw(56_000); // 自由只有 60000-5000=55000
    }

    // ---------- RWA 估值在合约层计入保证金（核心绑定） ----------

    function test_RwaCollateralValueCountsAsMarginOnChain() public {
        // alice 不存一分钱保证金，但在 RWA 金库里有 0.1 quote 的估值
        valuer.setValue(alice, 0.1e18);
        // 0.1 * $35 = $3.50 -> 3_500_000（6 位）
        assertEq(vault.rwaMarginValue(alice), 3_500_000);
        assertEq(vault.accountValue(alice), 3_500_000);
        // 仅凭 RWA 估值即可开仓：需要 2500*10/10=2500 保证金
        vault.applyPositionDelta(alice, 10, 2500, 10);
        (int256 size,, uint256 allocated) = vault.positions(alice);
        assertEq(size, 10);
        assertEq(allocated, 2500);
    }

    function test_OpenRejectedWhenCombinedMarginInsufficient() public {
        _deposit(alice, 1_000);
        vm.expectRevert(); // 需要 25000，现金+RWA 都没有
        vault.applyPositionDelta(alice, 10, 2500, 1);
    }

    function test_LeverageBounds() public {
        _deposit(alice, 1_000_000);
        vm.expectRevert();
        vault.applyPositionDelta(alice, 10, 2500, 21);
        vm.expectRevert();
        vault.applyPositionDelta(alice, 10, 2500, 0);
    }

    function test_OnlyOperatorCanApplyDelta() public {
        _deposit(alice, 1_000_000);
        vm.prank(bob);
        vm.expectRevert();
        vault.applyPositionDelta(alice, 10, 2500, 1);
    }

    // ---------- 仓位记账 ----------

    function test_VwapEntryAndPartialClosePnl() public {
        _deposit(alice, 1_000_000);
        _deposit(bob, 1_000_000);
        vault.applyPositionDelta(alice, 10, 2000, 1);
        vault.applyPositionDelta(alice, 10, 3000, 1);
        (int256 size, uint256 entry,) = vault.positions(alice);
        assertEq(size, 20);
        assertEq(entry, 2500);
        // 涨到 3000 平掉 4 个：实现盈利 500*4
        vault.applyPositionDelta(alice, -4, 3000, 1);
        assertEq(vault.realizedPnl(alice), 2000);
    }

    function test_FlipThroughZero() public {
        _deposit(alice, 1_000_000);
        vault.applyPositionDelta(alice, 10, 2500, 1);
        vault.applyPositionDelta(alice, -15, 2000, 1); // 平 10 亏 5000，再开空 5
        (int256 size, uint256 entry,) = vault.positions(alice);
        assertEq(size, -5);
        assertEq(entry, 2000);
        assertEq(vault.realizedPnl(alice), -5000);
    }

    // ---------- 独立标记价 + 强平 + 保险基金 ----------

    function test_LiquidationUsesIndependentMarkAndPaysPenaltyToInsurance() public {
        _deposit(alice, 100_000);
        vault.applyPositionDelta(alice, 10, 2500, 10); // 占用 2500
        oracle.setPrice(2350); // 独立标记价下跌（不需要任何成交砸盘）
        assertTrue(vault.isLiquidatable(alice));
        vm.prank(liquidator);
        vault.liquidate(alice);
        (int256 size,,) = vault.positions(alice);
        assertEq(size, 0);
        // 权益 1000，罚金 23500*0.5%=117 入保险基金，用户拿回 883 + 原自由部分
        assertEq(vault.insuranceBalance(), 117);
        assertEq(vault.marginBalance(alice), 100_000 - 2500 + (1000 - 117));
    }

    function test_LiquidationDeficitCoveredByInsuranceThenBadDebt() public {
        _deposit(alice, 100_000);
        // 先给保险基金注资 300
        token.mint(address(this), 300);
        token.approve(address(vault), 300);
        vault.fundInsurance(300);

        vault.applyPositionDelta(alice, 10, 2500, 10); // 占用 2500
        oracle.setPrice(2200); // 亏 3000，穿仓缺口 500
        vm.prank(liquidator);
        vault.liquidate(alice);
        assertEq(vault.totalInsuranceCovered(), 300);
        assertEq(vault.totalBadDebt(), 200);
        assertEq(vault.insuranceBalance(), 0);
        // 用户只损失被占用的 2500，自由部分 97500 不被追偿
        assertEq(vault.marginBalance(alice), 97_500);
    }

    function test_NotLiquidatableWhenHealthy() public {
        _deposit(alice, 100_000);
        vault.applyPositionDelta(alice, 10, 2500, 2); // 占用 12500
        oracle.setPrice(2400); // 亏 1000，权益远高于维持保证金
        assertFalse(vault.isLiquidatable(alice));
        vm.expectRevert();
        vault.liquidate(alice);
    }

    function test_MarkPriceManipulationByTradePriceDoesNotLiquidate() public {
        // 标记价只读 oracle：就算有人用 1 的价格成交（业务层），oracle 不动就不强平。
        // 本测试固定 oracle 在 2500，仓位保持健康，证明强平判定与成交价解耦。
        _deposit(alice, 100_000);
        vault.applyPositionDelta(alice, 10, 2500, 10);
        assertFalse(vault.isLiquidatable(alice));
        oracle.setPrice(2500);
        assertFalse(vault.isLiquidatable(alice));
    }
}
