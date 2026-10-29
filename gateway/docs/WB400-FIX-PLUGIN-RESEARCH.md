# `dsh-workbuddy-fix` 调研记录（2026-10-26）

范围：用户提到一个叫 `dsh-workbuddy-fix` 的插件，问能不能把它「fetch 层统一改写」的思路
移植进本插件。**本次只调研，不动代码**；结论存档，等真遇到问题时再决定是否落地。

## 1. 这个包到底是什么

- `dsh-workbuddy-fix` **不是 npm 上的现存包**：npm 主 registry、jsDelivr、unpkg 均 404，
  GitHub 上也没有同名仓库，`balongTTY` 这个账号本身也是 404。
- 它的真实身份是 **`simlerick/dsh-wb400-fix`**（MIT，2026-10-24 建，2 次提交，0 star）。
  该仓库 1.1.1 的 CHANGELOG 自己写明：包名已改为 `dsh-wb400-fix`，
  「原 `@balong/dsh-workbuddy-fix` 为本地临时命名，对应 scope 与仓库均不存在」。
  宿主代码首行注释至今仍写 `dsh-workbuddy-fix — Host half`，插件 id 仍是 `workbuddy-fix`
  —— 这就是那个名字的来源。
- 发布状态基本是半成品：npm 上装不到，只能 clone 后 link 安装。
- 顺带排除：搜索结果里还有 `lin666hub/dsh-workbuddy-connect-fixed`、
  `SamaToT/dsh-workbuddy-cn-fix`、`basaltfold/dsh-tencent-channel-fix`、
  `AsterLuo/dsh-buddy-guard` 等一批，都是针对 **上游 0.7.x 老连接器**的分叉，
  与本仓库 5.11.0 不是同一个东西，参考价值有限。

## 2. 它的做法（与本插件的差异）

核心思路：不侵入任何插件，**包一层 `globalThis.fetch`**。请求发出前判断
URL 是否属于 `copilot.tencent.com` / `workbuddy.ai` / `codebuddy.ai` / `codebuddy.cn`
的 `/chat/completions`，命中就解析 body、改写 `messages`、重新序列化。

改写的具体形式是**在 `DeepSeek` 与 `Harness` 之间插一个 U+200B**，语义不变、上游子串
匹配不再命中；另有三个开关：补首条 system、打散 `DeepSeek`（更激进）、总开关。
配置与 `dsh-workbuddy-meter` 共用 `~/.dsh/workbuddy-meter/lexicon.json`
（该 meter 包在 npm 上同样是 404）。

| 维度 | `dsh-wb400-fix` | 本插件 5.11.0 |
|---|---|---|
| 生效范围 | 任何走 fetch 打 WB 的插件 | 仅本插件自己的上游请求 |
| 改写位置 | fetch 出口，统一改 body | adapter 内 `prepareChatBody` 构造请求 |
| 被拒后自愈 | 无重试阶梯 | `forceNeutralHead` → `perturbChannelFingerprints` |
| 指纹覆盖面 | 只认字面量 `DeepSeek Harness` | 前缀名单 + 身份从句拆词（三条 span） |
| 第三方文件 | 可选往 `dsh-our-free-model` 的 `pack.js` 插钩子并自愈 | 不碰任何第三方文件 |
| 发布形态 | npm/CDN 全 404，只能 clone | npm 5.11.0 |

## 3. 实测发现的问题（若要借鉴必须先绕开）

1. **会改写工具调用历史**。`neutralizeMessage` 递归遍历 message 的所有字符串字段，
   实测 `tool_calls[].function.arguments` 里的 `"DeepSeek Harness"` 同样被插入零宽空格 ——
   等于静默改写工具调用参数（例如写文件的 content）。本插件对此必须设白名单：
   只碰 `content` 与它的 array text part。
2. **覆盖面比本插件窄**。实测在 4.15.1 之后测到的
   `You are a coding agent powered by the <model> model.`（无相邻大写词对、无逗号、
   句号在 span 之后）这一条，用它的改法是 `hits 0`，完全打不到。
   也就是说它换了个实现位置，但并不比现有梯子更强。
3. **`npm test` 必失败**：`package.json` 的 test 脚本指向 `test/*.mjs`，仓库里没有该目录。
4. **文档与实现不符**：README 写「不修改任何第三方文件」，但 `src/patch.mjs`
   确实会写 `pack.js`（标注为「可选兼容通道」）。
5. 它的路径保护（`(?<![\\/])…(?![\\/])`）只对字面量 `DeepSeek Harness` 成立，
   对 `You are an AI agent powered by DeepSeek Harness.` 这类正文命中，
   以及 `/Applications/DeepSeek Harness.app` 之外的正文语境，行为都符合预期；
   但正因为只认这一个词组，才出现了第 2 条。

## 4. 如果将来真要移植，建议的落点

不用照搬 fetch 包装，而是把它唯一有价值的思路 —— **出口层兜底** —— 接到现有结构上：

- 新增 `Config.egressRewrite?: boolean`（默认 `false`，`asVolatile`），
  配置项与 `channelPerturbation` 并列，语义是「对本插件发出的请求统一做一次出口级中和」。
- 实现放在 `src/upstream.ts` 的请求构造处（`chatStream` 调用 `prepareChatBody` 之后），
  而不是包 `globalThis.fetch`：本插件的请求都走自己的 client，包全局 fetch 会顺带
  影响宿主和其它插件的流量，副作用面不可控。
- 复用现有 `neutralizeScannedText`，但**只作用于 `content` 与 array text part**，
  跳过 `tool_calls` / `tool` 结果里的字符串（对应第 3 节第 1 条）。
- 默认关闭的理由与 `usageIdentity` / `keepPromptLast` 一致：它改变上游会数到的字节，
  不能作为「升级即生效」的行为。

## 5. 结论

不值得整包安装或移植。它解决的问题本插件已经在更靠内的位置解决，而且覆盖面更宽、
有真实的失败后自愈阶梯；它唯一的增量价值是「出口统一」这个位置，而那个位置放进
本插件的 `upstream.ts` 比包 `globalThis.fetch` 安全得多。等真的出现「某个绕过
`prepareChatBody` 的请求路径」时，再按第 4 节的方案落地。
