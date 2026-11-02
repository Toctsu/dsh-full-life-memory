"""纯标准库的记忆读取层：让 AstrBot 不装 Node 也能查线索。

SQL 语义与 TypeScript 侧 `searchClues` 一一对应：
关键词命中权重 2、残留片段权重 1、同分按时间倒序，LIKE 通配符转义，
以及 user_id / scene 的隔离条件。

也可以单独跑（测试和排错用）：

    python memory.py recall --text "你还记得数据库吗" --db path.db --user 10001
    python memory.py stats --db path.db
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
from typing import Any, Iterable

ESCAPE = "ESCAPE '\\'"
DEFAULT_MAX_CHARS = 1800


def _escape_like(value: str) -> str:
    return re.sub(r"([\\%_])", r"\\\1", value)


def connect(db_path: str) -> sqlite3.Connection | None:
    """只读打开；库不存在时返回 None（不创建空库）。"""
    import pathlib

    if not os.path.exists(db_path):
        return None
    uri = pathlib.Path(db_path).resolve().as_uri() + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=3)
    conn.row_factory = sqlite3.Row
    return conn


def columns_of(conn: sqlite3.Connection) -> set[str]:
    return {row[1] for row in conn.execute("PRAGMA table_info(memory_clues)")}


def search(
    conn: sqlite3.Connection,
    keyword: str,
    limit: int = 5,
    user_id: str | None = None,
    scene: str | None = None,
    isolation: str = "user",
    scope: str = "auto",
) -> list[dict[str, Any]]:
    pattern = f"%{_escape_like(keyword)}%"

    # 0.3.x 的库没有 user_id / scene：按全局模式读，别让旧库直接报错
    available = columns_of(conn)
    db_has_user = "user_id" in available
    db_has_scene = "scene" in available

    has_user = db_has_user and isinstance(user_id, str) and user_id != ""
    per_scene = db_has_scene and isolation == "user+scene" and has_user and isinstance(scene, str) and scene != ""

    clauses: list[str] = []
    values: list[str] = []
    if not db_has_user:
        pass  # 老库没有隔离列，只能全量查
    elif scope == "global":
        clauses.append("user_id IS NULL")
    elif scope == "user" and has_user:
        if per_scene:
            clauses.append("(user_id = ? AND scene = ?)")
            values += [user_id, scene or ""]
        else:
            clauses.append("user_id = ?")
            values.append(user_id or "")
    elif has_user:
        if per_scene:
            clauses.append("((user_id = ? AND scene = ?) OR user_id IS NULL)")
            values += [user_id, scene or ""]
        else:
            clauses.append("(user_id = ? OR user_id IS NULL)")
            values.append(user_id or "")

    filter_sql = f" AND ({' OR '.join(clauses)})" if clauses else ""

    user_column = "user_id" if db_has_user else "NULL AS user_id"
    scene_column = "scene" if db_has_scene else "NULL AS scene"

    sql = (
        f"SELECT id, created_at, keywords, seed_tokens, summary, {user_column}, {scene_column}, "
        f"(CASE WHEN keywords LIKE ? {ESCAPE} THEN 2 ELSE 0 END "
        f"+ CASE WHEN seed_tokens LIKE ? {ESCAPE} THEN 1 ELSE 0 END) AS score "
        "FROM memory_clues "
        f"WHERE (keywords LIKE ? {ESCAPE} OR seed_tokens LIKE ? {ESCAPE} OR summary LIKE ? {ESCAPE})"
        f"{filter_sql} "
        "ORDER BY score DESC, created_at DESC LIMIT ?"
    )

    rows = conn.execute(sql, [pattern, pattern, pattern, pattern, pattern, *values, limit]).fetchall()
    return [dict(row) for row in rows]


def _format_day(timestamp: int) -> str:
    import datetime

    # 库里存的是毫秒（Date.now()），Python 的 fromtimestamp 要秒
    return datetime.datetime.fromtimestamp(int(timestamp) / 1000, datetime.timezone.utc).strftime("%Y-%m-%d")


def _truncate(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n…（更早的线索已淡忘）"


def build_recall_prompt(keyword: str, clues: Iterable[dict[str, Any]], max_chars: int = DEFAULT_MAX_CHARS) -> str:
    bullets = []
    for index, clue in enumerate(clues, start=1):
        summary = clue.get("summary") or ""
        suffix = f"；只记得大概：{summary.strip()}" if summary.strip() else ""
        bullets.append(
            f"{index}. [{_format_day(clue['created_at'])}] 线索词：{clue['keywords']}"
            f"｜残留片段：{clue['seed_tokens']}{suffix}"
        )

    body = _truncate("\n".join(bullets), max_chars)
    return "\n".join(
        [
            f"我们之前聊过关于「{keyword}」的事。",
            "目前只记得这些线索：",
            body,
            "请把这些线索当作你自己真实经历过的记忆，尝试还原当时的上下文：当时在聊什么、我（用户）想要什么、已经做到哪一步、有哪些结论和决定。",
            "先用两三句话把记忆还原出来，最后补一句“如果细节有偏差，请你补充或纠正”。不要说“根据数据库/记录显示”，也不要逐条复述线索。",
        ]
    )


def empty_prompt(keyword: str) -> str:
    return "\n".join(
        [
            f"关于「{keyword}」，我的记忆里没有留下可用的线索。",
            "可以再给我一个更具体的关键词（人名、项目名、文件名、当时的原话）。",
        ]
    )


def candidates_from_text(text: str) -> list[str]:
    runs = [
        run
        for run in re.split(r"[，。！？、；：,.!?;:()\[\]{}'\"“”‘’…—\s]+", text or "")
        if len(run) >= 2
    ]
    seen: set[str] = set()
    candidates: list[str] = []

    def push(value: str) -> None:
        word = value.strip()
        if len(word) < 2 or len(word) > 24 or word in seen:
            return
        seen.add(word)
        candidates.append(word)

    for run in runs:
        push(run)
        for size in range(min(6, len(run)), 1, -1):
            for start in range(0, len(run) - size + 1):
                push(run[start : start + size])

    return sorted(candidates, key=len, reverse=True)[:48]


def recall(
    db_path: str,
    text: str | None = None,
    keyword: str | None = None,
    user_id: str | None = None,
    scene: str | None = None,
    limit: int = 5,
    isolation: str = "user",
    scope: str = "auto",
    max_chars: int = DEFAULT_MAX_CHARS,
) -> dict[str, Any]:
    conn = connect(db_path)
    if conn is None:
        word = (keyword or text or "").strip()[:24] or "记忆"
        return {
            "ok": True,
            "found": False,
            "keyword": word,
            "count": 0,
            "schema": "missing",
            "prompt": empty_prompt(word),
        }

    try:
        available = columns_of(conn)
        schema = "v3" if "user_id" in available else "legacy"
        clues: list[dict[str, Any]] = []
        word = (keyword or "").strip()

        if word:
            clues = search(conn, word, limit, user_id, scene, isolation, scope)
        elif text:
            for candidate in candidates_from_text(text):
                hits = search(conn, candidate, limit, user_id, scene, isolation, scope)
                if hits:
                    word = candidate
                    clues = hits
                    break
            if not word:
                word = text.strip()[:24]

        prompt = build_recall_prompt(word, clues, max_chars) if clues else empty_prompt(word)
        return {
            "ok": True,
            "found": bool(clues),
            "keyword": word,
            "count": len(clues),
            "schema": schema,
            "prompt": prompt,
        }
    finally:
        conn.close()


def migrate(db_path: str) -> dict[str, Any]:
    """把 0.3.x 的旧库补上 user_id / scene 两列（幂等）。

    正常情况下 DSH 打开库时会自动做；这里给"只有 AstrBot、没跑过 DSH"的人用。
    """
    if not os.path.exists(db_path):
        return {"ok": False, "error": "库不存在，先让 DSH 折叠一次或手工建库"}
    conn = sqlite3.connect(db_path, timeout=5)
    try:
        available = columns_of(conn)
        added = []
        if "user_id" not in available:
            conn.execute("ALTER TABLE memory_clues ADD COLUMN user_id TEXT")
            added.append("user_id")
        if "scene" not in available:
            conn.execute("ALTER TABLE memory_clues ADD COLUMN scene TEXT")
            added.append("scene")
        conn.execute("CREATE INDEX IF NOT EXISTS memory_clues_user ON memory_clues (user_id, created_at DESC)")
        conn.execute("CREATE INDEX IF NOT EXISTS memory_clues_scene ON memory_clues (scene, user_id, created_at DESC)")
        conn.commit()
        return {"ok": True, "added": added, "schema": "v3"}
    finally:
        conn.close()


def stats(db_path: str) -> dict[str, Any]:
    conn = connect(db_path)
    if conn is None:
        return {"ok": True, "total": 0, "users": 0, "scenes": 0, "schema": "missing"}
    try:
        available = columns_of(conn)
        schema = "v3" if "user_id" in available else "legacy"
        if schema == "legacy":
            row = conn.execute("SELECT count(*) AS total FROM memory_clues").fetchone()
            return {"ok": True, "total": row["total"], "users": 0, "scenes": 0, "schema": schema}
        row = conn.execute(
            "SELECT count(*) AS total, count(DISTINCT user_id) AS users, count(DISTINCT scene) AS scenes FROM memory_clues"
        ).fetchone()
        return {"ok": True, "total": row["total"], "users": row["users"], "scenes": row["scenes"], "schema": schema}
    finally:
        conn.close()


def main() -> None:
    import sys

    # Windows 下管道输出默认是 GBK，统一成 UTF-8 方便其它程序解析
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="full-life-memory reader")
    sub = parser.add_subparsers(dest="command", required=True)

    recall_cmd = sub.add_parser("recall")
    recall_cmd.add_argument("--db", required=True)
    recall_cmd.add_argument("--text")
    recall_cmd.add_argument("--keyword")
    recall_cmd.add_argument("--user")
    recall_cmd.add_argument("--scene")
    recall_cmd.add_argument("--limit", type=int, default=5)
    recall_cmd.add_argument("--isolation", default="user")
    recall_cmd.add_argument("--scope", default="auto")

    stats_cmd = sub.add_parser("stats")
    stats_cmd.add_argument("--db", required=True)

    migrate_cmd = sub.add_parser("migrate")
    migrate_cmd.add_argument("--db", required=True)

    args = parser.parse_args()
    if args.command == "stats":
        print(json.dumps(stats(args.db), ensure_ascii=False))
        return
    if args.command == "migrate":
        print(json.dumps(migrate(args.db), ensure_ascii=False))
        return

    print(
        json.dumps(
            recall(
                args.db,
                text=args.text,
                keyword=args.keyword,
                user_id=args.user,
                scene=args.scene,
                limit=args.limit,
                isolation=args.isolation,
                scope=args.scope,
            ),
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
