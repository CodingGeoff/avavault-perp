// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Vault — Mini Perp-Dex 的保证金金库
/// @notice 架构：撮合本身发生在链下（见 ../matching-engine 的价格-时间优先撮合引擎），
///         链上 Vault 只负责三件事：
///           1) 用户自主 deposit / withdraw 保证金（USDC），资金始终由用户自己控制；
///           2) 记录每个地址的可用余额，并支持 owner 设置硬上限（风控/演示用）；
///           3) 由一个受信任的 `operator`（代表链下撮合引擎）在两个地址间做净额结算
///              （settle），把"链下撮合出的成交结果"落地为链上余额变化。
///         operator 只能在已有余额之间转移，不能凭空铸造资金，因此即使 operator
///         被攻破，最坏情况也只是"重新分配已存入的资金"，不可能超发。
contract Vault is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    IERC20 public immutable collateralToken;
    address public operator;

    mapping(address => uint256) public balanceOf;

    /// @notice 单个地址允许存入的最大余额（0 表示不限制）。风控/演示用的硬上限。
    uint256 public perUserCap;

    event Deposited(address indexed user, uint256 amount, uint256 newBalance);
    event Withdrawn(address indexed user, uint256 amount, uint256 newBalance);
    event Settled(address indexed from, address indexed to, uint256 amount, bytes32 indexed tradeRef);
    event OperatorUpdated(address indexed newOperator);
    event PerUserCapUpdated(uint256 newCap);

    error CapExceeded();
    error InsufficientBalance();
    error NotOperator();
    error ZeroAmount();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address collateralToken_, address initialOwner, address initialOperator) Ownable(initialOwner) {
        collateralToken = IERC20(collateralToken_);
        operator = initialOperator;
    }

    // ---------------------------------------------------------------
    // 用户自助存取
    // ---------------------------------------------------------------

    /// @dev 安全修复（见 SECURITY_REVIEW.md Finding #1）：不能直接相信外部传入的 `amount`
    ///      去累加内部余额，因为通缩型/收手续费的 ERC20（fee-on-transfer token）实际到账
    ///      数量会小于 `amount`，若直接按 `amount` 记账，会导致 Vault 的内部余额总和超过
    ///      实际持有的代币数量，最终导致后来的用户无法完整提现（资不抵债）。
    ///      这里改为用"转账前后 Vault 自身余额的差值"作为真实入账数量。
    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();

        uint256 balanceBefore = collateralToken.balanceOf(address(this));
        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = collateralToken.balanceOf(address(this)) - balanceBefore;
        if (received == 0) revert ZeroAmount();

        uint256 newBalance = balanceOf[msg.sender] + received;
        if (perUserCap != 0 && newBalance > perUserCap) revert CapExceeded();

        balanceOf[msg.sender] = newBalance;

        emit Deposited(msg.sender, received, newBalance);
    }

    function withdraw(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf[msg.sender];
        if (bal < amount) revert InsufficientBalance();

        balanceOf[msg.sender] = bal - amount;
        collateralToken.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount, bal - amount);
    }

    // ---------------------------------------------------------------
    // 链下撮合结果的链上净额结算（仅 operator）
    // ---------------------------------------------------------------

    /// @param tradeRef 对应链下 matching-engine 里的 trade id（哈希后存证，便于审计核对）
    function settle(address from, address to, uint256 amount, bytes32 tradeRef) external onlyOperator whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf[from];
        if (bal < amount) revert InsufficientBalance();

        balanceOf[from] = bal - amount;
        balanceOf[to] += amount;

        emit Settled(from, to, amount, tradeRef);
    }

    // ---------------------------------------------------------------
    // 管理员操作
    // ---------------------------------------------------------------

    function setOperator(address newOperator) external onlyOwner {
        operator = newOperator;
        emit OperatorUpdated(newOperator);
    }

    function setPerUserCap(uint256 newCap) external onlyOwner {
        perUserCap = newCap;
        emit PerUserCapUpdated(newCap);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
