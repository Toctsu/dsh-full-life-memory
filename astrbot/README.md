# 终身记忆 · AstrBot 插件

给 **NapCat + AstrBot** 这类"对话不经过 DSH"的部署用：把 DSH 终身记忆库里的线索
注入群聊上下文，让模型在群里也能"想起"之前聊过什么。

**默认不需要 Node**：读取层是纯标准库 `sqlite3`（`memory.py`），装上就能用。
如果本机有 Node，也可以切到 `flm` CLI（和 DSH 完全同一份实现）。

```
QQ 消息 ──► AstrBot ──► 本插件 ──► memory.py（读 SQLite）──► 线索
                              └─ 命中触发词时拼进 system_prompt
```

## 安装（三选一）

### 1. 从链接安装（推荐，AstrBot 插件页 → 安装插件 → 从链接安装）

填插件仓库地址，例如：

```
https://github.com/Toctsu/astrbot_plugin_full_life_memory
```

> 要求仓库**根目录**就是插件（`main.py`、`metadata.yaml` 同级）。
> 本仓库的 `astrbot/` 目录就是按这个结构组织的。

### 2. 从文件安装

下载 `astrbot_plugin_full_life_memory.zip`（Release 附件），
在插件页 → 安装插件 → 从文件安装，选中这个 zip。

### 3. 手动放目录

把本目录复制到 `AstrBot/data/plugins/astrbot_plugin_full_life_memory/`，重启 AstrBot。

## 配置

WebUI → 插件 → 终身记忆：

| 配置 | 默认 | 说明 |
|---|---|---|
| `backend` | `python` | `python` 内置读取；`cli` 调 `flm`；`auto` 内置失败回退 CLI |
| `db_path` | 空 | 留空用 `~/.dsh/full-life-memory/memory.db`，要与 DSH 的 `dbPath` 一致 |
| `scene` | `qqbot` | 场景标识，用于 `user+scene` 隔离 |
| `isolation` | `user` | `user` 跨群共享；`user+scene` 同场景才共享 |
| `limit` | 5 | 一次取回几条线索 |
| `cache_ttl` | 120 | 同一群友两次回忆的最小间隔（秒） |
| `trigger_words` | 记得/之前/上次… | 命中才回忆 |

`backend=cli` 时还需要：`cli`（`flm` 或 `node /path/bin/flm.mjs`）、`timeout`（默认 4 秒）。

## 行为

- 只有命中 `trigger_words` 才查库；同一个群友 120 秒内只查一次
- 线索包在 `[记忆线索 · 仅供参考]` 里，并要求"不确定就直说记不清，不要编造"
- 库不存在、SQL 出错、CLI 超时 → 静默跳过，正常回复不受影响
- 只读：本插件不会写库；写入仍然由 DSH 的自动遗忘完成

## 验证

1. 群里发 `/recall 数据库` —— 能看到线索说明读通了
2. 发一条含"记得"的消息，看 AstrBot 日志有没有 `[full_life_memory] 注入了一条记忆线索`
3. 没有日志但也不报错：多半是 `db_path` 不对，或库里确实没有匹配的线索

## 已知限制

- 触发词是字符串匹配，不看语义
- 线索按 `user_id` 隔离；如果桥接没有稳定的发送者 ID，只能退化成全群共享
- 每个场景最多注入一次线索块，不叠加多个关键词的结果
