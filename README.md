<div align="center">

<img src="icon.svg" width="96" height="96" alt="Full-Life Memory" />

<h1>Full-Life Memory</h1>

<p><strong>不存原文，只存线索。</strong><br/>
像人一样遗忘，也像人一样回忆。</p>

<p>
  <img src="https://img.shields.io/badge/version-0.2.3-6d5efc?style=flat-square" alt="version" />
  <img src="https://img.shields.io/badge/license-MIT-1fc8b3?style=flat-square" alt="license" />
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2024-339933?style=flat-square&logo=node.js&logoColor=white" alt="node" />
  <img src="https://img.shields.io/badge/dependencies-0-52525b?style=flat-square" alt="zero dependencies" />
  <img src="https://img.shields.io/badge/DSH-bundle-4f46e5?style=flat-square" alt="DSH bundle" />
</p>

<p><code>@tuhengyu/dsh-full-life-memory</code></p>

<p>一个给 <a href="https://github.com/deepseek-ai">DeepSeek Harness</a> 用的「仿生终身记忆」插件：<br/>
上下文快满时，它把旧对话蒸馏成几个关键词，<strong>从历史里物理删除</strong>；<br/>
当你再提起那件事，它顺着线索把记忆重新长出来。</p>

</div>

---

> 上下文不是硬盘。
> 人不会记住三个月前的每一句话，只留下几个名字、半句原话、一种「我们好像聊过」的感觉。
> 需要的时候，再顺着这些线索，把当时的场景重新拼出来。

## ✨ 三个核心卖点

| | |
|---|---|
| **🧠 仿生记忆**<br/>不存原文，只存 Token 线索 | 落盘的只有 `keywords`、`seed_tokens`、一句摘要——没有 message 正文，没有向量，没有 embedding。回忆时用线索组装一段"想起"的提示交给模型，而不是把数据摊开给它看。 |
| **⚡ 零 Token 成本**<br/>正则蒸馏，不调模型 | 遗忘不经过任何 LLM：引号里的原话、文件路径、标识符、中文短语，用规则抽出来就完事。一次折叠 **0 次模型调用、0 token 计费、0 延迟**。 |
| **✂️ 真正释放上下文**<br/>物理切除，不是"请忽略" | 走 DSH 的 surface 节点替换，被切掉的 6 个节点直接从下一轮请求里消失。不是 system prompt 里那句"请忽略更早的内容"，是**真的不发了**——KV cache / 显存跟着一起降。 |

## 🔁 它是怎么运转的

```text
        agent/pre-step
             │
             ▼
   tokenMeter.measure(session)
             │
   < 8000 ───┴─── ≥ 8000
     │              │
  keep going        ▼
          keep the last 4 turns, fold the oldest 2
                    │
                    ▼
          regex distill  →  keywords + seed_tokens    (0 LLM calls)
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
   SQLite memory_clues   surface replace
   (only file on disk)   6 nodes → 1 checkpoint
          │                   │
          │                   ▼
          │            【🧠 记忆已折叠】…
          ▼                   │
   recall_from_clues  ◄───────┘
   rebuilds the scene
```

## 🆚 和别的做法比

| 方案 | 每轮额外成本 | 上下文占用 | 旧事怎么找回来 | 真的移除了吗 |
|---|---|---|---|---|
| 全量保留 | 0 | 线性增长，迟早爆窗 | 原文还在 | ❌ |
| LLM 摘要压缩 | 每次压缩 1 次模型调用 | 压缩后仍占位 | 读那段摘要 | ✅（摘要节点） |
| 向量 RAG | 嵌入调用 + 每次检索 | 检索片段临时塞入 | 召回**原文分块** | ❌ 原文还在库里 |
| **Full-Life Memory** | **0** | **只留一行提示** | 线索 → 模型自己重建 | ✅（surface 替换） |

一句话区别：**向量库是「查」，线索是「想」。** 检索把原文递给你，回忆让模型自己长出来——后者更像人，也更省。

## 🚀 安装

```text
plugin_manager { action: "install_bundle", target: "<本目录的绝对路径>" }
```

装完重启一次 DSH。之后每个新会话都会带上：

- `recall_from_clues` 工具（Phase 1）
- 自动遗忘钩子（Phase 2，默认开启）

> **兼容性**：`@deepseek-ai/dsh-agent` / `dsh-tools` 声明为 `>=0.2.1-rc.2 <0.3.0`。
> DSH 会把这两个 peer 依赖当作兼容版本要求；钉死小版本会在 DSH 升级后报“不兼容”，
> 所以这里用区间，0.2.x 的补丁与 RC 升级都能直接通过。

> 本插件是 **link 安装**：改完代码不用重装，但要重启 Host 才会重新加载模块。

## ⚙️ 配置

