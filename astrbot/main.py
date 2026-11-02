"""AstrBot 插件：把 DSH 终身记忆的线索注入群聊上下文。

思路：AstrBot 里没有 DSH 的 agent 循环，所以不重复实现记忆逻辑，
只用子进程调用同一份 CLI（`flm`）读写同一个 SQLite。

- 命中触发词（记得 / 上次 / 之前 …）时，回忆一次并注入 system prompt
- 每个群友 2 分钟内最多回忆一次，避免每条消息都起子进程
- CLI 超时 / 报错 / 没线索，一律静默跳过，绝不影响正常回复
"""

from __future__ import annotations

import asyncio
import json
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


@register(
    "full_life_memory",
    "tuhengyu",
    "把 DSH 终身记忆的线索注入群聊上下文",
    "0.6.0",
)
class FullLifeMemory(Star):
    def __init__(self, context: Context, config: dict[str, Any] | None = None) -> None:
        super().__init__(context)
        self.config = config or {}
        self._last_recall: dict[str, float] = {}

    # ------------------------------------------------------------------ 配置
    def _cfg(self, key: str, default: Any) -> Any:
        value = self.config.get(key, default)
        return default if value is None else value

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

    # ------------------------------------------------------------ 调 CLI
    async def _run_cli(self, args: list[str], timeout: float) -> dict[str, Any]:
        proc = await asyncio.create_subprocess_exec(
            *self._command(),
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.communicate()
            raise TimeoutError(f"flm 超时（>{timeout}s）")

        if proc.returncode != 0:
            detail = stderr.decode("utf-8", "ignore").strip() or f"exit {proc.returncode}"
            raise RuntimeError(detail)

        return json.loads(stdout.decode("utf-8", "ignore") or "{}")

    async def _recall(self, text: str, user: str) -> str:
        args = [
            "recall",
            "--text",
            text[:200],
            "--scene",
            str(self._cfg("scene", "qqbot")),
            "--limit",
            str(self._cfg("limit", 5)),
        ]
        if user:
            args += ["--user", user]
        db_path = str(self._cfg("db_path", "")).strip()
        if db_path:
            args += ["--db", db_path]

        result = await self._run_cli(args, float(self._cfg("timeout", 4)))
        if not result.get("ok") or not result.get("found"):
            return ""
        return str(result.get("prompt") or "").strip()

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

    # ------------------------------------------------------------ 手动命令
    @filter.command("recall")
    async def recall_command(self, event: AstrMessageEvent):
        """用法：/recall 关键词"""
        try:
            text = str(getattr(event, "message_str", "") or "").strip()
            keyword = text.split(maxsplit=1)[1].strip() if len(text.split(maxsplit=1)) > 1 else ""
            if not keyword:
                yield event.plain_result("用法：/recall 关键词")
                return
            _, user = self._identities(event)
            prompt = await self._recall(keyword, user)
            yield event.plain_result(prompt or f"关于「{keyword}」，我这边没有线索。")
        except Exception as exc:
            logger.warning(f"[full_life_memory] /recall 失败：{exc}")
            yield event.plain_result("回忆暂时不可用，请稍后再试。")
