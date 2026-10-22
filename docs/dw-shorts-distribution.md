# DW-shorts 分发说明（不签名）

> 配套方案：`docs/dw-shorts-desktop-plan.md`
> 平台：**macOS arm64（Apple Silicon）** + **Windows x64**
> 本应用**不做代码签名/公证**（方案 §11）。

本地推理链路（转写 → 镜头切分 → 人脸/人形检测 → 取景 → 渲染 → 烧录字幕 → 配音）完全离线。
AI 选片与配音仍需用户自带 API key（Gemini / DeepSeek / ElevenLabs / Fish Audio），密钥在桌面端存入系统钥匙串（macOS Keychain / Windows DPAPI）。

---

## 1. 系统要求

| 项目 | macOS | Windows |
|---|---|---|
| 架构 | Apple Silicon（arm64） | x64（Intel/AMD） |
| 系统版本 | macOS 12+ | Windows 10 21H2+ |
| 内存 | ≥ 8 GB（推荐 16 GB） | ≥ 8 GB（推荐 16 GB） |
| 磁盘 | ≈ 1.8 GB（small 模型） | ≈ 1.8 GB（small 模型） |
| 联网 | 仅首次填写远程 API key 时需要 | 同左 |

**不支持**：Windows ARM、macOS Intel x64（见方案 §3.1 wheel 矩阵——ctranslate2 无 win_arm64、torch 2.11 无 macOS x86_64）。
若用户在不受支持的平台运行，Electron 启动时应检测 `process.arch`/`process.platform` 并明确报错退出。

---

## 2. 产物与打包

| 平台 | 产物 | 打包命令 |
|---|---|---|
| macOS (arm64) | `DW-shorts-<version>-arm64.dmg` | `cd desktop && node scripts/build-macos.mjs` |
| Windows (x64) | `DW-shorts-<version>-x64-setup.exe` | `cd desktop && node scripts/build-windows.mjs` |

两个脚本都是**一条命令走完全流程**：装桌面依赖 → 刷新打包的 Python 源码树 → 构建可重定位的
Python 运行时 → 构建 ffmpeg → 预取模型权重 → 构建前端 → electron-builder → 校验产物 →
打印产物的体积与 SHA-256。

- **必须在对应系统上跑**。打包的 Python 解释器是按宿主平台获取的，pip 也只能装匹配宿主的 wheel，
  在 macOS 上打 Windows 包会把 macOS 解释器塞进 .exe。Windows 端请用 Windows 机器或
  `windows-2022` CI runner。
- 常用参数：`--skip-deps`（不跑 npm install）、`--skip-frontend`（不重建前端）、
  `--skip-models`（不预取模型）、`--help`。
- 模型权重较大且下载慢，**已存在时会直接复用** `desktop/resources/models` 里的那份，不重复下载。
- 只想跑底层步骤时：`npm run build:python` / `build:ffmpeg` / `verify:bundle`。

安装后目录布局见方案 §2.3。模型权重（`faster-whisper-small` ~464 MB、 `yolov8n.pt` ~6 MB）与 ffmpeg 已内置，首次运行**无需联网下载**。

---

## 3. macOS 安装与 Gatekeeper

未签名的 `.app` 会被 Gatekeeper 拦截，双击提示"无法打开，因为无法验证开发者"。两种解决方式：

### 方式 A（推荐，零成本）：免费 Developer ID 个人团队签名
不需要付费开发者账号、不需要公证。在打包机上执行：

```bash
# 用本机登录的 Apple ID 免费团队对 .app 签名
codesign --force --deep --sign "-" DW-shorts.app
```

`-` 表示使用 **Apple Distribution (Personal Team)** 免费证书。签名后 Gatekeeper 不再拦截双击启动，且避免每次启动的隔离检查变慢。这是方案 §11 强烈建议的零成本选项。

### 方式 B：随包 `安装.command`（已提供）
仓库内 `desktop/resources/安装.command` 在用户双击时执行：

```bash
xattr -dr com.apple.quarantine /Applications/DW-shorts.app
open /Applications/DW-shorts.app
```

用户只需双击这一个文件即可解除隔离并启动。**注意**：`.command` 文件本身也可能被隔离，首次需右键 → 打开。

### 方式 C：手动终端
```bash
xattr -dr com.apple.quarantine /Applications/DW-shorts.app
```

内部分发（AirDrop、局域网共享、团队盘）通常不触发隔离，可直接用。

---

## 4. Windows 安装与 SmartScreen

未签名的 `.exe` 会出现 SmartScreen 蓝色窗口"Windows 已保护你的电脑"：

1. 点击 **"更多信息"** → **"仍要运行"** 即可继续安装。
2. 安装目录默认在 `C:\Users\<你>\AppData\Local\Programs\DW-shorts\`。

### 杀毒软件误报
未签名的 Python 打包应用是误报重灾区，Defender 误报率最高。应对：
- 发布时附带 **SHA-256 校验值**（见 §6），用户可自行比对。
- 文档写明如何将该目录/ exe 加入白名单。
- 企业环境若由 IT 策略直接阻断，建议向 IT 索取一份用内部 ADCS 代码签名证书预签名的 exe。

---

## 5. 数据目录（可写，与安装目录分离）

| 平台 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/DW-shorts/` |
| Windows | `%APPDATA%\DW-shorts\` |

包含：`uploads/`、`output/`、`thumbnails/`、`logs/`（backend.log / pipeline.log / electron.log）、`settings.json`（非密钥偏好）、`keys.json`（钥匙串密文）。安装目录（`/Applications`、`Program Files`）只读，所以上述目录必须落在用户数据区——已通过 `DW_SHORTS_DATA_DIR` 实现。

---

## 6. 校验（发布时填写）

构建流水线应输出每个产物的 SHA-256。示例（发布时替换）：

```
DW-shorts-1.0.0-arm64.dmg      sha256: <填入>
DW-shorts-1.0.0-x64-setup.exe  sha256: <填入>
```

macOS 校验：`shasum -a 256 DW-shorts-*.dmg`
Windows 校验（PowerShell）：`Get-FileHash DW-shorts-*.exe -Algorithm SHA256`

---

## 7. 已知限制

- 不签名 → macOS 首次需右键/脚本解除隔离；Windows 每次大版本可能再弹 SmartScreen。
- 远程 AI 能力（选片、语音）依赖用户自带 key，应用不内置任何在线账户。
- 模型默认仅内置 `small`；切换 `medium`/`large-v3-turbo` 需对应模型目录已内置或在设置中另行下载（方案 §6.3 步骤 3）。
