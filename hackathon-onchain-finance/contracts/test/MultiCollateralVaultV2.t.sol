// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {MultiCollateralVaultV2} from "../src/MultiCollateralVaultV2.sol";
import {RWAToken} from "../src/RWAToken.sol";
import {IUniswapV2Router02, IUniswapV2Factory} from "../src/interfaces/IUniswapV2.sol";

/// @notice 真实 Fuji fork 测试，验证 V2 相对 V1 修复的两个问题：
///   1. collateralValue() 按 TWAP 而不是瞬时价格估值，抵御同笔交易内的闪电贷式操纵；
///   2. settle() 需要被扣款方的 EIP-712 签名授权，operator 私钥泄露也无法任意转移用户资产。
contract MultiCollateralVaultV2ForkTest is Test {
    address constant ROUTER = 0xd7f655E3376cE2D7A2b08fF01Eb3B1023191A901;
    address constant WAVAX = 0xd00ae08403B9bbb9124bB305C09058E32C39A48c;

    MultiCollateralVaultV2 vault;
    RWAToken rwa;
    address deployer = address(this);
    address operator = address(0xE0FE1A705);
    address alice;
    uint256 alicePk;
    address bob = address(0xB0B);
    address attacker = address(0xA77ACC);

    receive() external payable {}

    function setUp() public {
        string memory rpc = vm.envOr("FUJI_RPC_URL", string("https://api.avax-test.network/ext/bc/C/rpc"));
        vm.createSelectFork(rpc);

        (alice, alicePk) = makeAddrAndKey("alice");

        rwa = new RWAToken("Shibuya Tower Rental Rights", "SRT-RWA", 1_000_000 ether);
        vault = new MultiCollateralVaultV2(deployer, operator, 60); // 60 秒最短 TWAP 周期

        vm.deal(deployer, 2_000 ether);
        rwa.approve(ROUTER, 500_000 ether);
        IUniswapV2Router02(ROUTER).addLiquidityAVAX{value: 1_000 ether}(
            address(rwa), 500_000 ether, 0, 0, deployer, block.timestamp + 3600
        );

        vault.listCollateral(address(rwa), ROUTER, WAVAX, 7000);

        rwa.transfer(alice, 10_000 ether);
        vm.deal(attacker, 200 ether);
    }

    function _depositAsAlice(uint256 amount) internal {
        vm.startPrank(alice);
        rwa.approve(address(vault), amount);
        vault.deposit(address(rwa), amount);
        vm.stopPrank();
    }

    function test_CollateralValueIsZero_UntilTwapWarmedUp() public {
        _depositAsAlice(10_000 ether);
        // 刚存款、TWAP 还没有任何历史窗口 -> 保守地算作 0，而不是退回一个可能被操纵的瞬时价
        assertEq(vault.collateralValue(alice, address(rwa)), 0);
    }

    function test_CollateralValueUsesTwap_AfterWarmUp() public {
        _depositAsAlice(10_000 ether);
        vm.warp(block.timestamp + 61);
        vault.pokeOracle(address(rwa));

        uint256 value = vault.collateralValue(alice, address(rwa));
        // 10,000 RWA / 500,000 RWA 池子份额 * 1,000 AVAX ≈ 20 AVAX，再乘 70% haircut ≈ 14 AVAX
        assertApproxEqRel(value, 14 ether, 0.03e18);
    }

    /// @notice 核心安全证据：攻击者在 TWAP 窗口内用大额 swap 操纵 RWA 现价，但只要 TWAP 还没有
    ///         被推进到反映操纵后的状态，`collateralValue` 依然使用操纵前的历史均价，不会被同笔
    ///         交易内的价格波动影响。
    function test_CollateralValueResistsSameWindowManipulation() public {
        _depositAsAlice(10_000 ether);
        vm.warp(block.timestamp + 61);
        vault.pokeOracle(address(rwa));
        uint256 valueBefore = vault.collateralValue(alice, address(rwa));

        // 攻击者砸盘操纵 RWA 现价
        vm.startPrank(attacker);
        address[] memory path = new address[](2);
        path[0] = WAVAX;
        path[1] = address(rwa);
        IUniswapV2Router02(ROUTER).swapExactAVAXForTokens{value: 100 ether}(0, path, attacker, block.timestamp + 3600);
        vm.stopPrank();

        // TWAP 窗口还没到下一次刷新的时间点，collateralValue 应该完全不受这笔操纵影响
        uint256 valueDuringManipulation = vault.collateralValue(alice, address(rwa));
        assertEq(valueBefore, valueDuringManipulation);
        console.log("value before manipulation:", valueBefore);
        console.log("value during (unaffected) manipulation:", valueDuringManipulation);
    }

    function _sign(uint256 pk, address from, address token, uint256 maxAmount, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = vault.hashAuthorization(from, token, maxAmount, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_SettleWithValidAuthorization_Succeeds() public {
        _depositAsAlice(10_000 ether);
        bytes memory sig = _sign(alicePk, alice, address(rwa), 5_000 ether, 1, block.timestamp + 1 hours);

        vm.prank(operator);
        vault.settleWithAuthorization(
            alice, bob, address(rwa), 4_000 ether, keccak256("trade-1"), 5_000 ether, 1, block.timestamp + 1 hours, sig
        );

        assertEq(vault.rawBalance(alice, address(rwa)), 6_000 ether);
        assertEq(vault.rawBalance(bob, address(rwa)), 4_000 ether);
    }

    function test_RevertWhen_ForgedSignature_OperatorCannotStealFunds() public {
        _depositAsAlice(10_000 ether);
        // 用一个跟 alice 无关的随机私钥签名，冒充 alice 的授权
        bytes32 digest = vault.hashAuthorization(alice, address(rwa), 5_000 ether, 1, block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBEEF, digest);
        bytes memory forgedSig = abi.encodePacked(r, s, v);

        vm.prank(operator);
        vm.expectRevert(MultiCollateralVaultV2.InvalidSignature.selector);
        vault.settleWithAuthorization(
            alice, bob, address(rwa), 4_000 ether, keccak256("trade-1"), 5_000 ether, 1, block.timestamp + 1 hours, forgedSig
        );

        assertEq(vault.rawBalance(alice, address(rwa)), 10_000 ether);
    }

    function test_RevertWhen_ExceedingAuthorizedMaxAmount() public {
        _depositAsAlice(10_000 ether);
        bytes memory sig = _sign(alicePk, alice, address(rwa), 3_000 ether, 1, block.timestamp + 1 hours);

        vm.startPrank(operator);
        vault.settleWithAuthorization(
            alice, bob, address(rwa), 2_000 ether, keccak256("fill-1"), 3_000 ether, 1, block.timestamp + 1 hours, sig
        );
        vm.expectRevert(MultiCollateralVaultV2.AuthorizationExceeded.selector);
        vault.settleWithAuthorization(
            alice, bob, address(rwa), 2_000 ether, keccak256("fill-2"), 3_000 ether, 1, block.timestamp + 1 hours, sig
        );
        vm.stopPrank();
    }

    function test_RevertWhen_CancelledAuthorization() public {
        _depositAsAlice(10_000 ether);
        bytes memory sig = _sign(alicePk, alice, address(rwa), 3_000 ether, 9, block.timestamp + 1 hours);

        vm.prank(alice);
        vault.cancelAuthorization(address(rwa), 9);

        vm.prank(operator);
        vm.expectRevert(MultiCollateralVaultV2.AuthorizationCancelledError.selector);
        vault.settleWithAuthorization(
            alice, bob, address(rwa), 1_000 ether, keccak256("trade-1"), 3_000 ether, 9, block.timestamp + 1 hours, sig
        );
    }

    function test_WithdrawReturnsRawTokens() public {
        uint256 balanceBeforeDeposit = rwa.balanceOf(alice); // alice 在 setUp 里已经持有 10,000 RWA
        _depositAsAlice(1_000 ether);
        vm.prank(alice);
        vault.withdraw(address(rwa), 400 ether);
        assertEq(rwa.balanceOf(alice), balanceBeforeDeposit - 1_000 ether + 400 ether);
        assertEq(vault.rawBalance(alice, address(rwa)), 600 ether);
    }
}
