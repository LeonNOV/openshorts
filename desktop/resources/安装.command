#!/bin/bash
# DW-shorts 安装辅助脚本（macOS，不签名场景）
#
# 双击本文件即可：解除 Gatekeeper 隔离属性并启动应用。
# 若系统仍拦截本脚本本身，请先右键 → 打开 一次。
set -e

APP="/Applications/DW-shorts.app"

if [ ! -d "$APP" ]; then
  echo "未找到 $APP"
  echo "请先将 DW-shorts.app 拖入 /Applications，再运行本脚本。"
  exit 1
fi

echo "正在解除隔离属性（需要输入密码以授权）..."
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "启动 DW-shorts ..."
open "$APP"
