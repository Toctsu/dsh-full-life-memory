"""AstrBot 插件：把 DSH 终身记忆的线索注入群聊上下文。

默认走**纯 Python** 读取（标准库 sqlite3，不需要 Node），
也可以配置成调用 `flm` CLI（与 DSH 完全同一份实现）。

- 命中触发词（记得 / 上次 / 之前 …）时，回忆一次并注入 system prompt
- 每个群友 2 分钟内最多回忆一次，避免每条消息都查库
- 任何异常（库不存在、CLI 超时）都静默跳过，绝不影响正常回复
- 旧版库（0.3.x，缺 user_id/scene）会自动补列，不用手动迁移
- `/recall` 只给管理员用，返回线索摘要而不是模型提示词
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import pathlib
import shlex
import time
from typing import Any

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register

try:  # 老版本 AstrBot 没有这个模块，做个兜底
    from astrbot.api.provider import ProviderRequest  # type: ignore
except Exception:  # pragma: no cover
    ProviderRequest = Any  # type: ignore

DEFAULT_TRIGGERS = ["记得", "还记得", "之前", "上次", "以前", "那个", "说过", "聊过"]
_MEMORY_MODULE: Any = None


def _memory_module() -> Any:
    """按文件路径加载同目录的 memory.py，避免依赖包的导入方式。"""
    global _MEMORY_MODULE
    if _MEMORY_MODULE is None:
        path = pathlib.Path(__file__).with_name("memory.py")
        spec = importlib.util.spec_from_file_location("flm_memory", path)
        if spec is None or spec.loader is None:
            raise RuntimeError("memory.py 加载失败")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _MEMORY_MODULE = module
    return _MEMORY_MODULE


@register(
    "full_life_memory",
    "tuhengyu",
    "把 DSH 终身记忆的线索注入群聊上下文（纯 Python 读取，无需 Node）",
    "0.7.3",
)
class FullLifeMemory(Star):
    def __init__(self, context: Context, config: dict[str, Any] | None = None) -> None:
        super().__init__(context)
        self.config = config or {}
        self._last_recall: dict[str, float] = {}
        self._legacy_warned = False

    # ------------------------------------------------------------------ 配置
    def _cfg(self, key: str, default: Any) -> Any:
        value = self.config.get(key, default)
        return default if value is None else value

    def _db_path(self) -> str:
        raw = str(self._cfg("db_path", "")).strip()
        if raw:
            return raw
        return os.path.join(os.path.expanduser("~"), ".dsh", "full-life-memory", "memory.db")

    def _isolation(self) -> str:
        # 默认按场景隔离：QQ 群只回忆 QQ 群的事，桌面工作记忆留在桌面
        return "user" if str(self._cfg("isolation", "user+scene")) == "user" else "user+scene"

    def _command(self) -> list[str]:
        raw = str(self._cfg("cli", "flm")).strip()
        return shlex.split(raw) if raw else ["flm"]

    # ------------------------------------------------------------ 事件取值
    @staticmethod
    def _call(event: Any, *names: str) -> str:
        for name in names:
            fn = getattr(event, name, None)
            if callable(fn):
                try:
                    value = fn()
                except Exception:
                    continue
                if value:
                    return str(value)
        return ""

    def _identities(self, event: Any) -> tuple[str, str]:
        group = self._call(event, "get_group_id", "get_group_id_str")
        user = self._call(event, "get_sender_id", "get_sender_id_str")
        return group, user

    @staticmethod
    def _is_admin(event: Any) -> bool:
        fn = getattr(event, "is_admin", None)
        if callable(fn):
            try:
                return bool(fn())
            except Exception:
                return False
        # 老版本没有权限 API：不拦，避免命令直接不可用
        return True

    # ------------------------------------------------------------ 两种后端
    def _lookup_python(self, text: str, user: str, exact: bool) -> dict[str, Any]:
        module = _memory_module()
        db_path = self._db_path()

        def query() -> dict[str, Any]:
            common = {
                "user_id": user or None,
                "scene": str(self._cfg("scene", "qqbot")),
                "limit": int(self._cfg("limit", 5)),
                "isolation": self._isolation(),
                "scope": "auto",
            }
            if exact:
                return module.recall(db_path, keyword=text, **common)
            return module.recall(db_path, text=text, **common)

        result = query()

        # 旧库（0.3.x）没有 user_id / scene：就地补列再查一次，避免用户手动迁移
        if result.get("schema") == "legacy":
            try:
                module.migrate(db_path)
                result = query()
                logger.info("[full_life_memory] 旧版记忆库已自动升级（补充 user_id / scene 列）")
            except Exception as exc:
                if not self._legacy_warned:
                    self._legacy_warned = True
                    logger.warning(
                        f"[full_life_memory] 记忆库是旧版结构且无法自动升级（{exc}），本次按全局读取；"
                        "可运行 python memory.py migrate --db <库路径>"
                    )

        return result

    async def _lookup_cli(self, text: str, user: str, exact: bool) -> dict[str, Any]:
        args = [
            "recall",
            "--keyword" if exact else "--text",
            text[:200],
            "--scene",
            str(self._cfg("scene", "qqbot")),
            "--limit",
            str(self._cfg("limit", 5)),
            "--isolation",
            self._isolation(),
        ]
        if user:
            args += ["--user", user]
        if str(self._cfg("db_path", "")).strip():
            args += ["--db", str(self._cfg("db_path", "")).strip()]

        proc = await asyncio.create_subprocess_exec(
            *self._command(),
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=float(self._cfg("timeout", 4))
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.communicate()
            raise TimeoutError(f"flm 超时（>{self._cfg('timeout', 4)}s）")

        if proc.returncode != 0:
            detail = stderr.decode("utf-8", "ignore").strip() or f"exit {proc.returncode}"
            raise RuntimeError(detail)

        return json.loads(stdout.decode("utf-8", "ignore") or "{}")

    async def _lookup(self, text: str, user: str, exact: bool = False) -> dict[str, Any]:
        backend = str(self._cfg("backend", "python")).lower()
        if backend == "cli":
            return await self._lookup_cli(text, user, exact)
        try:
            return self._lookup_python(text, user, exact)
        except Exception as exc:
            logger.warning(f"[full_life_memory] 内置读取失败：{exc}")
            if backend == "auto":
                return await self._lookup_cli(text, user, exact)
            return {"ok": False, "found": False, "count": 0, "items": []}

    # ------------------------------------------------------------ 两种输出
    async def _recall(self, text: str, user: str) -> str:
        result = await self._lookup(text, user, exact=False)
        return str(result.get("prompt") or "") if result.get("found") else ""

    async def _digest(self, keyword: str, user: str) -> str:
        """给管理员看的摘要：只列线索，不贴模型提示词。"""
        result = await self._lookup(keyword, user, exact=True)
        items = result.get("items") or []
        if not items:
            return f"关于「{keyword}」，我这边没有线索。"

        lines = [f"「{keyword}」找到 {len(items)} 条线索："]
        for index, item in enumerate(items[:5], start=1):
            date = str(item.get("date") or "")
            keywords = str(item.get("keywords") or "")
            seed = str(item.get("seed") or "")
            lines.append(f"{index}. [{date}] {keywords}｜{seed}")
        return "\n".join(lines)

    # ------------------------------------------------------------ 注入钩子
    @filter.on_llm_request()
    async def inject_memory(self, event: AstrMessageEvent, req: ProviderRequest) -> None:
        try:
            text = str(getattr(event, "message_str", "") or "").strip()
            if not text:
                return

            triggers = self._cfg("trigger_words", DEFAULT_TRIGGERS)
            if isinstance(triggers, str):
                triggers = [item.strip() for item in triggers.split(",") if item.strip()]
            if not any(str(word) in text for word in triggers):
                return

            group, user = self._identities(event)
            cache_key = f"{group}:{user}"
            now = time.time()
            ttl = float(self._cfg("cache_ttl", 120))
            if now - self._last_recall.get(cache_key, 0.0) < ttl:
                return
            self._last_recall[cache_key] = now

            prompt = await self._recall(text, user)
            if not prompt:
                return

            block = (
                "\n\n[记忆线索 · 仅供参考]\n"
                f"{prompt}\n"
                "[线索结束] 这些只是零散线索：不确定就直说记不清，不要编造，"
                "也不要说“根据数据库/记录”。"
            )
            req.system_prompt = (getattr(req, "system_prompt", "") or "") + block
            logger.info(f"[full_life_memory] 为 {cache_key or '未知会话'} 注入了一条记忆线索")
        except Exception as exc:  # 任何失败都不影响正常回复
            logger.warning(f"[full_life_memory] 回忆跳过：{exc}")

    # ------------------------------------------------------------ 管理员命令
    @filter.command("recall")
    async def recall_command(self, event: AstrMessageEvent):
        """用法：/recall 关键词（仅管理员）"""
        try:
            if not self._is_admin(event):
                yield event.plain_result("这个命令仅管理员可用。")
                return

            text = str(getattr(event, "message_str", "") or "").strip()
            parts = text.split(maxsplit=1)
            keyword = parts[1].strip() if len(parts) > 1 else ""
            if not keyword:
                yield event.plain_result("用法：/recall 关键词（精确匹配）")
                return

            _, user = self._identities(event)
            yield event.plain_result(await self._digest(keyword, user))
        except Exception as exc:
            logger.warning(f"[full_life_memory] /recall 失败：{exc}")
            yield event.plain_result("回忆暂时不可用，请稍后再试。")
