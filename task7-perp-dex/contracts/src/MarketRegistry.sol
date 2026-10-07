// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MarketRegistry — Perp Dex 的市场元数据登记表
/// @notice 参考 Primit 的产品形态：一个永续合约交易所需要登记"支持哪些市场、
///         每个市场的价格从哪里来、最大杠杆是多少"。撮合本身发生在链下的
///         matching-engine（见 ../matching-engine），链上只需要记录最终结算需要的元数据，
///         并作为 Vault 结算时校验市场是否合法开启的依据。
contract MarketRegistry is Ownable {
    struct Market {
        string symbol; // 例如 "AVAX-PERP"
        address priceOracle; // 该市场的标记价格来源（可指向 Task3 里的 DEX 价格合约，或 Chainlink Feed）
        uint16 maxLeverage; // 例如 20 表示 20x
        uint16 maintenanceMarginBps; // 维持保证金率，例如 500 = 5%
        bool active;
    }

    mapping(bytes32 => Market) public markets; // key = keccak256(symbol)
    bytes32[] public marketKeys;

    event MarketListed(bytes32 indexed key, string symbol, address priceOracle, uint16 maxLeverage);
    event MarketStatusUpdated(bytes32 indexed key, bool active);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function listMarket(string calldata symbol, address priceOracle, uint16 maxLeverage, uint16 maintenanceMarginBps)
        external
        onlyOwner
        returns (bytes32 key)
    {
        require(maxLeverage > 0 && maxLeverage <= 100, "leverage out of range");
        require(maintenanceMarginBps > 0 && maintenanceMarginBps < 10_000, "invalid margin");
        key = keccak256(bytes(symbol));
        require(bytes(markets[key].symbol).length == 0, "already listed");

        markets[key] = Market({
            symbol: symbol,
            priceOracle: priceOracle,
            maxLeverage: maxLeverage,
            maintenanceMarginBps: maintenanceMarginBps,
            active: true
        });
        marketKeys.push(key);

        emit MarketListed(key, symbol, priceOracle, maxLeverage);
    }

    function setMarketActive(string calldata symbol, bool active) external onlyOwner {
        bytes32 key = keccak256(bytes(symbol));
        require(bytes(markets[key].symbol).length != 0, "not listed");
        markets[key].active = active;
        emit MarketStatusUpdated(key, active);
    }

    function isActive(string calldata symbol) external view returns (bool) {
        return markets[keccak256(bytes(symbol))].active;
    }

    function marketCount() external view returns (uint256) {
        return marketKeys.length;
    }
}
