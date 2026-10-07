// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../src/Vault.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {FeeOnTransferToken} from "./mocks/FeeOnTransferToken.sol";

contract VaultTest is Test {
    Vault vault;
    MockUSDC usdc;

    address owner = address(this);
    address operator = address(0x0FE12A705);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        usdc = new MockUSDC(1_000_000 * 10 ** 6);
        vault = new Vault(address(usdc), owner, operator);

        usdc.transfer(alice, 10_000 * 10 ** 6);
        usdc.transfer(bob, 10_000 * 10 ** 6);
    }

    function _approveAndDeposit(address user, uint256 amount) internal {
        vm.startPrank(user);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    function test_Deposit() public {
        _approveAndDeposit(alice, 1_000 * 10 ** 6);
        assertEq(vault.balanceOf(alice), 1_000 * 10 ** 6);
        assertEq(usdc.balanceOf(address(vault)), 1_000 * 10 ** 6);
    }

    function test_Withdraw() public {
        _approveAndDeposit(alice, 1_000 * 10 ** 6);
        vm.prank(alice);
        vault.withdraw(400 * 10 ** 6);
        assertEq(vault.balanceOf(alice), 600 * 10 ** 6);
        assertEq(usdc.balanceOf(alice), 10_000 * 10 ** 6 - 1_000 * 10 ** 6 + 400 * 10 ** 6);
    }

    function test_RevertWhen_WithdrawMoreThanBalance() public {
        _approveAndDeposit(alice, 100 * 10 ** 6);
        vm.prank(alice);
        vm.expectRevert(Vault.InsufficientBalance.selector);
        vault.withdraw(200 * 10 ** 6);
    }

    function test_RevertWhen_DepositZero() public {
        vm.prank(alice);
        vm.expectRevert(Vault.ZeroAmount.selector);
        vault.deposit(0);
    }

    // ---- 硬上限（进阶功能）----
    function test_PerUserCap_BlocksExcessDeposit() public {
        vault.setPerUserCap(500 * 10 ** 6);
        vm.startPrank(alice);
        usdc.approve(address(vault), 1_000 * 10 ** 6);
        vm.expectRevert(Vault.CapExceeded.selector);
        vault.deposit(600 * 10 ** 6);
        vault.deposit(500 * 10 ** 6); // 刚好等于上限，允许
        vm.stopPrank();
        assertEq(vault.balanceOf(alice), 500 * 10 ** 6);
    }

    function test_RevertWhen_NonOwnerSetsCap() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.setPerUserCap(1);
    }

    // ---- 撮合结果的链上结算（模拟两个地址完成一笔成交）----
    function test_SettleMovesBalanceBetweenTwoTraders() public {
        _approveAndDeposit(alice, 1_000 * 10 ** 6);
        _approveAndDeposit(bob, 1_000 * 10 ** 6);

        bytes32 tradeRef = keccak256("trade-1");
        vm.prank(operator);
        vault.settle(alice, bob, 250 * 10 ** 6, tradeRef);

        assertEq(vault.balanceOf(alice), 750 * 10 ** 6);
        assertEq(vault.balanceOf(bob), 1_250 * 10 ** 6);
        // 总量守恒：operator 无法凭空印钱
        assertEq(vault.balanceOf(alice) + vault.balanceOf(bob), 2_000 * 10 ** 6);
    }

    function test_RevertWhen_NonOperatorSettles() public {
        _approveAndDeposit(alice, 1_000 * 10 ** 6);
        vm.prank(alice);
        vm.expectRevert(Vault.NotOperator.selector);
        vault.settle(alice, bob, 1 * 10 ** 6, keccak256("x"));
    }

    function test_RevertWhen_SettleExceedsBalance() public {
        _approveAndDeposit(alice, 100 * 10 ** 6);
        vm.prank(operator);
        vm.expectRevert(Vault.InsufficientBalance.selector);
        vault.settle(alice, bob, 200 * 10 ** 6, keccak256("x"));
    }

    // ---- 暂停 ----
    function test_PauseBlocksDepositAndWithdraw() public {
        _approveAndDeposit(alice, 100 * 10 ** 6);
        vault.pause();

        vm.startPrank(alice);
        usdc.approve(address(vault), 100 * 10 ** 6);
        vm.expectRevert();
        vault.deposit(100 * 10 ** 6);
        vm.expectRevert();
        vault.withdraw(10 * 10 ** 6);
        vm.stopPrank();

        vault.unpause();
        vm.prank(alice);
        vault.withdraw(10 * 10 ** 6);
        assertEq(vault.balanceOf(alice), 90 * 10 ** 6);
    }

    // ---- SECURITY_REVIEW.md Finding #1 回归测试：fee-on-transfer token 记账修复 ----
    function test_Security_DepositRecordsActualReceivedAmount_NotFeeOnTransferAmount() public {
        FeeOnTransferToken fot = new FeeOnTransferToken(1_000_000 ether);
        Vault fotVault = new Vault(address(fot), owner, operator);

        fot.transfer(alice, 2_000 ether); // 转账本身也收 2% 税，alice 实际到手 1960 ether

        vm.startPrank(alice);
        fot.approve(address(fotVault), 1_000 ether);
        fotVault.deposit(1_000 ether); // 名义存 1000，实际到账 980（2% 税）
        vm.stopPrank();

        // 修复后：内部记账 = 实际到账数量，而不是名义传入的 1000
        assertEq(fotVault.balanceOf(alice), 980 ether);
        // 合约实际持有的代币数量应该和内部记账完全一致（不会出现"欠条超发"）
        assertEq(fot.balanceOf(address(fotVault)), fotVault.balanceOf(alice));

        // alice 依然可以按记账余额完整提现，不会因为记账错误导致后来者取不出钱
        vm.prank(alice);
        fotVault.withdraw(980 ether);
        assertEq(fotVault.balanceOf(alice), 0);
    }

    function testFuzz_DepositWithdraw_NeverCreatesOrDestroysValue(uint256 depositAmt, uint256 withdrawAmt) public {
        depositAmt = bound(depositAmt, 1, 10_000 * 10 ** 6);
        withdrawAmt = bound(withdrawAmt, 1, depositAmt);

        _approveAndDeposit(alice, depositAmt);
        vm.prank(alice);
        vault.withdraw(withdrawAmt);

        assertEq(vault.balanceOf(alice), depositAmt - withdrawAmt);
        assertEq(usdc.balanceOf(address(vault)), depositAmt - withdrawAmt);
    }
}
