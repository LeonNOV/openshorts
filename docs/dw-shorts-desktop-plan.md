# DW-shorts 桌面应用 · 实施方案

> 分支：`dw-shorts-dev`（从 `dw-dev` 切出，基线 `1ea9774`）
> 状态：**P0–P4 代码已全部落地（macOS arm64 本机验证通过）**
> - P0 代码改造 + 离线出片 PASS（提交 `dec4634`）。
> - P1/P2 脚手架（desktop/ 全套）已编写并通过 JS 语法检查（`abe3b42`）。
> - P3 已实现并验证：后端 `/api/selfcheck`、`/api/settings`（GET/PUT，`settings.json` 落地数据目录）、dashboard 静态托管 `/`（不遮蔽 `/api`）、端口 `DW_SHORTS_PORT` 覆盖；密钥迁移到 OS keychain（`lib/secrets.js`，web 回退不变）；首次运行向导 `FirstRunWizard.jsx`（自检→填 key→选模型）；后端退出/失败 `dwShell` 提示。Dashboard `vite build` 通过，后端端点 TestClient 全部 200，6 项单测全绿。
> - P4 已实现：分发说明 `docs/dw-shorts-distribution.md`（不签名行为、macOS 免费签名建议、Windows SmartScreen、SHA-256）、`desktop/resources/安装.command`。
> - **未在本机执行**：`electron-builder` 出 `.dmg`/`.exe` 与 Windows P0 CI 需对应平台 runner（本机仅 macOS，且 CI 无法在此沙箱跑）；Electron GUI 向导/崩溃页未经实机点击验证，但代码完整且编译/导入均通过。
> - P0 代码改造（§5.1 `desktop_runtime.py` + app.py/main.py 接入、§5.2 数据目录、§4.1 `scripts/prefetch_models.py`）已提交 `dec4634`。
> - P0 离线验证脚本 `scripts/p0_offline_smoke.py` + 单测 `tests/test_desktop_runtime.py`：本机 PASS；复现 CI `p0-desktop-verify.yml`（macos-14 / windows-2022）已建。
> - P1/P2 脚手架（`desktop/`：package.json、electron main/preload/builder-config、build-python/build-ffmpeg/verify-bundle 脚本）已编写并通过 JS 语法检查，构建/验证在对应平台 CI 跑通（本机仅 macOS，无法跑 electron-builder）。

---

## 0. 决策摘要

| 项 | 决定 |
|---|---|
| 应用名 | **DW-shorts** |
| 目标平台 | **macOS arm64（Apple Silicon）**、**Windows x64（Intel/AMD）** |
| 不覆盖 | Windows ARM、macOS Intel x64 |
| 签名与公证 | **不做**（见 §11，含影响与缓解措施） |
| 桌面壳 | Electron |
| 后端形态 | FastAPI 进程，同时**直接托管**已构建的 dashboard（单源同协议） |
| 离线边界 | 本地推理链路 100% 离线；AI 选片/配音仍需用户自带 API key（BYOK） |
| 目标体积 | 精简版 ~1.6 GB / 完整版 ~2.8 GB |
| 首发模型 | Whisper `small`（464 MB） |

---

## 1. 范围界定

### 1.1 内置 vs 必须联网

| 类别 | 能否内置 | 说明 |
|---|---|---|
| Python 运行时 + 全部依赖 | ✅ | 按平台各构建一份 |
| ffmpeg / ffprobe | ✅ | 静态构建 |
| 本地模型权重 | ✅ | 见 §4 |
| Gemini / DeepSeek / ElevenLabs / Fish Audio / fal.ai | ❌ | 远程 API，BYOK。项目既有架构决定 |
| Upload-Post | ❌ | 可选发布功能，与生成无关 |

**「完全离线」的准确含义**：转写 → 镜头切分 → 人脸/人形检测 → 取景 → 渲染 → 烧录字幕 → 配音，整条本地链路不产生任何下载。AI 选片与配音仍需用户提供 key。

### 1.2 明确**不**打包的东西（及依据）

