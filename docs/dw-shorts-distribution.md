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
| 磁盘 | ≈ 2.1 GB（安装后）+ ≈ 0.5 GB（模型） | ≈ 2.1 GB（安装后）+ ≈ 0.5 GB（模型） |
| 联网 | 首次运行需下载模型（约 470 MB）；之后本地推理完全离线 | 同左 |

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

安装后目录布局见方案 §2.3。ffmpeg 已内置；**模型权重不再随包分发**，首次运行时由应用下载到本机（`faster-whisper-small` ~464 MB + `yolov8n.pt` ~6 MB），下载一次后即可离线使用。

模型来源可配置：默认走 `https://hf-mirror.com`（`huggingface.co` 在中国大陆不可达），设置环境变量 `DW_MODEL_BASE_URL` 指向自建 CDN 即可（目录结构需与 Hugging Face 一致：`<base>/Systran/faster-whisper-small/resolve/main/model.bin`）。YOLO 权重来自 ultralytics 的 GitHub Release，无需镜像。

---

## 3. macOS 安装与 Gatekeeper

应用不做 Developer ID 签名与公证（方案 §11），但**打包时会做 ad-hoc 签名**
（`desktop/electron/after-pack-sign.js`）。这一步不是可有可无的：Electron 自带的
二进制只有链接器级的临时签名，而 electron-builder 在那之后才把 extraResources
拷进包里，于是包级签名与实际内容不再匹配——macOS 读到**无效签名**时会判定
bundle **已损坏**（"DW-shorts 已损坏，无法打开"），而不是常见的"无法验证开发者"，
并且不提供右键 → 打开的出口。重新签名让签名本身有效，问题就回到"未签名"这个
可解释、可处理的状态。

签名之后，剩下的拦截来自 Gatekeeper 对**隔离文件**（下载来的副本带
`com.apple.quarantine`）的策略。三种解决方式：

### 方式 A（随包提供，用户侧零操作）：双击 DMG 里的 `安装.command`

DMG 根目录带一个 `安装.command`。它做三件事：把应用装进 `/Applications`
（如果还没装的话）、解除隔离属性、启动应用。这是**推荐路径**——用户只需要
双击一个文件。

**注意**：`.command` 文件本身从 DMG 里出来时也可能带隔离属性，首次请
右键 → 打开。

### 方式 B：手动终端

```bash
xattr -dr com.apple.quarantine /Applications/DW-shorts.app
open /Applications/DW-shorts.app
```

内部分发（AirDrop、局域网共享、团队盘）通常不触发隔离，可直接用。

### 方式 C（分发方）：用真的 Developer ID 签名并公证

这是唯一能让"下载即用、无任何提示"的方案，需要付费的 Apple Developer 账号。
在打包机上：

```bash
codesign --force --deep --options runtime --sign "Developer ID Application: <团队名> (<TEAMID>)" DW-shorts.app
xcrun notarytool submit DW-shorts.dmg --keychain-profile <profile> --wait
xcrun stapler staple DW-shorts.dmg
```

免费的个人团队证书**不能**替代它：个人团队签出来的应用没有公证票据，
Gatekeeper 仍然会拦隔离文件。

> 顺带一提：`codesign --sign "-"` 是**临时签名（ad-hoc）**，不是个人团队证书。
> 它让签名有效（从而避免"已损坏"），但不会让 Gatekeeper 接受一个隔离的文件。

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
- 模型默认为 `small`；首次运行向导会引导下载。切换 `medium`/`large-v3-turbo` 时，对应模型会按需下载到本机（方案 §6.3 步骤 3）。
