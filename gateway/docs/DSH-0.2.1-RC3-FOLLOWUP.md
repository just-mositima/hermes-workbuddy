# DSH 0.2.1-rc.3 升级复核

> 调研日期：2026-10-24
> 宿主实测版本：`0.2.1-rc.3`（`DeepSeek Harness.app` 的 `CFBundleShortVersionString` 与 `CFBundleVersion` 一致；`@deepseek-ai/dsh-desktop` 同为 `0.2.1-rc.3`；node 24.21.0 / pnpm 11.28.5，GUI `http://127.0.0.1:50555`）
> 上一份复核：[`DSH-0.2.1-RC1-FOLLOWUP.md`](DSH-0.2.1-RC1-FOLLOWUP.md)（rc.1）
> 结论：**一处真实回归**（模型选择器的标签槽位被新增的官方插件抢占），已在 5.8.2 修复；其余全部兼容。

## 一、结论速览

| 面 | 状态 | 说明 |
|---|---|---|
| peer 版本范围 | ✅ 无需改 | 宿主兼容闸门用 `includePrerelease: true`，rc 宿主一直放行（订正了 rc.1 复核的错误归因，见 §3） |
| 类型面 | ✅ 无需改 | 13 个直接依赖里只有 `dsh-client-ui-primitives` 变了，且**纯增量** |
| **模型标签槽位** | 🔴 **回归 → 已修** | rc.2 新增的官方 `1017` 徽章插件占用同一 `single` 槽的同一优先级，本插件注册**抛错**，徽章静默消失（§2） |
| pi-ai 适配 | ✅ 无需改 | 捆绑 `pi-ai@1.1.0`，宿主 `piContext()` 仍返回扁平 `{systemPrompt, messages, tools}`，`foldModernContext` 照旧需要 |
| 提示词指纹锚点 | ✅ 无需改 | 三处身份从句原文未变（含 web-app patch 里的 `personaPrefix`） |
| 主题 token | ✅ 无需改 | 用到的 token 在 shell CSS 里都在（两个带 fallback 的缺失项未观察到视觉问题） |

## 二、唯一回归：`conversation.input.model.label` 槽位冲突

### 2.1 现象与证据

宿主自 **rc.2** 起在 web-app 捆绑里新增了官方客户端插件
`@deepseek-ai/dsh-client-ui-deepseek-model-label-1017`（声明于
`@deepseek-ai/dsh-web-app/cordis.patch.yml`），它给 DeepSeek 官方 Flash 行画一个
「1017」发布徽章，注册的正是本插件画负载徽章的**同一个槽**。

该槽是 `kind: "single"`（见 `dsh-client-ui-model-selection/lib/client.js:1906`），而
`SlotCore.register()` 对同一优先级上的第二次注册**直接抛错**：

```
single slot "conversation.input.model.label" already has a registration at
priority 0 (registered by Kb) — register at a different priority to shadow it
(lowest renders)
```

两个插件都用默认优先级 `0`，于是谁后注册谁抛错。实测是本插件抛错——**应用自己的崩溃日志**
（`~/Library/Logs/DeepSeek Harness/crash-2026-10-22T19-53-01-765Z-web-boot.log`）逐字记着：

```
Uncaught Error: single slot "conversation.input.model.label" already has a
  registration at priority 0 (registered by dsh-connect-workbuddy-client)
[dsh-connect-workbuddy] model label slot failed to register (host provider unaffected): Error: …
```

### 2.2 为什么一直没被发现

`registerModelLabel()` 的 `catch` 只 `console.error`（这是刻意的：标签失注册不该让整页挂掉），
于是**页面上只是徽章不见了**，没有任何用户可见的报错。这正是本次要补回归测试的原因。

### 2.3 修法：只换优先级，**不引入任何插件联动**

唯一必须满足的条件是「不要和别人抢同一个优先级」：

1. **换优先级，避开默认的 `0`。** 宿主的 1017 插件不声明优先级，即默认 `0`；本插件此前也是 `0`，
   这才是冲突来源。