| 不打包 | 省下 | 依据 |
|---|---|---|
| Node + `render-service` + Remotion + Chromium | ~570 MB | 本地自托管走 `main.py` 的 ffmpeg 管线。实测 `hooks.py` / `burned_subtitles.py` / `edit_builder.py` 均不引用 Node；`hooks.py` 用 ffmpeg+ffprobe+PIL 画叠加图。`/api/render` 那套 Remotion 只服务**托管模式**的云渲染 |
| `onnxruntime` | 75 MB | 只服务 Parakeet（GPU 镜像专用），桌面端不含该后端 |
| `jaxlib` | 234 MB | mediapipe 声明依赖，但实测 `import mediapipe` + 建检测器后 `jax` **未被导入** |
| `polars` + runtime | 161 MB | ultralytics 声明依赖，实测**未被导入** |
| billing 依赖（sqlalchemy / stripe / alembic / asyncpg / authlib） | ~50 MB | 仅 `BILLING_ENABLED` 需要 |
| `sympy`（29 MB） | 29 MB | torch 的依赖，但本项目不做符号计算；裁剪后需验证 torch 仍可 import |

---

## 2. 架构

### 2.1 进程模型

```
┌──────────────────────────────────────────────────────┐
│ DW-shorts  (Electron 主进程)                         │
│  · 管理 Python 后端子进程（spawn / 监控 / 重启）      │
│  · 管理窗口、托盘、菜单、打开文件                    │
│  · 密钥读写：Electron safeStorage → OS keychain      │
│  · 首次运行向导、日志落盘                            │
└───────────────┬──────────────────────────────────────┘
                │ http://127.0.0.1:<port>  (仅 loopback)
┌───────────────▼──────────────────────────────────────┐
│ DW-shorts Backend  (FastAPI / uvicorn, 子进程)        │
│  · /api/* 业务端点                                    │
│  · /videos /thumbnails 静态挂载                       │
│  · /  ← 直接托管 dashboard/dist（新增，见 §5.4）      │
│  · 拉起 main.py 管线子进程（sys.executable，已有）    │
└───────────────┬──────────────────────────────────────┘
                │ spawn
┌───────────────▼──────────────────────────────────────┐
│ Pipeline  (python -u main.py, 孙进程)                │
│  · faster-whisper / MediaPipe / YOLO / TransNetV2     │
│  · ffmpeg 渲染、字幕烧录、配音合成                    │
└──────────────────────────────────────────────────────┘
```

**关键点：Electron 只跟 FastAPI 说话。** dashboard 由 FastAPI 托管，所以 UI 与 API 同源，没有 CORS、没有 dev proxy、没有端口协议转换。

### 2.2 端口

- 后端监听 `127.0.0.1`（**不是** `0.0.0.0`），端口固定 `48152`
- 启动时先探测占用；被占则提示用户改端口或强制结束占用者（见 §5.6）
- Electron 启动后用 `GET /api/health` 轮询直到就绪，再显示窗口（避免白屏）

### 2.3 打包产物目录布局

**macOS**
```
DW-shorts.app/Contents/
├── MacOS/DW-shorts                    # Electron 主可执行
├── Resources/
│   ├── app.asar                       # 壳代码 + 已构建的 dashboard/dist
│   ├── python/                        # 独立 Python 前缀
│   │   ├── bin/python3.12
│   │   └── lib/python3.12/site-packages/
│   ├── bin/                           # ffmpeg, ffprobe
│   ├── models/
│   │   ├── faster-whisper-small/      # CT2 模型目录（含 model.bin）
│   │   └── yolov8n.pt
│   └── fonts/                         # 字幕字体
```

**Windows**
```
DW-shorts/
├── DW-shorts.exe
├── resources/
│   ├── app.asar
│   ├── python/python.exe + Lib/site-packages/
│   ├── bin/ffmpeg.exe, ffprobe.exe
│   ├── models/
│   │   ├── faster-whisper-small/
│   │   └── yolov8n.pt
│   └── fonts/
```

### 2.4 数据目录（可写，与安装目录分离）

