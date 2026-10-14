# Render 免费层持久化完整指南（Litestream + Cloudflare R2）

## 先说清楚：为什么现在数据会丢

Render 免费 Web 服务的文件系统是**临时（ephemeral）**的：重新部署、手动重启、
甚至免费层休眠后被唤醒换实例，本地文件都会回到镜像里的初始状态。本项目的全部
状态（订单、成交、会话、仓位、保险基金、资金费）都在一个 SQLite 文件里
（`server/src/db.js`），所以文件一没，状态就没。

Render 自家的持久磁盘（Persistent Disk）只对付费套餐开放；它家的免费
Postgres 30 天后过期。所以"留在 Render + 完全免费 + 真持久"只有两条路：

| 路线 | 做什么 | 成本 | 改动量 |
| --- | --- | --- | --- |
| **A. Litestream → R2（本指南，推荐）** | SQLite 不动，Litestream 把 WAL 实时复制到 Cloudflare R2（免费 10GB），每次启动先恢复 | $0 | 零代码改动，只换部署方式 |
| B. 托管 Postgres（如 Neon 免费版） | 把 `db.js` 的 better-sqlite3 同步调用整体改写成 pg 异步 | $0 | 半天级重构 + 全套测试要重跑，演示前不要做 |
| C. Render 付费磁盘 | 套餐升 Starter 加 Persistent Disk 挂到 DB 目录 | 约 $7/月起 | 零改动，但不是免费 |

演示前（今晚/明天白天）什么都不用做：按 `DEPLOY.md` 里写的用 UptimeRobot
每 5 分钟 ping 一次 `/health` 保活、且不重新部署，同一个实例会一直跑，
数据在整个演示窗口内不会丢。本指南是演示之后再迁的长期方案。

## 路线 A 完整步骤（约 20 分钟）

仓库里已经备好三个文件（不影响现在的 Render 原生部署）：

- `Dockerfile.persistence` —— 在原 Dockerfile 基础上加装 Litestream 的镜像
- `litestream.yml` —— 复制规则（桶名/密钥全部走环境变量，不进仓库）
- `scripts/start-persistence.sh` —— 启动时先 restore、再以 replicate 托管服务

### 第 1 步：Cloudflare R2 建桶拿密钥（5 分钟）

1. 注册/登录 <https://dash.cloudflare.com>（免费账号即可）。
2. 左侧 **R2 Object Storage** → **Create bucket**，名字填 `avavault-perp-db`，
   位置选 Automatic → Create。
3. 回到 R2 概览页 → **Manage R2 API Tokens**（右上角）→ **Create API Token**：
   权限选 **Object Read & Write**，桶限定为刚建的 `avavault-perp-db` → 创建。
4. 创建成功页会显示三样东西，**先抄下来存好**（Secret 只显示一次）：
   - `Access Key ID`
   - `Secret Access Key`
   - 你的 S3 endpoint：`https://<你的Account ID>.r2.cloudflarestorage.com`
     （Account ID 在 R2 概览页右侧能看到）

### 第 2 步：Render 新建一个 Docker 服务（10 分钟）

1. <https://dashboard.render.com> → **New +** → **Web Service**。
2. 连接 `avavault-perp` 仓库，分支选 `main`（本指南文件合并进 main 后）。
3. **Runtime 选择 Docker**，**Dockerfile Path** 填 `./Dockerfile.persistence`。
4. Plan 选 **Free**。
5. **Environment Variables** 里填齐（前半和现在服务一样，后半是新增的）：

   ```
   FUJI_RPC_URL                   = https://api.avax-test.network/ext/bc/C/rpc
   VAULT_ADDRESS                  = 0x0425352bc3c5293D5629c27525969439Ab9C27b5
   VAULT_ABI_VERSION              = v2
   MULTICOLLATERAL_VAULT_ADDRESS  = 0xb999cb61A4fb2FE71d1C5FBA7aD506F619dD7884
   MARGIN_ENFORCE                 = false
   FUNDING_INTERVAL_MS            = 28800000
   FUNDING_MAX_BPS                = 10
   OPERATOR_PRIVATE_KEY           = （和现有服务里填的同一个，别贴到任何公开场合）
   DB_PATH                        = /data/mini-dex.sqlite
   R2_BUCKET                      = avavault-perp-db
   R2_ENDPOINT                    = https://<Account ID>.r2.cloudflarestorage.com
   LITESTREAM_ACCESS_KEY_ID       = （第 1 步的 Access Key ID）
   LITESTREAM_SECRET_ACCESS_KEY   = （第 1 步的 Secret Access Key）
   ```

6. 点 **Create Web Service**，等构建完成（Docker 构建比原生慢，约 3~5 分钟）。
   日志里应该能看到 `[persistence] starting server under litestream replication`。

> 注意：不要删掉现有的原生服务。两个服务可以同时跑，前端指向哪个就用哪个；
> 新服务验证无误之前，旧的留着当备份。

### 第 3 步：验证真的持久（5 分钟，这步不许跳）

1. 打开新服务的 `/health`，确认正常；记下它的新 URL。
2. 在演示站把"高级设置 → API 地址"临时改成新 URL，登录、下几笔单、开个仓。
3. 去 Cloudflare R2 控制台看 `avavault-perp-db` 桶里是否出现 `mini-dex/` 开头的
   对象（有 = 备份在实时产生）。
4. 在 Render 控制台对新服务执行一次 **Restart**（服务页右上角菜单里），
   等它起来后刷新演示站：刚才的挂单、仓位、登录状态应当**原样还在**。
5. 四步都对，才算迁移完成。这时再把演示站默认 API 地址改成新 URL
   （改 `task7-perp-dex/demo/index.html` 里的默认值并发布），旧服务可以关掉。

## Caveats（诚实边界）

- **休眠还在**：这解决的是"丢数据"，不是"睡大觉"。免费层 15 分钟无流量照样
  休眠、冷启动照样 ~50 秒；配合 UptimeRobot 保活即可（`DEPLOY.md` 有写）。
- **最后 1 秒风险窗**：Litestream 按 1 秒间隔同步，进程收到 SIGTERM 时会做
  最后一次同步；极端情况下（实例被硬杀）可能丢最后一秒内的写入。订单/仓位
  这种演示数据完全可接受；真金白银的生产系统应该上路线 B 或付费磁盘。
- **Litestream 二进制下载**：`Dockerfile.persistence` 在构建时从 GitHub
  Releases 拉 Litestream v0.3.13（Render 构建环境可达）。开发沙箱里因网络
  白名单没能实测这条下载链，但这是 Litestream 官方发布的标准分发方式；
  若构建日志在此步失败，先检查该 URL 是否可达，而不是怀疑应用代码。
- R2 免费额度 10GB 存储 + 每月百万级请求，本项目的 WAL 备份量级（KB~MB）
  几年都用不完，$0 可长期成立。
