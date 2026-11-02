# 发布到 AstrBot 插件市场

AstrBot 的插件市场用 GitHub 托管插件：[先把代码推到 GitHub 仓库](https://docs.astrbot.app/dev/star/plugin-publish.html)，
再到市场页面提交，最终会变成 AstrBot 仓库里的一个 Issue。

## 1. 建独立仓库

仓库名建议就叫 `astrbot_plugin_full_life_memory`（AstrBot 的命名惯例，市场按仓库识别）。

仓库根目录需要**直接**是插件文件，不是子目录：

```
astrbot_plugin_full_life_memory/
├── main.py
├── memory.py
├── metadata.yaml
├── _conf_schema.json
├── README.md
└── logo.png          # 市场要图，建议 512×512
```

本仓库的做法：把 `astrbot/` 目录内容推到独立仓库（可以用 GitHub Action 从主仓库同步，避免双写）。

## 2. 检查 metadata.yaml

```yaml
name: astrbot_plugin_full_life_memory
display_name: 终身记忆（DSH 线索）
desc: 把 DSH 终身记忆库里的线索注入群聊上下文
version: 0.7.0
author: tuhengyu
repo: https://github.com/<你>/astrbot_plugin_full_life_memory
```

- `name` 要和仓库名一致
- `version` 每次发布都要递增，市场用它判断更新
- `desc` 控制在两行内，市场列表只显示一行

## 3. 本地自测

- 装到 `data/plugins/` 后重启，插件列表能看到、能开关
- `/recall 关键词` 有返回
- 日志里没有 `[full_life_memory]` 的异常
- 建议用 `ruff format main.py memory.py` 格式化（AstrBot 官方推荐）

## 4. 提交到市场

1. 打开 AstrBot 插件市场页面，点右下角 **+**
2. 填基本信息（名称、简介、分类）、作者信息、仓库地址
3. 点 **提交到 GitHub**，会跳到 AstrBot 仓库的 Issue 页面
4. 确认信息后 **Create**，等维护者审核

需要注册 **AstrBot Cloud** 账号；插件包体不能超过 **16MB**（我们只有几十 KB）。

## 5. 后续更新

- 改代码 → 改 `metadata.yaml` 的 `version` → push
- 市场会对比版本号提示更新
- 如果只是主仓库的 DSH 插件更新，不需要重新提市场，除非 `astrbot/` 也改了

## 注意

- 仓库必须是 **public**
- 不要提交 `__pycache__/`、`.venv/`（本仓库的 `.gitignore` 已覆盖）
- 市场的分类、标签按实际填写；"工具"或"记忆"类更贴切