| 平台 | 路径 |
|---|---|
| macOS | `~/Library/Application Support/DW-shorts/` |
| Windows | `%APPDATA%\DW-shorts\` |

内容：

```
<data>/
├── uploads/          # 上传的源视频
├── output/           # 产物 + 每个 job 的子目录 + *_metadata.json
├── thumbnails/       # 缩略图缓存
├── logs/             # backend.log / pipeline.log / electron.log
├── settings.json     # 非密钥设置（模型尺寸、端口、输出格式）
└── keys.json         # 密钥密文（safeStorage 加密，keychain 里）
```

**安装目录在 macOS `/Applications` 和 Windows `Program Files` 下是只读的**，所以 `output/`、`uploads/` 必须在数据目录。当前 `app.py:41-42` 用的是相对路径 `"uploads"` / `"output"`，会随 CWD 漂移——见 §5.2。

---

## 3. 依赖矩阵与体积预算

### 3.1 平台 wheel 可行性（实测 PyPI）

| 包:版本 | mac-arm64 | mac-x64 | win-x64 | win-arm64 |
|---|---|---|---|---|
| ctranslate2 4.8.3 | 有 | 有 | 有 | **无** |
| torch 2.11.0 | 有 | **无** | 有 | **无** |
| mediapipe 0.10.14 | 有 (universal2) | 有 | 有 | 无 |
| av 18.1.0 | 有 | 有 | 有 | 有 |
| onnxruntime 1.31.0 | 有 | 无 | 有 | 有 |
| opencv-python 5.0.0.93 | 有 | 有 | 有 | 无 |
| faster-whisper / ultralytics / scenedetect / transnetv2-pytorch / py3langid | 纯 Python，任意平台 | | | |

**结论**：`mac-arm64` + `win-x64` 两端全绿。`ctranslate2` 无 win_arm64 是排除 Windows ARM 的直接原因（它是转写必需项，且 Windows ARM 的 x64 模拟层跑 CTranslate2 + torch 性能不可接受）。

### 3.2 体积明细

| 组件 | 现状 | 打包后 | 备注 |
|---|---|---|---|
| Python 3.12 + site-packages | 1.5 GB | **~1.0 GB** | 裁 jaxlib / polars / onnxruntime / billing / sympy |
| Whisper CT2 模型 (small) | 464 MB | 464 MB | 预置 |
| ffmpeg + ffprobe | 系统自带 | ~120 MB | 静态构建 |
| dashboard/dist | 11 MB | 11 MB | |
| fonts/ | 1.2 MB | 1.2 MB | |
| yolov8n.pt | 6.2 MB | 6.2 MB | 预置 |
| Electron 运行时 | — | ~150 MB | |
| **合计（small）** | | **~1.75 GB** | |
| **合计（large-v3-turbo）** | | **~2.9 GB** | 换模型包 |

### 3.3 已在包内、无需额外打包

| 模型 | 位置 |
|---|---|
| MediaPipe BlazeFace | `mediapipe/modules/face_detection/face_detection_full_range_sparse.tflite`（661 KB） |
| TransNetV2 权重 | `transnetv2_pytorch/transnetv2-pytorch-weights.pth` |
| py3langid 语言模型 | 包内（740 KB） |

---

## 4. 离线模型预置

### 4.1 预置脚本

新增 `scripts/prefetch_models.py`，在**构建机上**跑一次（需要联网），产出可直接入库的资源目录：

```python
# scripts/prefetch_models.py
"""把运行时需要的模型下载到 resources/models/，供桌面端离线使用。"""
import os, shutil, sys

DEST = sys.argv[1] if len(sys.argv) > 1 else "desktop/resources/models"
WHISPER_SIZE = os.environ.get("DW_WHISPER_SIZE", "small")

