// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";

contract MarketRegistryTest is Test {
    MarketRegistry registry;
    address owner = address(this);
    address oracle = address(0x0AACE);
    address stranger = address(0x5717A7);

    function setUp() public {
        registry = new MarketRegistry(owner);
    }

    function test_ListMarket() public {
        bytes32 key = registry.listMarket("AVAX-PERP", oracle, 20, 500);
        (string memory symbol, address priceOracle, uint16 maxLeverage, uint16 mmBps, bool active) =
            registry.markets(key);
        assertEq(symbol, "AVAX-PERP");
        assertEq(priceOracle, oracle);
        assertEq(maxLeverage, 20);
        assertEq(mmBps, 500);
        assertTrue(active);
        assertEq(registry.marketCount(), 1);
    }

    function test_RevertWhen_DuplicateListing() public {
        registry.listMarket("AVAX-PERP", oracle, 20, 500);
        vm.expectRevert("already listed");
        registry.listMarket("AVAX-PERP", oracle, 10, 300);
    }

    function test_RevertWhen_LeverageOutOfRange() public {
        vm.expectRevert("leverage out of range");
        registry.listMarket("AVAX-PERP", oracle, 0, 500);
        vm.expectRevert("leverage out of range");
        registry.listMarket("AVAX-PERP", oracle, 101, 500);
    }

    function test_ToggleMarketActive() public {
        registry.listMarket("AVAX-PERP", oracle, 20, 500);
        assertTrue(registry.isActive("AVAX-PERP"));
        registry.setMarketActive("AVAX-PERP", false);
        assertFalse(registry.isActive("AVAX-PERP"));
    }

    function test_RevertWhen_NonOwnerLists() public {
        vm.prank(stranger);
        vm.expectRevert();
        registry.listMarket("AVAX-PERP", oracle, 20, 500);
    }
}
