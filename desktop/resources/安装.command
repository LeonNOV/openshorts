#!/bin/bash
# DW-shorts 安装辅助脚本（macOS，未签名分发）
#
# 双击本文件即可安装并启动 DW-shorts。
#
# 为什么需要它：应用没有 Developer ID 签名（见 docs/dw-shorts-distribution.md）。
# 从 DMG 里拖出来的副本会带上 com.apple.quarantine，Gatekeeper 因此会拦住
# 双击启动。这个脚本解除隔离属性——这正是 Gatekeeper 认可的做法，
# 不需要付费开发者账号，也不需要公证。
#
# 如果系统连这个脚本本身都拦（它从 DMG 里出来时也可能带隔离属性），
# 请先右键 → 打开 一次。
set -e

APP_NAME="DW-shorts"
APP="/Applications/${APP_NAME}.app"

# 本脚本所在的目录（DMG 挂载点，或用户双击脚本时的位置）
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "正在准备 ${APP_NAME}…"

# 1) 脚本旁边有应用 → 说明用户是从 DMG 里双击的，直接安装（覆盖旧版）
SRC=""
for candidate in "$HERE/${APP_NAME}.app" "$HERE/Applications/${APP_NAME}.app"; do
  if [ -d "$candidate" ]; then SRC="$candidate"; break; fi
done
if [ -n "$SRC" ]; then
  echo "  正在安装到 /Applications（需要输入密码以授权）…"
  # Replace, do not merge: ditto copies INTO an existing directory, and a
  # stale install can carry files this one no longer has. Files left over
  # inside a signed bundle invalidate its code signature.
  rm -rf "$APP" 2>/dev/null || sudo rm -rf "$APP"
  ditto "$SRC" "$APP"
fi

if [ ! -d "$APP" ]; then
  echo "未找到 $APP"
  echo "请先将 ${APP_NAME}.app 拖入「应用程序」文件夹，再运行本脚本。"
  echo ""
  echo "按回车键关闭…"
  read -r _
  exit 1
fi

# 2) 解除隔离属性——这是让 Gatekeeper 放行的关键一步
echo "  正在解除隔离属性…"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

# 3) 启动
echo "  正在启动 ${APP_NAME}…"
open "$APP"

exit 0