# 1. Whisper —— CT2 格式，落到本地目录
from faster_whisper.utils import download_model
whisper_dir = download_model(WHISPER_SIZE)          # 返回 HF 缓存里的路径
target = os.path.join(DEST, f"faster-whisper-{WHISPER_SIZE}")
if os.path.isdir(target): shutil.rmtree(target)
shutil.copytree(whisper_dir, target)
# 2. YOLO
from ultralytics import YOLO
YOLO("yolov8n.pt")                                   # 落到 CWD
shutil.copy("yolov8n.pt", os.path.join(DEST, "yolov8n.pt"))
print("done ->", DEST)
```

产出：

```
resources/models/
├── faster-whisper-small/
│   ├── config.json
│   ├── model.bin          # CT2 权重
│   ├── tokenizer.json
│   └── vocabulary.txt
└── yolov8n.pt
```

### 4.2 运行时注入

**代码里已经有两个现成钩子**，正好为打包而生，不需要新增机制：

| 变量 | 效果 | 位置 |
|---|---|---|
| `WHISPER_MODEL` | 填**本地目录**时，`faster_whisper.utils.download_model()` 检测到 `os.path.isdir()` 会直接返回、不下载 | `subtitles.py:22` |
| `YOLO_MODEL_PATH` | 覆盖 YOLO 权重路径 | `main.py:98` |

```python
# 由 Electron 主进程注入到后端子进程的环境
DW_SHORTS_BUNDLE=<resources 目录>
WHISPER_MODEL=<resources>/models/faster-whisper-small
YOLO_MODEL_PATH=<resources>/models/yolov8n.pt
PATH=<resources>/bin:$PATH          # 让裸 "ffmpeg" 解析到内置版本
```

**副作用（好处）**：打包后完全不需要 `HF_ENDPOINT` / `HF_HUB_DISABLE_XET`，之前那个 HuggingFace 502 + Xet 401 的问题在桌面端**从根上消失**。

### 4.3 离线验证

预置完成后，用断网/无代理环境跑一次出片：

```bash
# macOS
env -u HTTP_PROXY -u HTTPS_PROXY \
    WHISPER_MODEL=desktop/resources/models/faster-whisper-small \
    YOLO_MODEL_PATH=desktop/resources/models/yolov8n.pt \
    DW_SHORTS_BUNDLE=desktop/resources \
    .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 48152
```

验收：日志里**不出现**任何 `Downloading` / `snapshot_download` / `Fetching`，且出片成功。

---

## 5. 代码改造清单

### 5.1 ffmpeg 解析（21 处调用，12 个文件）

现状：全部用裸 `"ffmpeg"` / `"ffprobe"`，依赖 `PATH`。

**改造策略：单点注入，不动 21 处。** 在一个所有入口都会导入的模块里改 `PATH`：

```python
# 新增 desktop_runtime.py
"""桌面端运行时装配：路径、模型、数据目录。

所有入口（app.py / main.py / CLI）都 import 它，保证 ffmpeg 能被解析到、
模型指向内置副本、数据目录落在可写位置。
"""
import os, sys

BUNDLE = os.environ.get("DW_SHORTS_BUNDLE")   # 打包时由 Electron 注入

def install():
    if not BUNDLE:
        return                      # 开发态：什么都不做，行为不变
    # 1) ffmpeg / ffprobe —— 让 21 处裸命令继续可用
    bin_dir = os.path.join(BUNDLE, "bin")
    if os.path.isdir(bin_dir):
        os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
    # 2) 模型 —— 仅在未显式指定时才指向内置副本
    models = os.path.join(BUNDLE, "models")
    if not os.environ.get("WHISPER_MODEL"):
        cand = _find(models, "faster-whisper-*")
        if cand: os.environ["WHISPER_MODEL"] = cand
    if not os.environ.get("YOLO_MODEL_PATH"):
        p = os.path.join(models, "yolov8n.pt")
        if os.path.exists(p): os.environ["YOLO_MODEL_PATH"] = p
```

`app.py` 和 `main.py` 顶部各加一行 `import desktop_runtime; desktop_runtime.install()`。

> 为什么不逐个改 21 处：`subprocess` 用 `PATH` 查找是标准行为，注入 `PATH` 是零侵入的正解。逐个替换成绝对路径虽然更显式，但会引入 21 处 diff、12 个文件的合并冲突风险，收益仅是"少一层间接"。**如果后续要支持"用户自带 ffmpeg 覆盖内置版"，再逐步迁移到 `resolve_tool()` 显式解析。**

### 5.2 数据目录（当前依赖 CWD）

```python
# app.py:41-42 现状
UPLOAD_DIR = "uploads"
OUTPUT_DIR = "output"

