// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VaultV2} from "../src/VaultV2.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract VaultV2Test is Test {
    VaultV2 vault;
    MockUSDC usdc;

    address owner = address(this);
    address operator = address(0x0FE12A705);
    address alice;
    uint256 alicePk;
    address bob = address(0xB0B);
    address eve = address(0xE5E); // attacker who steals the operator key but not any user's key

    function setUp() public {
        (alice, alicePk) = makeAddrAndKey("alice");

        usdc = new MockUSDC(1_000_000 * 10 ** 6);
        vault = new VaultV2(address(usdc), owner, operator);

        usdc.transfer(alice, 10_000 * 10 ** 6);
        usdc.transfer(bob, 10_000 * 10 ** 6);

        vm.startPrank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(1_000 * 10 ** 6);
        vm.stopPrank();

        vm.startPrank(bob);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(1_000 * 10 ** 6);
        vm.stopPrank();
    }

    function _sign(uint256 pk, address from, uint256 maxAmount, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = vault.hashAuthorization(from, maxAmount, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_SettleWithValidAuthorization_Succeeds() public {
        bytes memory sig = _sign(alicePk, alice, 500 * 10 ** 6, 1, block.timestamp + 1 hours);

        vm.prank(operator);
        vault.settleWithAuthorization(alice, bob, 200 * 10 ** 6, keccak256("trade-1"), 500 * 10 ** 6, 1, block.timestamp + 1 hours, sig);

        assertEq(vault.balanceOf(alice), 800 * 10 ** 6);
        assertEq(vault.balanceOf(bob), 1_200 * 10 ** 6);
    }

    function test_SamePreSignedAuthorization_CanCoverMultiplePartialFills() public {
        uint256 maxAmount = 500 * 10 ** 6;
        uint256 nonce = 42;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(alicePk, alice, maxAmount, nonce, deadline);

        vm.startPrank(operator);
        vault.settleWithAuthorization(alice, bob, 200 * 10 ** 6, keccak256("fill-1"), maxAmount, nonce, deadline, sig);
        vault.settleWithAuthorization(alice, bob, 300 * 10 ** 6, keccak256("fill-2"), maxAmount, nonce, deadline, sig);
        vm.stopPrank();

        assertEq(vault.usedAmount(alice, nonce), 500 * 10 ** 6);
        assertEq(vault.balanceOf(alice), 500 * 10 ** 6);
    }

    function test_RevertWhen_ExceedingAuthorizedMaxAmount() public {
        uint256 maxAmount = 300 * 10 ** 6;
        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(alicePk, alice, maxAmount, nonce, deadline);

        vm.startPrank(operator);
        vault.settleWithAuthorization(alice, bob, 200 * 10 ** 6, keccak256("fill-1"), maxAmount, nonce, deadline, sig);
        vm.expectRevert(VaultV2.AuthorizationExceeded.selector);
        vault.settleWithAuthorization(alice, bob, 200 * 10 ** 6, keccak256("fill-2"), maxAmount, nonce, deadline, sig);
        vm.stopPrank();
    }

    function test_RevertWhen_AuthorizationExpired() public {
        uint256 deadline = block.timestamp + 10;
        bytes memory sig = _sign(alicePk, alice, 500 * 10 ** 6, 1, deadline);

        vm.warp(block.timestamp + 11);
        vm.prank(operator);
        vm.expectRevert(VaultV2.AuthorizationExpired.selector);
        vault.settleWithAuthorization(alice, bob, 100 * 10 ** 6, keccak256("trade-1"), 500 * 10 ** 6, 1, deadline, sig);
    }

    function test_RevertWhen_UserCancelledAuthorization() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _sign(alicePk, alice, 500 * 10 ** 6, 7, deadline);

        vm.prank(alice);
        vault.cancelAuthorization(7);

        vm.prank(operator);
        vm.expectRevert(VaultV2.AuthorizationCancelledError.selector);
        vault.settleWithAuthorization(alice, bob, 100 * 10 ** 6, keccak256("trade-1"), 500 * 10 ** 6, 7, deadline, sig);
    }

    /// @notice 核心安全证据：即使攻击者拿到了 operator 的私钥，没有 alice 本人的签名，
    ///         也无法凭空转走 alice 的资金——这正是相对 V1（只要是 operator 调用就无条件放行）的本质提升。
    function test_RevertWhen_OperatorTriesToForgeAuthorization_WithoutUsersSignature() public {
        // 攻击者（即使就是 operator 本人作恶）伪造一个签名——用一个随机私钥而不是 alice 的私钥
        uint256 randomPk = 0xBEEF;
        bytes32 digest = vault.hashAuthorization(alice, 500 * 10 ** 6, 1, block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(randomPk, digest);
        bytes memory forgedSig = abi.encodePacked(r, s, v);

        vm.prank(operator);
        vm.expectRevert(VaultV2.InvalidSignature.selector);
        vault.settleWithAuthorization(alice, bob, 200 * 10 ** 6, keccak256("trade-1"), 500 * 10 ** 6, 1, block.timestamp + 1 hours, forgedSig);

        // alice 的余额分毫未动
        assertEq(vault.balanceOf(alice), 1_000 * 10 ** 6);
    }

    function test_RevertWhen_NonOperatorCallsSettle() public {
        bytes memory sig = _sign(alicePk, alice, 500 * 10 ** 6, 1, block.timestamp + 1 hours);
        vm.prank(eve);
        vm.expectRevert(VaultV2.NotOperator.selector);
        vault.settleWithAuthorization(alice, bob, 200 * 10 ** 6, keccak256("trade-1"), 500 * 10 ** 6, 1, block.timestamp + 1 hours, sig);
    }

    function test_DepositWithdrawStillWork() public {
        vm.prank(alice);
        vault.withdraw(400 * 10 ** 6);
        assertEq(vault.balanceOf(alice), 600 * 10 ** 6);
        assertEq(usdc.balanceOf(alice), 10_000 * 10 ** 6 - 1_000 * 10 ** 6 + 400 * 10 ** 6);
    }

    function test_PerUserCap_BlocksExcessDeposit() public {
        vault.setPerUserCap(1_200 * 10 ** 6);
        vm.startPrank(alice);
        vm.expectRevert(VaultV2.CapExceeded.selector);
        vault.deposit(300 * 10 ** 6);
        vm.stopPrank();
    }
}
