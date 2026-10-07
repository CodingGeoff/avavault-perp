// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IUniswapV2Router02} from "./interfaces/IUniswapV2.sol";

/// @title MultiCollateralVault — 黑客松项目核心合约
/// @notice 把训练营三节课学到的东西拼成一个真实可用的组件：
///   - Task3（DEX Oracle）：抵押品的估值来自 DEX 实时价格（getAmountsOut），而不是写死的数字；
///   - Task5（RWA Token）：允许把"现实世界资产收益权"代币化后的 Token 直接作为保证金存入；
///   - Task7（Perp Dex Vault）：沿用同样的"链下撮合、链上净额结算"模型，operator 只能在已有
///     余额之间转移，不能凭空印钱。
///
/// 也就是说：用户可以把手里的房产租金收益权 Token（RWA）当保证金，去交易一个永续合约，
/// 而这个 RWA Token 值多少钱，是实时从链上 DEX 池子里读出来的，全程无需人工报价。
contract MultiCollateralVault is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    struct CollateralConfig {
        bool active;
        address router; // 用于计价的 UniswapV2 兼容路由（例如 LFJ V1）
        address quoteToken; // 计价锚定资产，通常是 WAVAX 或某个稳定币
        uint16 haircutBps; // 折价率：例如 7000 = 只按 70% 的市值计入可用保证金，为价格波动和流动性风险留缓冲
    }

    mapping(address => CollateralConfig) public collateralConfigs;
    address[] public supportedCollaterals;

    /// user => token => 存入的原始数量
    mapping(address => mapping(address => uint256)) public rawBalance;

    address public operator;

    event CollateralListed(address indexed token, address router, address quoteToken, uint16 haircutBps);
    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event Settled(address indexed from, address indexed to, address indexed token, uint256 amount, bytes32 tradeRef);
    event OperatorUpdated(address indexed newOperator);

    error CollateralNotActive();
    error ZeroAmount();
    error InsufficientBalance();
    error NotOperator();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address initialOwner, address initialOperator) Ownable(initialOwner) {
        operator = initialOperator;
    }

    // ---------------------------------------------------------------
    // 管理员：登记可以作为保证金的资产
    // ---------------------------------------------------------------
    function listCollateral(address token, address router, address quoteToken, uint16 haircutBps)
        external
        onlyOwner
    {
        require(haircutBps > 0 && haircutBps <= 10_000, "invalid haircut");
        bool isNew = !collateralConfigs[token].active && collateralConfigs[token].router == address(0);
        collateralConfigs[token] = CollateralConfig({
            active: true,
            router: router,
            quoteToken: quoteToken,
            haircutBps: haircutBps
        });
        if (isNew) supportedCollaterals.push(token);
        emit CollateralListed(token, router, quoteToken, haircutBps);
    }

    function setCollateralActive(address token, bool active) external onlyOwner {
        collateralConfigs[token].active = active;
    }

    function setOperator(address newOperator) external onlyOwner {
        operator = newOperator;
        emit OperatorUpdated(newOperator);
    }

    // ---------------------------------------------------------------
    // 用户存取
    // ---------------------------------------------------------------
    function deposit(address token, uint256 amount) external nonReentrant whenNotPaused {
        if (!collateralConfigs[token].active) revert CollateralNotActive();
        if (amount == 0) revert ZeroAmount();

        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore; // 防 fee-on-transfer 记账错误

        rawBalance[msg.sender][token] += received;
        emit Deposited(msg.sender, token, received);
    }

    function withdraw(address token, uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = rawBalance[msg.sender][token];
        if (bal < amount) revert InsufficientBalance();

        rawBalance[msg.sender][token] = bal - amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, token, amount);
    }

    /// @notice operator 在两个用户之间结算同一种资产的余额变化（撮合成交/盈亏转移）
    function settle(address from, address to, address token, uint256 amount, bytes32 tradeRef)
        external
        onlyOperator
        whenNotPaused
    {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = rawBalance[from][token];
        if (bal < amount) revert InsufficientBalance();

        rawBalance[from][token] = bal - amount;
        rawBalance[to][token] += amount;
        emit Settled(from, to, token, amount, tradeRef);
    }

    // ---------------------------------------------------------------
    // 只读：账户在所有抵押品类型下的美元计价总市值（用于保证金率计算）
    // ---------------------------------------------------------------

    /// @notice 单个资产按 DEX 实时价格折算成"以 quoteToken 计价、含折价率"的价值
    function collateralValue(address user, address token) public view returns (uint256 valueInQuote18) {
        uint256 amount = rawBalance[user][token];
        if (amount == 0) return 0;

        CollateralConfig memory cfg = collateralConfigs[token];
        if (!cfg.active) return 0;

        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = cfg.quoteToken;
        uint256[] memory amounts = IUniswapV2Router02(cfg.router).getAmountsOut(amount, path);
        uint256 rawQuoteValue = amounts[1];

        return (rawQuoteValue * cfg.haircutBps) / 10_000;
    }

    /// @notice 账户跨所有抵押品类型的总保证金价值（quoteToken 计价，例如 WAVAX 的最小单位）
    function totalAccountValue(address user) external view returns (uint256 total) {
        uint256 len = supportedCollaterals.length;
        for (uint256 i = 0; i < len; i++) {
            total += collateralValue(user, supportedCollaterals[i]);
        }
    }

    function supportedCollateralsCount() external view returns (uint256) {
        return supportedCollaterals.length;
    }
}