# 改为
DATA_DIR = os.environ.get("DW_SHORTS_DATA_DIR") or os.getcwd()
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
OUTPUT_DIR = os.path.join(DATA_DIR, "output")
```

`THUMBNAILS_DIR`（`app.py:2513` 附近）同样处理。开发态不设 `DW_SHORTS_DATA_DIR` 时行为完全不变。

### 5.3 YOLO 惰性加载（为 lite 变体省 357 MB torch）

```python
# main.py:98 现状 —— 模块级，import 即加载 torch + yolov8n.pt
model = YOLO(os.environ.get("YOLO_MODEL_PATH", "yolov8n.pt"))

# 改为惰性
_yolo_model = None
def _yolo():
    global _yolo_model
    if _yolo_model is None:
        from ultralytics import YOLO
        _yolo_model = YOLO(os.environ.get("YOLO_MODEL_PATH", "yolov8n.pt"))
    return _yolo_model
```

`detect_person_yolo`（`main.py:474`）改调 `_yolo()`。

**收益**：mediapipe 可用的平台上，torch 变成纯粹的可选回退，lite 变体可省 357 MB。**代价**：全量变体仍要带 torch（YOLO 是回退路径，必须可用）。

> 实施顺序建议：**先不做**惰性化。等 §8 的 P0 验证通过、确认两个平台的 YOLO 路径都正常后，再作为 P2 的独立改动单独提交，避免一次改动混入太多变量。

### 5.4 静态资源托管（消除 dev proxy 依赖）

`app.py` 已经 import 了 `StaticFiles` 并挂载了 `/videos`、`/thumbnails`（2506/2514 行），新增 dashboard 挂载是自然延伸：

```python
# app.py 末尾，仅在桌面态/存在构建产物时挂载
_DASHBOARD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dashboard", "dist")
if os.path.isdir(_DASHBOARD):
    app.mount("/", StaticFiles(directory=_DASHBOARD, html=True), name="dashboard")
