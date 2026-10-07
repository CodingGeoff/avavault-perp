// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {MultiCollateralVault} from "../src/MultiCollateralVault.sol";
import {RWAToken} from "../src/RWAToken.sol";
import {IUniswapV2Router02, IUniswapV2Factory} from "../src/interfaces/IUniswapV2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Fork 测试：在真实 Fuji 状态上，用真实的 LFJ V1 Router/Factory 创建一个全新的
///         WAVAX/RWA 交易对并注入流动性，验证 MultiCollateralVault 能够把 RWA Token
///         按照 DEX 实时价格、扣除折价率后，正确计入用户的可用保证金价值。
contract MultiCollateralVaultForkTest is Test {
    address constant ROUTER = 0xd7f655E3376cE2D7A2b08fF01Eb3B1023191A901; // LFJ V1 Router (Fuji)
    address constant FACTORY = 0xF5c7d9733e5f53abCC1695820c4818C59B457C2C; // LFJ V1 Factory (Fuji)
    address constant WAVAX = 0xd00ae08403B9bbb9124bB305C09058E32C39A48c;

    MultiCollateralVault vault;
    RWAToken rwa;
    address deployer = address(this);
    address operator = address(0xE0FE1A705);
    address alice = address(0xA11CE);

    receive() external payable {}

    function setUp() public {
        string memory rpc = vm.envOr("FUJI_RPC_URL", string("https://api.avax-test.network/ext/bc/C/rpc"));
        vm.createSelectFork(rpc);

        rwa = new RWAToken("Shibuya Tower Rental Rights", "SRT-RWA", 1_000_000 ether);
        vault = new MultiCollateralVault(deployer, operator);

        // 用 70% 折价率登记 RWA Token 作为可用保证金资产
        vault.listCollateral(address(rwa), ROUTER, WAVAX, 7000);

        // 真实在 Fuji 上创建 WAVAX/RWA 交易对并注入流动性：1000 AVAX : 500,000 RWA
        vm.deal(deployer, 2_000 ether);
        rwa.approve(ROUTER, 500_000 ether);
        IUniswapV2Router02(ROUTER).addLiquidityAVAX{value: 1_000 ether}(
            address(rwa), 500_000 ether, 0, 0, deployer, block.timestamp + 3600
        );

        address pair = IUniswapV2Factory(FACTORY).getPair(address(rwa), WAVAX);
        assertTrue(pair != address(0));
    }

    function test_CollateralValueComesFromLiveDexPrice() public {
        rwa.transfer(alice, 10_000 ether);
        vm.startPrank(alice);
        rwa.approve(address(vault), 10_000 ether);
        vault.deposit(address(rwa), 10_000 ether);
        vm.stopPrank();

        // 10,000 RWA 在 1,000:500,000 的池子里，理论现货价值 ≈ 10,000 / 500,000 * 1,000 = 20 AVAX
        // 乘以 70% 折价率 ≈ 14 AVAX
        uint256 value = vault.collateralValue(alice, address(rwa));
        assertApproxEqRel(value, 14 ether, 0.03e18); // 3% 容差（DEX 内部手续费+滑点）
        console.log("RWA collateral value (in AVAX terms, after 70% haircut):", value / 1e15, "* 1e-3");
    }

    function test_CollateralValueDropsAfterPriceMovesAgainstIt() public {
        rwa.transfer(alice, 10_000 ether);
        vm.startPrank(alice);
        rwa.approve(address(vault), 10_000 ether);
        vault.deposit(address(rwa), 10_000 ether);
        vm.stopPrank();

        uint256 valueBefore = vault.collateralValue(alice, address(rwa));

        // 有人在 DEX 上抛售大量 RWA 换 AVAX，把 RWA 价格砸下去
        address seller = address(0xDEAD);
        rwa.transfer(seller, 200_000 ether);
        vm.startPrank(seller);
        rwa.approve(ROUTER, 200_000 ether);
        address[] memory path = new address[](2);
        path[0] = address(rwa);
        path[1] = WAVAX;
        IUniswapV2Router02(ROUTER).swapExactTokensForAVAX(200_000 ether, 0, path, seller, block.timestamp + 3600);
        vm.stopPrank();

        uint256 valueAfter = vault.collateralValue(alice, address(rwa));
        assertLt(valueAfter, valueBefore, "collateral value should drop after RWA price crashes on DEX");
        console.log("value before:", valueBefore, "value after:", valueAfter);
    }

    function test_MultiUserSettlementPreservesTotalValue() public {
        address bob = address(0xB0B);
        rwa.transfer(alice, 10_000 ether);
        rwa.transfer(bob, 0); // bob starts with none, will receive via settle

        vm.startPrank(alice);
        rwa.approve(address(vault), 10_000 ether);
        vault.deposit(address(rwa), 10_000 ether);
        vm.stopPrank();

        vm.prank(operator);
        vault.settle(alice, bob, address(rwa), 4_000 ether, keccak256("hackathon-demo-trade"));

        assertEq(vault.rawBalance(alice, address(rwa)), 6_000 ether);
        assertEq(vault.rawBalance(bob, address(rwa)), 4_000 ether);
    }

    function test_RevertWhen_DepositingUnlistedCollateral() public {
        RWAToken other = new RWAToken("Other", "OTH", 1_000 ether);
        other.approve(address(vault), 100 ether);
        vm.expectRevert(MultiCollateralVault.CollateralNotActive.selector);
        vault.deposit(address(other), 100 ether);
    }

    function test_WithdrawReturnsRawTokens() public {
        rwa.transfer(alice, 1_000 ether);
        vm.startPrank(alice);
        rwa.approve(address(vault), 1_000 ether);
        vault.deposit(address(rwa), 1_000 ether);
        vault.withdraw(address(rwa), 400 ether);
        vm.stopPrank();

        assertEq(rwa.balanceOf(alice), 400 ether);
        assertEq(vault.rawBalance(alice, address(rwa)), 600 ether);
    }
}
