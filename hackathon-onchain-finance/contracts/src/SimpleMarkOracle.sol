// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SimpleMarkOracle — 治理设定的标记价预言机（PerpMarginAccount 的 IMarkPriceOracle 实现）
/// @notice 最小可用实现：由 owner（生产环境应换成多签/喂价服务）设定标记价，
///         每次更新带时间戳，读取方可以自行判断价格是否过期。真实部署时建议
///         把 setter 换成 TWAP 预言机合约或 Chainlink 风格的聚合喂价，本接口不变。
contract SimpleMarkOracle {
    address public owner;
    uint256 public price;
    uint256 public updatedAt;

    event PriceUpdated(uint256 price, uint256 updatedAt);
    event OwnerUpdated(address owner);

    error NotOwner();
    error ZeroPrice();

    constructor(uint256 initialPrice) {
        if (initialPrice == 0) revert ZeroPrice();
        owner = msg.sender;
        price = initialPrice;
        updatedAt = block.timestamp;
        emit PriceUpdated(initialPrice, block.timestamp);
    }

    function setPrice(uint256 newPrice) external {
        if (msg.sender != owner) revert NotOwner();
        if (newPrice == 0) revert ZeroPrice();
        price = newPrice;
        updatedAt = block.timestamp;
        emit PriceUpdated(newPrice, block.timestamp);
    }

    function setOwner(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        owner = newOwner;
        emit OwnerUpdated(newOwner);
    }

    /// @notice 与 PerpMarginAccount.IMarkPriceOracle 对齐
    function getMarkPrice() external view returns (uint256) {
        return price;
    }
}
