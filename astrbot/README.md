# 终身记忆 · AstrBot 插件

给 **NapCat + AstrBot** 这类"对话不经过 DSH"的部署用的薄壳：它不重新实现记忆逻辑，
只调用 `@tuhengyu/dsh-full-life-memory` 自带的 `flm` CLI，读写同一份 SQLite 线索库。

```
QQ 消息 ──► AstrBot ──► 本插件 ──(子进程)──► flm recall ──► memory.db
                              └─ 命中线索时把"回忆提示"拼进 system_prompt
```

## 安装

1. **装 CLI**（二选一）
   - 全局安装：`npm i -g @tuhengyu/dsh-full-life-memory`，之后命令是 `flm`
   - 用源码：`git clone https://github.com/Toctsu/dsh-full-life-memory`，命令写
     `node /path/to/dsh-full-life-memory/bin/flm.mjs`

2. **放插件**：把本目录（`astrbot/`）复制到 `AstrBot/data/plugins/astrbot_plugin_full_life_memory/`，
   重启 AstrBot。

3. **配置**：WebUI → 插件 → 终身记忆，至少确认：
   - `cli`：`flm` 或 `node /path/.../bin/flm.mjs`
   - `db_path`：留空即与 DSH 共享默认库；如果 DSH 那边改过 `dbPath`，这里要写同一个路径

4. **验证**：在群里发 `/recall 数据库`，能看到线索就说明通了。

## 行为

- 只有消息里出现 `trigger_words`（默认：记得 / 还记得 / 之前 / 上次 / 以前 / 那个 / 说过 / 聊过）才回忆
- 同一个群友 `cache_ttl` 秒内只回忆一次，避免每条消息都起一个 Node 进程
- CLI 超时（默认 4s）、报错、没有线索 → 静默跳过，正常回复不受影响
- 注入内容包在 `[记忆线索 · 仅供参考]` 里，并明确要求"不确定就直说记不清，不要编造"

## 和 DSH 的关系

- **只读/只写同一张表**，没有任何服务依赖：DSH 没装、没跑都不影响
- 线索按 `user_id` 隔离（`isolateByUser` 记录的行），查询默认 `scope=auto`：自己的 + 全群共享
- 想让 AstrBot 也**自动写**线索：目前没做，可以用 `/remember` 命令或后续版本补

## 已知限制

- 子进程调用有 100–300ms 开销，所以只做"按需回忆"，不做每条消息都查
- 触发词是字符串匹配，不看语义；想更激进可以清空 `trigger_words`（每次都查，注意延迟）
- AstrBot 的 `on_llm_request` 在部分版本里可能改名，装完看日志有没有
  `[full_life_memory]` 相关报错
