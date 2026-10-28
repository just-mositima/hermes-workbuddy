# hermes-workbuddy

**把本机登录的 WorkBuddy 模型（国内版与国际版）以 OpenAI 兼容网关的形式提供给 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 以及任意 OpenAI 客户端。**

本项目是 [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)（MIT，Copyright (c) 2026 LaoDing）的改造版：上游是一个 DeepSeek Harness (DSH) 插件，核心能力（WorkBuddy 桌面端登录态复用、上游协议客户端、回环 OpenAI shim、DSML 工具调用恢复、账号池排名与故障转移、每日签到与积分查询）全部宿主无关，但外壳绑死在 DSH 的 cordis 插件体系上。本 fork 保留全部核心与其线上行为，把外壳换成长为驻留的本地网关 + CLI，使其可以被 Hermes 以 `custom` provider 直接消费。

上游 README 见 [docs/upstream-README.md](docs/upstream-README.md) / [docs/upstream-README.en.md](docs/upstream-README.en.md)，完整致谢与第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 与上游的差异

| | 上游（DSH 插件） | 本 fork（Hermes 网关） |
|---|---|---|
| 宿主 | DeepSeek Harness 进程内（cordis 插件） | 独立 Node 进程，任何 OpenAI 客户端可用 |
| 端口 / 鉴权 | 每进程随机端口 + 每进程随机 secret（随宿主进程消亡） | **固定端口 + 持久 bearer**（`serve` 读写状态目录，跨重启稳定，可写进静态配置） |
| 模型/账号管理 | DSH 设置卡片（浏览器 UI） | CLI：`models` / `account` / `credits` / `checkin` |
| 非流式请求 | 一律回 SSE | `stream:false` 聚合为单个 `chat.completion` JSON（Hermes 的标题、压缩等辅助调用需要） |
| 无登录区域 | 以静态兜底目录注册 provider | `/v1/models` 返回空列表（一个只会 401 的选项比没有更糟） |
| 状态目录 | `$DSH_HOME`（`~/.dsh`） | `$HERMES_HOME/workbuddy`（可用 `--state-dir` / `WORKBUDDY_STATE_DIR` 覆盖；已设置的 `$DSH_HOME` 仍被尊重） |

**逐条保留的上游行为**（未做任何削弱）：桌面端 auth 目录扫描与多账号去重、按需 token 刷新（5 分钟余量 + 单飞）、区域隔离（cn / global 双网关双凭据库）、上游 wire quirks（强制流式、`tool_choice` 压平、CLI 形态请求头）、频道门四重救援梯（中性头、不可见扰动、学习式扰动）、DSML 标记恢复与「纯标记重试」、队列/额度/限流/策略拒绝的分类与中文可执行文案、账号池排名（冷却记录来自真实失败测量、按上游 reset 时刻回池）、失败转移（含 2 秒间隔与「为什么没有下一个账号」的说明）、每日签到与福利发现、积分按套餐聚合。

**不再打包的部分**：DSH 设置卡片（React 客户端）、`cli-bridge`、`web-status` 路由、图片/视频工具注册（上游协议客户端中的 `generateImage`/`submitVideo` 等函数仍在包内，未接线）。源文件保留以便对照与回移。

## 安装

需要 Node ≥ 22.19。

```bash
# 从本目录构建并全局安装
npm install -g .

# 或者不安装，直接跑构建产物
npm install && npx tsdown && node lib/bin.js --help
```

前置条件：本机 WorkBuddy（CodeBuddy）桌面端登录过至少一个账号（国内版或国际版均可）。网关只读桌面端的登录态并按需刷新，不会修改桌面端文件；加密凭据字段需要桌面端程序在场以提供 at-rest key（`WORKBUDDY_APP_EXECUTABLE` 可手动指定）。

## 快速开始（Hermes）

```bash
# 1. 启动网关（默认双区域：cn 用 8787，global 用 8788）
workbuddy serve

# 2. 另开终端确认模型目录（登录后即为上游实时目录）
workbuddy models --region cn
```

`serve` 首次运行会在状态目录铸一个 bearer（0600），之后每次启动复用同一个；`gateway.json` 记录端口与实时模型列表，`workbuddy status` 会显示网关状态。

Hermes 侧（`~/.hermes/config.yaml`，用 `hermes config set` 写入）：

```bash
hermes config set model.provider custom
hermes config set model.base_url http://127.0.0.1:8787/v1
hermes config set model.api_key "$(cat ~/.hermes/workbuddy/gateway-token)"
hermes config set model.default deepseek-v4        # 以 workbuddy models 输出为准
```