2. **也不能用 `-1`：那是 `dsh-connect-qoder` 的**，两个插件都占 `-1` 会以完全相同的理由冲突。
   取 **`-0.5`**（分数优先级合法），与 `-1` 和 `0` 都不碰撞。
3. **到此为止。** 不再做「转交」——不读槽位账本、不渲染别人的组件、不为别人的行合成 props。

**为什么曾经考虑过转交，又放弃了。** 冲突修掉之后还有一个诱惑：低优先级并不保证本插件会输，
当 qoder 与 1017 都不在时本插件就是该槽唯一的赢家，于是「别家的行只画纯目录名」看起来像
把别人的装饰抹掉了。当时实现过一版「把别家的行转交给账本上下一个贡献者」，它需要：

- 读 `slots.entries(...)` 枚举同槽的其它注册；
- 代渲染器合成对方的 `t` 席位（来自对方注册时声明的 `locale:` 命名空间，用
  `StoredEntry.locale` + `locale.bind()` 复现）；
- 约定一条跨插件的转交方向，否则会递归——实测 qoder（`-1`）也会转交，两个都转交时
  同一行被来回传递，直接 `RangeError: Maximum call stack size exceeded`。

这三件事都是**插件之间的联动**，违反项目的不变量（[`DESIGN.md`](DESIGN.md) §零）。
本插件的职责边界是「把自己的行画对」，不是「当别人的渲染代理」。因此该方案整体撤除，
改为：**不是自己的模型行，一律给宿主契约的下限 `model.name`。**

**代价（已接受，记录在此）。** `single` 槽位一格只有一个赢家：本插件赢下该格时，
别的插件在**它自己的行**上的装饰不会被合成（例如宿主的「1017」徽章不会出现在本插件
渲染的那一行）。这是放弃联动换来的确定性，不是待修缺陷——要改成联动，先改 `DESIGN.md` §零。

#### 2.3.1 「谁赢这一格」的定夺依据（宿主自己的文档已经回答了）

这个取舍曾被反复提出，**但它其实不需要用户来选**——宿主一方已经有明确书面立场：

`@deepseek-ai/dsh-client-ui-deepseek-model-label-1017` 的 README
「Known Limitations and Deferred Work」一节逐字写着：

> This package occupies a `single` slot. Another model-label plugin at the same
> priority conflicts; **the two presentations do not compose automatically.**

也就是说，**宿主把「两个模型标签徽章不自动合成」列为已知限制，而不是待修缺陷**。
本项目 §零 那条「不做插件联动」的不变量，与宿主的官方立场是**同向**的，不需要额外解释。
本插件不必为「礼貌地让位」而放弃自己的功能。

其余三条依据：

1. **1017 是临时标记，且宿主承诺会移除。** 它的 `package.json` description 就是
   「Temporary 1017 release badge for official DeepSeek Flash model labels」，
   README 末条写着「Remove this package and its bundle row when structured
   release labels replace it」。为一个**承诺会被删掉**的临时标记，让出自己插件的
   常驻功能，是把长期让给短期。
2. **收益面相差悬殊。** 1017 只装饰**一个**模型（`DeepSeek-V4.1-Flash`，且仅限
   `deepseek-official` / `deepseek-account` 两条线路），且其 README 明确「只装饰浏览器标签，
   不改变模型请求与 Session 事件」。本插件赢下这一格，装饰的是**自己全部 WorkBuddy 模型行**
   （负载等级、促销价、夜间折扣、新模型标记）——这是本插件的核心功能面。
3. **宿主给出的冲突处置办法在配置层，不在运行时。** 1017 README 写的是
   「Disable it to restore plain model names」，即用 **profile patch 禁用该插件**
   来解决共存问题。宿主预期的解法是**配置**，不是运行时协商——这又一次支持
   「运行时不做联动」。