```yaml
- insert:
    - id: full-life-memory
      name: '@tuhengyu/dsh-full-life-memory'
      config:
        dbPath: '~/.dsh/full-life-memory/memory.db'  # 线索库
        limit: 5                                     # 一次回忆取回几条线索
        maxPromptChars: 1800                         # 回忆提示的字符上限

        autoForget: true                             # Phase 2 总开关
        forgetThresholdTokens: 8000                  # 超过多少 token 开始遗忘
        forgetTurns: 2                               # 每次切掉几轮已完成对话
        keepCompletedTurns: 4                        # 最近这么多轮永远保留
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `dbPath` | `~/.dsh/full-life-memory/memory.db` | 目录自动创建，WAL 模式 |
| `limit` | `5` | 单次回忆最多带几条线索（上限 20） |
| `maxPromptChars` | `1800` | 超出截断并标注"更早的线索已淡忘" |
| `autoForget` | `true` | 关掉后只剩手动回忆，历史不再被切 |
| `forgetThresholdTokens` | `8000` | 用 `ctx.tokenMeter` 的口径；没有该服务时按字符粗估 |
| `forgetTurns` | `2` | 一次折叠几轮 |
| `keepCompletedTurns` | `4` | 保护最近对话：已完成轮数 ≥ `forgetTurns + keepCompletedTurns` 才动手 |

阈值比系统提示本身还低也没关系：保护规则会把会话稳稳停在「最近 5～6 轮」的滑动窗口，不会把上下文掏空。

## 👀 你会看到什么

对话流里多一行系统提示：

```text
【🧠 记忆已折叠】为了腾出空间，我已淡忘更早的 2 轮对话，
留下的线索：E:/Fishwork/app.ts、recall_from_clues、node:sqlite。
需要时我会用 recall_from_clues 自己回忆。
```

日志里多一行账：

```text
full-life-memory: folded 2 turn(s) (~9123 tokens) from surface seq 2..9
                  as compaction 6f1c…; clues: E:/Fishwork/app.ts, recall_from_clues, node:sqlite
```

然后你随口问一句「我们之前那个 sqlite 的事呢？」——模型会自己调 `recall_from_clues`，把线索接成回忆。

## 🧩 工作原理（30 秒版）

1. **测压**：`agent/pre-step`（waterfall）里用 `ctx.tokenMeter.measure(session)` 读当前请求压力。
2. **选段**：只挑**已完成轮次**（`turn/end` 之后），天然避开半个 tool-call；`surface` 第 0 个 system 节点永不参与。
3. **蒸馏**：正则抽 `keywords` 与 `seed_tokens`，连同 `session_id` 写进 `memory_clues` 表。
4. **切除**：`session.append('user/message', checkpoint, { surfaceOp: { op:'replace', startSeq, endSeq } })`——和 DSH 自己的 `dsh-compaction-basic` 逐字同一条路径。
5. **留痕**：外面套 `compaction/start → summary → replace → end`，Chat 因此把它渲染成原生的「记忆折叠」行，而不是一条用户消息。

安全边界都是显式校验过的：区间必须工具配对平衡、没有未闭合的 `compaction/start`、同一轮最多切一次、最近轮次受保护。任何一步失败都只是"这次不遗忘"，绝不留半截事务。

## ❓ 常见问题

**忘掉的东西还能找回来吗？**
能找回"上下文"，找不回"原文"——这正是设计目标。线索足够模型重建当时在聊什么、做到哪一步；逐字复述不重要。

**真的不花 token 吗？**
遗忘过程 0 token（纯正则）。只有你**主动回忆**时才会花几百 token——这笔钱花在真正需要的那一刻，而不是每一轮都替全部历史付费。

**中文能匹配吗？**
能。线索库用 `LIKE` 模糊匹配而不用 FTS5：中文不分词，线索本来就短，`LIKE` 反而更稳；`%` 和 `_` 已转义。

**会不会和 DSH 自带的自动压缩打架？**
不会。检测到未闭合的 `compaction/start` 就跳过；自己开事务时严格成对闭合，不会把锁留给别人。

**会不会把系统提示或工具配对切坏？**
不会。system 头永不切；只切 `turn/end` 之后的范围；区间前后都做 tool-call/result 平衡校验。

**数据在哪？会不会上传？**
只有一个本地 SQLite 文件，默认 `~/.dsh/full-life-memory/memory.db`。没有网络请求，没有遥测。

**能只用手动回忆吗？**
`autoForget: false`。历史不再被切，`recall_from_clues` 照常可用。

## 🗂 项目结构

```text
dsh-full-life-memory/
├── package.json          # bundle 清单 + dsh.bundle.patch
├── cordis.patch.yml      # 插入 Host 插件行 + 默认 config
├── index.ts              # 源码（类型完整，改这里）
├── index.js              # 运行时孪生版 = index.ts 去掉类型注解，Loader 加载它
├── locale/{en,zh}.json   # 插件管理器里的标题与描述
├── icon.svg
└── test/
    ├── smoke.mjs         # Phase 1：命中 / 未命中 / 截断 / 转义 / 连接回收
    └── auto-forget.mjs   # Phase 2：阈值 / 切除区间 / 配对校验 / 落库 / 每轮一次
```

## 🧪 测试

```bash
node test/smoke.mjs
node test/auto-forget.mjs
```

`auto-forget.mjs` 用一个仿 `Session` 契约的假会话跑完整链路，并额外做一次 **`index.ts` 与 `index.js` 的行为对拍**：同一个场景分别执行，逐字段比较追加事件、被切的 surface 区间、落库的线索行，确保"编译产物"和源码不漂移。

覆盖：阈值以下不动、到阈值切最旧两轮、replace 区间精确、system 头保留、后续轮次完好、线索落库、同轮不重复切、最近轮次受保护、工具配对不平衡拒绝、未闭合 compaction 拒绝、落库失败不留半截事务。

## 🧭 设计取舍

规则蒸馏不如语义摘要细腻——它抓的是"名字、路径、术语、原话"，不是"结论"。这是刻意的：**遗忘不该再花钱，也不该再等一次模型响应**。真想要语义摘要，只需替换 `extractClue()` 一个函数，返回结构不变，其余逻辑（选段、切除、落库）完全复用。

## 🛣 Roadmap

- [ ] `extractClue` 的可选 LLM 后端（默认仍是正则）
- [ ] 遗忘曲线权重：越久远的线索越淡，命中时排在后面
- [ ] 按项目 / workspace 分区的线索库
- [ ] `/forget` 手动命令与「回忆命中率」统计
- [ ] 线索之间的弱关联图，支持"顺着一条线索想起另一条"

## 📄 License

MIT © tuhengyu

<div align="center"><sub>记忆不是存储，是重建。</sub></div>