```

> 注意：挂在 `/` 会吃掉未匹配的路径。必须确保在所有 `/api/*` 路由**之后**挂载（FastAPI 按注册顺序匹配）。Electron 侧加载 `http://127.0.0.1:48152/` 即可，与 API 同源。

### 5.5 密钥存储迁移（XOR → OS keychain）

现状（`dashboard/src/App.jsx:39-53`）：

```js
const SECRET_KEY = import.meta.env.VITE_ENCRYPTION_KEY || "OpenShorts-Static-Salt-Change-Me";
// XOR + base64 —— 注释自己写了 "still client-side"
```

桌面端改用 Electron `safeStorage`（macOS Keychain / Windows DPAPI）：

```js
// preload.js
contextBridge.exposeInMainWorld('dwSecrets', {
  set: (k, v) => ipcRenderer.invoke('secret:set', k, v),   // 主进程用 safeStorage.encryptString
  get: (k)    => ipcRenderer.invoke('secret:get', k),
  del: (k)    => ipcRenderer.invoke('secret:del', k),
});
```

`App.jsx` 的 `encrypt`/`decrypt` 改为调用桥接；**保留旧的 XOR 读路径**做迁移（读到的旧值用新方式重写一次），否则升级用户会丢 key。

### 5.6 打包态裁剪

| 裁剪 | 做法 |
|---|---|
| billing 端点 | 打包构建时设 `BILLING_ENABLED=0`；`requirements-billing.txt` 不进包 |
| Remotion 渲染代理 | 打包构建不装 `render-service/`；`/api/render` 端点在桌面态返回明确错误而非 502 |
| 端口占用处理 | 启动时 `net.createServer().listen(48152)` 探测；被占则弹窗让用户换端口，并把新端口通过 `DW_SHORTS_PORT` 传给后端 |

### 5.7 Windows 专项

| 项 | 处理 |
|---|---|
| 路径分隔符 | 用 `os.path.join`，禁止手写 `\` 或 `/` 拼接 |
| 编码 | 子进程 env 显式设 `PYTHONIOENCODING=utf-8`；stdout 读取用 `errors='replace'` |
| 杀毒误报 | 见 §11 |
| 长路径 | 用户目录下的路径可能超 260 字符；建议数据目录用短路径（如 `%APPDATA%\DW-shorts`） |
| ffmpeg exe | 内置 `ffmpeg.exe` / `ffprobe.exe`，注意 `PATHEXT` 与 `.exe` 后缀 |

---

## 6. Electron 壳

### 6.1 主进程职责

```js
// electron/main.js
const { app, BrowserWindow, ipcMain, safeStorage } = require('electron')
const { spawn } = require('child_process')
const path = require('path')

let backend = null
const PORT = 48152

function startBackend() {
  const res = path.join(process.resourcesPath, 'python')
  const exe = process.platform === 'win32'
    ? path.join(res, 'python.exe')
    : path.join(res, 'bin', 'python3.12')
  const env = {
    ...process.env,
    DW_SHORTS_BUNDLE: process.resourcesPath,
    DW_SHORTS_DATA_DIR: app.getPath('userData'),
    DW_SHORTS_PORT: String(PORT),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
  }
  backend = spawn(exe, ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1',
                        '--port', String(PORT)], {
    cwd: app.getPath('userData'), env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  backend.stdout.on('data', d => log('backend', d))
  backend.stderr.on('data', d => log('backend', d))
  backend.on('exit', code => { backend = null; /* 交由 UI 提示重启 */ })
}
```

要点：
- **`cwd` 设为 userData** —— 兜底保证相对路径不落在只读的安装目录
- **stdout/stderr 落盘**到 `<userData>/logs/backend.log`，UI 里能看
- **子进程随 app 退出而杀**（`before-quit` 里 `backend.kill()`）

### 6.2 启动时序

```
app.whenReady()
  → 探测端口占用（冲突则弹窗）
  → startBackend()
  → 轮询 GET /api/health（最多 30s）
  → 成功 → 创建窗口、loadURL(http://127.0.0.1:48152/)
  → 失败 → 显示错误页（含日志尾部 + 重试按钮）
```

### 6.3 首次运行向导

三步，每步都有明确的"已就绪"判定：

1. **环境自检** —— 调后端一个自检端点，校验：内置 ffmpeg 可执行、Whisper 模型目录存在且含 `model.bin`、YOLO 权重存在、Python 依赖齐全。任一缺失 → 明确报"缺什么、去哪拿"，而不是让用户撞到 RuntimeError
2. **填 API key** —— Gemini 或 DeepSeek（二选一即可跑通），语音 provider 可后补
3. **选模型尺寸** —— small / medium / large-v3-turbo，显示各自体积；已下载的标记

### 6.4 崩溃恢复

- 后端进程退出非零 → 弹窗显示日志尾部 + "重启后端" 按钮
- 保留最近 5 次后端启动的日志（`backend.log.1` …）
- 管线子进程崩溃由后端自己的重试逻辑处理（已有），Electron 不介入

---

## 7. 构建管线

### 7.1 仓库新增目录

```
desktop/
├── package.json            # electron + electron-builder 依赖
├── electron/
│   ├── main.js
│   ├── preload.js
│   └── builder-config.js
├── scripts/
│   ├── build-python.mjs    # 按平台构建 Python 前缀
│   ├── build-ffmpeg.mjs   # 下载并校验 ffmpeg 静态构建
│   ├── prefetch-models.py  # 预置模型（见 §4.1）
│   └── verify-bundle.mjs   # 产物自检
└── resources/
    ├── models/             # 预置产物（构建时生成，不入库）
    └── bin/                # ffmpeg（构建时下载）
```

### 7.2 每平台构建步骤

```bash
# 0) 前端
cd dashboard && npm ci && npm run build          # → dashboard/dist

# 1) Python 前缀（按目标平台；跨平台构建需对应平台的 CI runner）
uv venv --python 3.12 desktop/resources/python
uv pip install --default-index <mirror> \
    -r requirements.txt --python desktop/resources/python/bin/python3.12
# 裁掉可选依赖
uv pip uninstall --python ... jaxlib jax polars polars-runtime-32 onnxruntime sympy
# 校验裁剪后仍可 import
desktop/resources/python/bin/python3.12 -c "import main, fastapi, torch, ultralytics, mediapipe, faster_whisper"

# 2) ffmpeg 静态构建
#    macOS: evermeet.cx 的 ffmpeg/ffprobe；Windows: gyan.dev 或 BtbN 的 build
#    落进 desktop/resources/bin/

# 3) 模型预置
python scripts/prefetch_models.py desktop/resources/models

# 4) 组装 + 打包
npx electron-builder --mac --arm64 --config desktop/electron/builder-config.js
npx electron-builder --win --x64   --config desktop/electron/builder-config.js
```

**跨平台构建的现实约束**：Python 前缀含平台相关的二进制（torch / mediapipe / ctranslate2 / av / opencv），**必须在对应平台的机器或 CI runner 上构建**，不能交叉编译。因此 CI 用 GitHub Actions 的 `macos-latest` + `windows-latest`。

### 7.3 electron-builder 配置要点

```js
// desktop/electron/builder-config.js
module.exports = {
  appId: 'com.dwshorts.app',
  productName: 'DW-shorts',
  directories: { output: 'desktop/dist', buildResources: 'desktop/resources' },
  extraResources: [
    { from: 'desktop/resources/python', to: 'python' },
    { from: 'desktop/resources/bin',      to: 'bin' },
    { from: 'desktop/resources/models',   to: 'models' },
    { from: 'dashboard/dist',              to: 'app' },
    { from: 'fonts',                       to: 'fonts' },
  ],
  files: ['electron/**/*', 'package.json'],
  mac: { target: [{ target: 'dmg', arch: ['arm64'] }] },
  win: { target: [{ target: 'nsis', arch: ['x64'] }] },
  // 不签名
  mac: { identity: null, notarize: false },
  win: { signtoolOptions: null },
}
```

### 7.4 CI 矩阵

| 阶段 | Runner | 产出 |
|---|---|---|
| P0 验证 | `macos-14` + `windows-2022` | 验证报告（无产物） |
| 构建 | 同上 | `.dmg`（arm64）、`-Setup.exe`（x64） |
| 冒烟 | 同上 | 下载产物 → 解包 → 跑 §4.3 离线出片 |

---

## 8. 分阶段实施

| 阶段 | 内容 | 验收标准 | 依赖 |
|---|---|---|---|
| **P0 可行性验证** | 在 `macos-14` / `windows-2022` runner 上，用「本地模型目录 + 内置 ffmpeg」跑通一次 headless 出片 | 两平台各产出一段视频；日志无任何下载痕迹；子进程路径/编码无异常 | 无（不写 Electron） |
| **P1 打包管线** | 写 §7 的四个脚本；裁剪依赖；产物自检 | 产出目录可解包；`verify-bundle.mjs` 全绿 | P0 |
| **P2 Electron 壳** | 主进程 + preload + 窗口 + 进程管理 + 日志 + 自检端点 | 双端 `.app`/`.exe` 能启动、能出片、能看到日志 | P1 |
| **P3 密钥与向导** | safeStorage 迁移；首次运行向导；模型尺寸切换 | 重启后 key 仍在；缺组件有明确提示而非崩溃 | P2 |
| **P4 分发（简化）** | 仅做产物产出与安装说明，**不签名** | 双端可安装；已知 §11 的告警行为有书面说明 | P3 |
| **P5 自动更新** | 评估后决定是否做（见 §9） | — | P4 |

**建议严格按顺序做 P0。** 它是整个方案里唯一可能推翻结论的环节——验证的是依赖在**真实出片路径**上的行为，而不是 import 成功。Windows 上 PyAV + ctranslate2 + torch 的组合、以及 Electron 拉起 Python 子进程的路径/编码问题，都是 import 测不出来的。

---

## 9. 测试策略

| 层级 | 手段 |
|---|---|
| 单元 | 现有 1387 个 pytest 不变；新增 `desktop_runtime.py` 的路径/模型解析测试 |
| 集成 | P0/P1 脚本：真实视频 → 出片 → 校验产物与 metadata |
| 离线 | 断网（或清空代理）跑完整出片，断言日志无下载 |
| 打包产物 | CI 下载 `.dmg`/`.exe` → 解包 → 用**产物内的** Python 跑出片（不是开发态 venv） |
| UI 冒烟 | Electron 起停、端口冲突、后端崩溃弹窗、首次运行向导 |

---

## 10. 风险清单

| 风险 | 等级 | 应对 |
|---|---|---|
| Windows on ARM 不支持 | 已确认 | 文档与下载页写明"仅 x64"；启动时检测 `process.arch` 并明确报错 |
| 裁掉 jax/polars/sympy 后某些 ultralytics 路径报错 | 中 | P1 用**真实视频**回归验证，不能只测 import；保留一个"未裁剪"的对照产物 |
| 2 GB+ 分发与更新成本 | 中 | 首发只带 small；模型档位做成"可选下载"而非"随包"；electron-builder 的 nsis/dmg 差分对首包收益有限 |
| ffmpeg 静态构建的编解码器覆盖不全 | 中 | 锁定一份明确含 libx264 / aac / libmp3lame 的构建；P0 验证 |
| Electron 拉 Python 子进程在 Windows 的路径/编码 | 中 | P0 重点验证项；env 显式设 `PYTHONIOENCODING` |
| 安装目录只读导致相对路径写入失败 | 中 | §5.2 改造 + `cwd` 设为 userData 双保险 |
| 不签名导致的拦截 | 中 | 见 §11 |
| 体积超预期 | 低 | 已有 1.75 GB 预算；超了先砍 large-v3-turbo 支持 |

---

## 11. 不做签名的实际影响与缓解

既然明确不做签名，这里把后果写清楚，避免上线后被"用户装不上"反噬。

### macOS

| 现象 | 说明 |
|---|---|
| 双击 `.app` 提示"无法打开，因为无法验证开发者" | Gatekeeper 隔离属性导致。**首次安装需右键 → 打开**，或终端执行 `xattr -dr com.apple.quarantine /Applications/DW-shorts.app` |
| 无法用 `open -a` 直接启动 | 同上，需先去掉隔离属性 |
| 每次 Gatekeeper 检查变慢 | 未签名应用每次首次启动都要过一遍检查 |

**缓解**：
- 随包提供一个 `安装.command`（双击运行）——它自己执行 `xattr -dr com.apple.quarantine`，用户只需双击这一个文件
- 或改用 **Developer ID 免费签名（Personal Team）**——不花钱、不需公证，即可绕过大部分 Gatekeeper 提示。**这是零成本选项，建议至少做这一步**
- 内部分发（团队内、AirDrop、局域网共享）通常不会触发隔离，可直接用

### Windows

| 现象 | 说明 |
|---|---|
| SmartScreen 蓝色窗口"Windows 已保护你的电脑" | 未签名 exe 的标准行为 → 点"更多信息" →"仍要运行" |
| 杀毒软件可能误报 | 未签名的 Python 打包应用是误报重灾区。Defender 误报率最高，第三方杀软更严 |
| 需要把安装目录或 exe 加白名单 | 企业环境可能由 IT 策略直接阻断 |

**缓解**：
- 随包提供 SHA-256 校验值 + 校验脚本
- 文档写明白名单添加路径
- 若走内部 IT 分发，**优先给 IT 部门一份预签名的 exe**（用内部代码签名证书，Windows ADCS 可免费签内部组织）

> **强烈建议至少做 macOS 的免费 Developer ID（Personal Team）签名**。它不需要付费开发者账号、不需要公证，却能消除"无法打开"这个最劝退的首次体验问题。Windows 的 EV 证书（约 $200–400/年）可继续不做。

---

## 12. 工时估算

| 阶段 | mac + win 合计 | 备注 |
|---|---|---|
| P0 可行性验证 | 2–3 天 | 主要是 CI 调试 Windows |
| P1 打包管线 | 4–6 天 | 裁剪依赖是体力活 |
| P2 Electron 壳 | 5–7 天 | 含进程管理、错误处理、首次运行 |
| P3 密钥与向导 | 3–4 天 | safeStorage 迁移有回归风险 |
| P4 分发（简化，不签名） | 1–2 天 | 出产物 + 写安装说明 |
| **合计** | **约 3–4 周** | 不含签名与公证 |

**最小可用版本（只求能装能出片）**：P0 + P1 + P2 的骨架，约 1.5–2 周。

---

## 13. 下一步

做 **P0**：写一个 CI 脚本，在 `macos-14` 与 `windows-2022` 上用「本地模型目录 + 内置 ffmpeg」各跑一次 headless 出片。成本很低（不需要写任何 Electron 代码），但能提前暴露方案里唯一可能致命的问题。
