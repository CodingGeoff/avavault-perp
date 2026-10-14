#!/usr/bin/env bash
# 持久化版启动脚本（供 Dockerfile.persistence 使用，Render 原生部署不走这里）：
#   1) 若 R2 里已有备份，先恢复到本地 DB 文件（首次部署没有备份，自动跳过）；
#   2) 用 litestream replicate 托管 Node 服务：运行期持续把 WAL 同步到 R2，
#      服务收到 SIGTERM（休眠/重启）时 Litestream 会做最后一次同步再退出。
set -euo pipefail

DB_FILE="${DB_PATH:-/data/mini-dex.sqlite}"
mkdir -p "$(dirname "$DB_FILE")"

echo "[persistence] restoring from replica if one exists..."
litestream restore -config /etc/litestream.yml -if-replica-exists -o "$DB_FILE" "$DB_FILE" || true

cd /app/task7-perp-dex/server
echo "[persistence] starting server under litestream replication (db: $DB_FILE)"
exec litestream replicate -config /etc/litestream.yml -exec "npm start"