**结论：`MODEL_LABEL_PRIORITY = -0.5`（我们赢这一格），不引入任何联动。**
该取值同时满足：不与 `-1`（qoder）碰撞、不与 `0`（宿主 1017）碰撞、
不需要知道任何别的插件在场，且在宿主移除 1017 之后自动成为该格唯一占用者。

**`-0.5` 也不保证「让位给宿主」。** 「最低优先级渲染」意味着 `-0.5` 实际上**赢过**宿主的 `0`；
选它不是为了谦让，而是为了**不碰撞**（`0` 已占用）。真正决定谁渲染的是槽位规则，不是本插件的意图。

**实时账本实测（宿主 `0.2.1-rc.3` 运行中）。** `Slots.listSubTree` 查
`conversation.input.model.label`：`kind: single`、`replaceRisk: shadows-shipped-ui`，
占用者**只有一个**——优先级 `0` 的 `Gb`（宿主 1017），`active: true`。
本插件当时**根本没有注册上去**（优先级 `0` 撞车抛错的后果），这正是本次回归的现场。

## 三、订正 rc.1 复核的一个错误归因

rc.1 那份文档 §2.2 说「rc 阶段用 `link:` 本地开发不受影响」，暗示兼容闸门没在起作用。
**实测是错的**：`evaluatePluginCompatibility()`（`dsh-app-boot/lib/index.js:311`，其 `:276` 的
`satisfies` 包装）用 `semver.satisfies(rt, range, { includePrerelease: true })` 求值，
所以 `0.2.1-rc.3` 对现声明 `>=0.1.7-rc.1 <0.3.0-0` 判 **true**——闸门确实校验了，只是用
`includePrerelease` 放过。这与 rc.1 时期的行为一致，**范围无需修改**。

「裸 semver 判 false」这个事实仍然成立（`tests/dsh-line.spec.ts` 照旧钉着它），
错的只是「为什么没被拦」的解释。该测试的注释已订正。

## 四、逐面包比对（rc.1 → rc.3）

- 13 个直接依赖里 **12 个的 `lib/` 逐字节相同**；只有 `dsh-client-ui-primitives` 变了，
  且全是增量（`TooltipSide` 移到 `tooltip-placement.ts`、`Menu.current`、`minWidthFromAnchor`、新图标）。
- rc.2 → rc.3 的差异仅限：`dsh-client-ui-conversation`（新增 `conversation.session.header.views.actions`
  列表槽、`DraftInitializationOptions.whenDraftExists` 等）、`dsh-client-ui-plugin-manager`（`openList()`）、
  `dsh-client-ui-primitives`、`dsh-web-app/cordis.patch.yml`（新增 `entry-customization`）。**本插件均未使用。**
- 313 个包的 `dist.shasum` 差异几乎全是 `package.json` 版本号重写。
- 移除的三个包（`dsh-experimental-schedule-bundle`、`dsh-invariants`、`dsh-subagent-in-process-driver`）
  本插件均未引用。
- 新增插件除 1017 外还有 `dsh-client-ui-entry-customization`（占 `sidebar.panellist.actions`，无冲突）。

## 五、验收

- 新增 [`tests/model-label-slot-coexistence.spec.tsx`](../tests/model-label-slot-coexistence.spec.tsx)（6 条），
  用**真实的 `SlotCore`**（本仓安装的 `0.1.7-rc.1`，其同优先级拒绝文案与 rc.3 逐字相同）覆盖：
  宿主 1017 在场时不抛错、优先级与 `-1`/`0` 均不碰撞、自家行仍有徽章，以及
  「不做联动」一组（别家行只给纯目录名、源码不读槽位账本、注册只声明自家常量）。
- 变异验证：把 `MODEL_LABEL_PRIORITY` 改回 `0` → 多条红并**复现同一句崩溃原文**。
- 项目不变量写进 [`DESIGN.md`](DESIGN.md) **§零**（硬性边界）与 §六 第 8 条。
- 完整套件 **2225 通过 / 2 条按平台跳过**，`typecheck` 与 `build` 通过。