国内版与国际版是两个并行网关（各自端口），想让某些模型别名走国际版时，用带独立 base_url 的模型别名：

```yaml
model_aliases:
  wb-cn:
    model: deepseek-v4
    provider: custom
    base_url: "http://127.0.0.1:8787/v1"
    api_key: "${WORKBUDDY_GATEWAY_TOKEN}"
  wb-global:
    model: deepseek-v4
    provider: custom
    base_url: "http://127.0.0.1:8788/v1"
    api_key: "${WORKBUDDY_GATEWAY_TOKEN}"
```

然后 `/model wb-cn` 即可切换。两个网关共用同一个 bearer 文件；也可以 `workbuddy serve --region cn` 只开一个区域。

长驻建议（任选其一）：

```bash
# systemd user unit / 任务栏自启均可；网关只绑 127.0.0.1，不需要对外
nohup workbuddy serve >/tmp/workbuddy-gateway.log 2>&1 &
```

## CLI 一览

```
workbuddy serve     [--region cn|global|both] [--port N | --port-cn/--port-global]
                    [--token STR] [--state-dir DIR] [--no-pool]
                    [--refresh-minutes N] [--channel-perturbation off|failure|always]
                    [--keep-prompt-last]
workbuddy models    [--region cn|global] [--json] [--enable id1,id2] [--disable id1,id2]
workbuddy account   [--region cn|global] [list | <id|名称> | --clear]
workbuddy credits   [--region cn|global|both] [--json]
workbuddy checkin   [--region cn|global|both] [--json]
workbuddy status | doctor [--json]     # 诊断命令，与上游一致
workbuddy logout                        # 清除本工具自有凭据副本（桌面端登录不受影响）
```

- `models --enable/--disable` 持久化到 `models.<region>.json`；网关每次目录刷新时生效（默认 30 分钟，改完可重启 serve 立即生效）。
- `account` 的选择持久化到 `selection.<region>.json`；运行中的网关在下一个请求即按它计费。不选择则跟随桌面端当前登录。
- `credits` / `checkin` 逐账号执行；企业版账号自动跳过签到（上游没有该入口）。
- 账号池默认开启：池内账号 = 该区域发现的全部本地登录；失败按上游口径记录冷却（6004/14003/额度耗尽各有自己的回池时刻），失败转移到下一个可用账号。`--no-pool` 关闭。

## 状态目录

```
~/.hermes/workbuddy/
  gateway-token              # 网关 bearer（0600，首次 serve 铸造）
  gateway.json               # 运行中状态（端口、baseUrl、实时模型 id），关停时清除
  .workbuddy-auth.cn.json    # 插件自有凭据副本（按区域，刷新写这里，不动桌面端）
  .workbuddy-auth.global.json
  workbuddy-vault/           # OAuth 增补账号的加密存放
  selection.<region>.json    # 计费账号选择
  models.<region>.json       # 模型启用列表
  pool-probes.<region>.json  # 账号池冷却测量
```

## 安全模型

- 网关只监听 `127.0.0.1`，入站四重校验与上游一致：Host 回环、Origin 回环、JSON content-type、Bearer 恒定时间比对；Bearer 只存在于本地配置与内存，**绝不转发给上游**——上游请求用的是凭据库里刷新后的 WorkBuddy token。
- 上游 chat 请求绝不携带 refresh token（上游红线，原样保留）。
- `logout` 只删除本工具自有副本；桌面端登录态不受影响。

## 开发与验证

```bash
pnpm install --frozen-lockfile   # 或 npm install
npm run typecheck                # tsc：两个 tsconfig，0 错误
npm test                         # vitest 全量（含本 fork 新增的 gateway 用例）
npx tsdown                       # 构建 lib/
```

本 fork 的新增验证：`tests/gateway-standalone.spec.ts`（固定端口/固定 token 契约、被占用端口拒绝启动而非换端口、`stream:false` 聚合 JSON、`stream:true` 与缺省仍为 SSE、聚合器对工具调用分片的按 index 合并）与 `tests/gateway-built-e2e.spec.ts`（spawn 构建产物 `lib/bin.js serve`，用状态目录里的持久 bearer 走 /healthz、/v1/models、/v1/chat/completions 全链路，含未登录时的 OpenAI 形态 401）。

## 许可证

MIT（与上游一致），Copyright (c) 2026 LaoDing；本 fork 的改动同样以 MIT 发布。上游的第三方致谢与许可义务见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，均已在本 fork 中原样履行。
