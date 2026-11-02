# OpenChicken 监控台 · 独立开发导出

导出日期：2026-11-02（Asia/Shanghai）。原工程：`/home/cyz/openchicken/console`。

本目录可作为新 Git 仓库根目录，保留 `console/` 这一层；主机录制和部分回归测试使用其父目录。没有创建或修改 Git 仓库。现有源码按字节保留，未改动服务、运控、部署脚本或机器人配置。

## 技术栈

- 主机后端：Python 3.10+，aiohttp 提供 HTTP/WebSocket，pyzmq 提供 ZeroMQ/CURVE 通信。
- 机器人桥接及临时采集：Python；正式 `agent.runtime_agent` 转发现有 robotd/tofd 的 Unix socket IPC。
- 前端：原生 JavaScript ES modules、HTML、CSS；没有 React/Vue、TypeScript 或 npm 构建要求。
- 三维：Three.js 0.180.0、URDFLoader 0.12.6；图表：uPlot 1.6.32。依赖代码、许可证、来源证明已在 `console/web/vendor/` 中。
- 真实运动执行依赖独立的 Rust robotd/tofd 工程；此包不是机器人固件或完整运控部署包。

## 启动开发预览

Linux 主机推荐 Python 3.10+。在此导出根目录自行准备依赖：

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
cd console
PYTHONDONTWRITEBYTECODE=1 python -m host.server --port 8106 --demos 3
```

上述安装命令仅作说明，导出过程没有下载或安装依赖。也可以使用已具备这两个库的环境。端口可改；8106 用于避开原监控台。

- 中文运行监控：`http://127.0.0.1:8106/`
- 英文运行监控：`http://127.0.0.1:8106/en/`
- 中文配置测试：`http://127.0.0.1:8106/commissioning/`
- 英文配置测试：`http://127.0.0.1:8106/en/commissioning/`

此命令只创建模拟机器人，未提供实机连接配置。退出按 Ctrl+C。服务监听本机回环地址。
SSH 检查还需要主机 OpenSSH 客户端（当前代码使用 `/usr/bin/ssh`、`ssh-keyscan` 等）；密码不随包导出。真实接入需重新建档、独立配置和交换公钥，不自动恢复旧连接。

## 内容和继续开发入口

- `console/host/`：Web 服务、连接、录制、SSH 检查、档案、早期遥测接入。
- `console/web/src/`：界面；`robot-manager.js` 为新机建档，`test-commands.js` 为 N02～N06 命令与判定说明。
- `console/agent/`、`console/protocol/`：机器人桥接、数据协议与模拟器。
- `console/models/`：URDF、网格和来源；`console/integration/`：集成文档与历史补丁。
- `console/tests/`：现有测试；`docs/testing/`：部署、测试流程与验收模板。
- `openchicken_deploy/`：仅保留现有模型和协议回归所需的四个参考文件及许可证，不能编译或部署完整机器人服务。
- `robots/.../servo-config-audit-*.json`：现有回归测试所需的一份历史静态读数，不是实时状态。

当前监控台包含中英文入口、浅深色主题、URDF 状态显示、关节/IMU 面板、可缩放曲线、键盘/Xbox 输入、档案与配置测试页。N02～N06 的复制命令不会自动执行；实际执行必须满足每项前置条件。存在的源码和界面不代表所有实机项目已验收。

`console/README.md` 原样保留大量历史阶段记录，部分状态互相覆盖，不能把旧段落当成当前放行结论。其中指向原工作区 artifacts、机器人历史记录、完整 Rust 工程的链接可能不在本包中；实际测试证据仍以原工作区为准。工具内的历史绝对路径、浏览器测试的 Chrome/Playwright 路径需要在新机器按实际环境核对。

`console/agent/imu_calibration.json` 保留作为既有测试基线，属于 openchicken1 的历史标定，禁止直接当成另一台机器的标定。

## 验证

从导出根目录运行后端测试（创建本地测试 socket，不连接实机）：

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=console python -m unittest discover -s console/tests -v
```

测试使用 Unix socket，建议仓库路径保持较短（例如 `~/work/console`）；深层长路径可能导致 `AF_UNIX path too long`，这次验证已在短路径副本完成。

前端浏览器测试需要 Node.js、Chrome、Playwright；它们不属于运行页面的必需依赖，也没有打包。本次导出验证结果见 `EXPORT-VALIDATION.json`。

`FILES.sha256` 包含包内文件校验值（不含自身）。可在此目录执行 `sha256sum -c FILES.sha256`。

## 未打包内容

排除整个 `console/config/`（机器人档案、CURVE 私钥、SSH 信任/测试会话等）、缓存、临时测试目录、运行日志和录制数据。具体排除清单在 `EXPORT-MANIFEST.json`；原文件仍留在原监控工程，运行不受影响。

本包保留上游许可证和来源文件，不为整个工程另行声明许可证。新仓库发布前按项目归属确定许可。
