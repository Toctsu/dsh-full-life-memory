/**
 * @tuhengyu/dsh-full-life-memory — 仿生终身记忆
 *
 * Phase 1（回忆）：不保存对话原文，也不做向量检索。每次“遗忘”只把一小撮线索
 * （keywords + seed_tokens）写进本地 SQLite；被问到旧事时，recall_from_clues
 * 把这些线索重新组装成一段“回忆提示”交给模型，由模型自己去重建上下文。
 *
 * Phase 2（自动遗忘）：监听 agent/pre-step，按 ctx.tokenMeter 的压力判断阈值；
 * 到达阈值后把最旧的若干「已完成轮次」蒸馏成线索写库，然后用 Session 的
 * surface replace 把这批消息从当前面上切除，换成一枚“记忆已折叠”提示。
 * 这条 surface 替换正是 DSH 自身 compaction 使用的机制（见 dsh-compaction-basic
 * 的 commitCompactionBody），所以模型下一轮请求里真的看不到那两轮对话了。
 *
 * 运行时：DSH Host（Electron 44 / Node 24），只用内置 node:sqlite，零第三方依赖。
 * @module @tuhengyu/dsh-full-life-memory
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import z from '@deepseek-ai/schemastery';
export const name = 'full-life-memory';
/** tools 是硬依赖；tokenMeter / compaction / settings 都按需 ctx.get()，装没装都能跑。 */
export const inject = ['tools'];
/**
 * 场景覆盖：键是场景标识（会话 header.agentPreset，缺省时用 origin，最后回落到 default）。
 * 只有写出来的字段才覆盖全局值。
 */
export const SceneSchema = z.object({
    enabled: z.boolean().default(true),
    forgetThresholdTokens: z.natural().min(500).max(200000),
    forgetTurns: z.natural().min(1).max(10),
    keepCompletedTurns: z.natural().min(0).max(50),
});
/**
 * 可在设置界面里直接调整的参数。
 * `.volatile()` 让 DSH 在保存时就地更新运行中的值（不用重启），设置页也按这份 schema 生成表单。
 */
export const Config = z.object({
    dbPath: z.string().default('').volatile(),
    limit: z.natural().min(1).max(20).default(5).volatile(),
    maxPromptChars: z.natural().min(200).max(20000).default(1800).volatile(),
    autoForget: z.boolean().default(true).volatile(),
    forgetThresholdTokens: z.natural().min(500).max(200000).default(8000).volatile(),
    forgetTurns: z.natural().min(1).max(10).default(2).volatile(),
    keepCompletedTurns: z.natural().min(0).max(50).default(4).volatile(),
    sceneOverrides: z.dict(SceneSchema).default({}).volatile(),
});
const DEFAULT_DB_PATH = join(homedir(), '.dsh', 'full-life-memory', 'memory.db');
const DEFAULT_LIMIT = 5;
const DEFAULT_MAX_PROMPT_CHARS = 1800;
const DEFAULT_THRESHOLD_TOKENS = 8000;
const DEFAULT_FORGET_TURNS = 2;
const DEFAULT_KEEP_TURNS = 4;
/**
 * 线索引擎的全部持久化结构。这里刻意没有 message 正文字段：
 * 一旦存了全文，就等于又把上下文搬回来了。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_clues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT,
  created_at  INTEGER NOT NULL,
  keywords    TEXT NOT NULL,
  seed_tokens TEXT NOT NULL,
  summary     TEXT
);
CREATE INDEX IF NOT EXISTS memory_clues_created_at ON memory_clues (created_at DESC);
`;
const LIKE_ESCAPE = "ESCAPE '\\'";
/** LIKE 里 % 和 _ 是通配符，用户关键词里的这两个字符必须转义。 */
function escapeLike(value) {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
/** `.volatile()` 字段在运行期是 { get() } 引用；两种形态都接受。 */
function liveValue(value) {
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
        try {
            return value.get();
        }
        catch {
            return undefined;
        }
    }
    return value;
}
/** 每步重新读一次：volatile 字段保存后立即生效，不用重启。 */
function currentConfig(ctx, fallback) {
    const source = ctx.config;
    const raw = source !== null && typeof source === 'object' ? source : undefined;
    if (raw === undefined)
        return fallback ?? {};
    return {
        dbPath: liveValue(raw.dbPath),
        limit: liveValue(raw.limit),
        maxPromptChars: liveValue(raw.maxPromptChars),
        autoForget: liveValue(raw.autoForget),
        forgetThresholdTokens: liveValue(raw.forgetThresholdTokens),
        forgetTurns: liveValue(raw.forgetTurns),
        keepCompletedTurns: liveValue(raw.keepCompletedTurns),
        sceneOverrides: liveValue(raw.sceneOverrides),
    };
}
function resolveConfig(config) {
    const limit = Number(liveValue(config?.limit));
    const maxPromptChars = Number(liveValue(config?.maxPromptChars));
    const threshold = Number(liveValue(config?.forgetThresholdTokens));
    const forgetTurns = Number(liveValue(config?.forgetTurns));
    const keepTurns = Number(liveValue(config?.keepCompletedTurns));
    const dbPath = liveValue(config?.dbPath);
    const autoForget = liveValue(config?.autoForget);
    return {
        dbPath: dbPath ? dbPath : DEFAULT_DB_PATH,
        limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 20) : DEFAULT_LIMIT,
        maxPromptChars: Number.isFinite(maxPromptChars) && maxPromptChars >= 200
            ? Math.floor(maxPromptChars)
            : DEFAULT_MAX_PROMPT_CHARS,
        autoForget: autoForget !== false,
        forgetThresholdTokens: Number.isFinite(threshold) && threshold >= 500 ? Math.floor(threshold) : DEFAULT_THRESHOLD_TOKENS,
        forgetTurns: Number.isInteger(forgetTurns) && forgetTurns >= 1 ? Math.min(forgetTurns, 10) : DEFAULT_FORGET_TURNS,
        keepCompletedTurns: Number.isInteger(keepTurns) && keepTurns >= 0 ? Math.min(keepTurns, 50) : DEFAULT_KEEP_TURNS,
        sceneOverrides: normalizeScenes(liveValue(config?.sceneOverrides)),
    };
}
/** 把配置里的场景表整理成稳定的形状：键小写、数字裁剪到合法区间、未知键丢弃。 */
function normalizeScenes(value) {
    if (value === null || typeof value !== 'object')
        return {};
    const result = {};
    for (const [rawKey, rawScene] of Object.entries(value)) {
        const key = rawKey.trim().toLowerCase();
        if (key === '' || rawScene === null || typeof rawScene !== 'object')
            continue;
        const scene = rawScene;
        const entry = {};
        if (typeof scene.enabled === 'boolean')
            entry.enabled = scene.enabled;
        const threshold = Number(liveValue(scene.forgetThresholdTokens));
        if (Number.isFinite(threshold) && threshold >= 500)
            entry.forgetThresholdTokens = Math.floor(Math.min(threshold, 200000));
        const turns = Number(liveValue(scene.forgetTurns));
        if (Number.isInteger(turns) && turns >= 1)
            entry.forgetTurns = Math.min(turns, 10);
        const keep = Number(liveValue(scene.keepCompletedTurns));
        if (Number.isInteger(keep) && keep >= 0)
            entry.keepCompletedTurns = Math.min(keep, 50);
        result[key] = entry;
    }
    return result;
}
/**
 * 当前会话属于哪个场景。
 * DSH 的 SessionHeader 没有独立的渠道字段：外部接入（QQ/微信）通常以自己的 agent 预设建会话，
 * 所以优先 agentPreset，其次 origin，最后 default。
 */
export function sceneOf(session) {
    const header = session.header ?? {};
    const preset = typeof header.agentPreset === 'string' ? header.agentPreset.trim().toLowerCase() : '';
    if (preset !== '')
        return preset;
    const origin = typeof header.origin === 'string' ? header.origin.trim().toLowerCase() : '';
    return origin !== '' ? origin : 'default';
}
/** 全局默认 + 场景覆盖后的生效值。场景没写的字段才回落到全局。 */
export function resolveScene(settings, scene) {
    const override = settings.sceneOverrides[scene];
    if (override === undefined)
        return settings;
    return {
        ...settings,
        autoForget: override.enabled === undefined ? settings.autoForget : override.enabled,
        forgetThresholdTokens: override.forgetThresholdTokens ?? settings.forgetThresholdTokens,
        forgetTurns: override.forgetTurns ?? settings.forgetTurns,
        keepCompletedTurns: override.keepCompletedTurns ?? settings.keepCompletedTurns,
    };
}
/** 打开（并按需创建）线索库；PRAGMA 放在这里，所有入口共享同一套设置。 */
function openDb(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 3000');
    db.exec(SCHEMA);
    return db;
}
function normalizeList(value) {
    const items = (Array.isArray(value) ? value : value.split(/[,，、;；\n]/))
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    return items.join(', ');
}
/** 写入一条线索，返回行 id。自动遗忘和手工 seed 都走这里。 */
export function storeClue(db, clue) {
    const keywords = normalizeList(clue.keywords);
    const seedTokens = normalizeList(clue.seedTokens);
    if (keywords === '' || seedTokens === '') {
        throw new Error('storeClue: keywords 和 seedTokens 都不能为空');
    }
    const result = db
        .prepare(`INSERT INTO memory_clues (session_id, created_at, keywords, seed_tokens, summary)
       VALUES (?, ?, ?, ?, ?)`)
        .run(clue.sessionId ?? null, clue.createdAt ?? Date.now(), keywords, seedTokens, clue.summary ?? null);
    return Number(result.lastInsertRowid);
}
/** 便捷入口：自己开库、写入、关库。seed 脚本和 Phase 2 钩子都可以直接用。 */
export function rememberClue(dbPath, clue) {
    const db = openDb(dbPath);
    try {
        return storeClue(db, clue);
    }
    finally {
        db.close();
    }
}
/**
 * 按关键词模糊匹配线索，命中的“线索词”权重 2、“残留片段”权重 1，
 * 同分按时间倒序。用 LIKE 而不是 FTS5：中文不分词，线索本来就短。
 */
function searchClues(db, keyword, limit) {
    const pattern = `%${escapeLike(keyword)}%`;
    const rows = db
        .prepare(`SELECT id, created_at, keywords, seed_tokens, summary,
              (CASE WHEN keywords    LIKE ? ${LIKE_ESCAPE} THEN 2 ELSE 0 END
             + CASE WHEN seed_tokens LIKE ? ${LIKE_ESCAPE} THEN 1 ELSE 0 END) AS score
         FROM memory_clues
        WHERE keywords    LIKE ? ${LIKE_ESCAPE}
           OR seed_tokens LIKE ? ${LIKE_ESCAPE}
           OR summary     LIKE ? ${LIKE_ESCAPE}
        ORDER BY score DESC, created_at DESC
        LIMIT ?`)
        .all(pattern, pattern, pattern, pattern, pattern, limit);
    return rows;
}
function formatDay(timestamp) {
    return new Date(timestamp).toISOString().slice(0, 10);
}
function truncate(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    return `${text.slice(0, maxChars)}\n…（更早的线索已淡忘）`;
}
/**
 * 核心：把数据库里的事实重新组装成“回忆”，而不是把数据交给模型。
 * 这就是和 RAG 的分界——检索结果不是证据，是记忆的引子。
 */
export function buildRecallPrompt(keyword, clues, maxChars) {
    const bullets = clues.map((clue, index) => {
        const summary = clue.summary && clue.summary.trim() !== '' ? `；只记得大概：${clue.summary.trim()}` : '';
        return `${index + 1}. [${formatDay(clue.created_at)}] 线索词：${clue.keywords}｜残留片段：${clue.seed_tokens}${summary}`;
    });
    const body = truncate(bullets.join('\n'), maxChars);
    return [
        `我们之前聊过关于「${keyword}」的事。`,
        '目前只记得这些线索：',
        body,
        '请把这些线索当作你自己真实经历过的记忆，尝试还原当时的上下文：当时在聊什么、我（用户）想要什么、已经做到哪一步、有哪些结论和决定。',
        '先用两三句话把记忆还原出来，最后补一句“如果细节有偏差，请你补充或纠正”。不要说“根据数据库/记录显示”，也不要逐条复述线索。',
    ].join('\n');
}
function buildEmptyPrompt(keyword) {
    return [
        `关于「${keyword}」，我的记忆里没有留下可用的线索。`,
        '可以再给我一个更具体的关键词（人名、项目名、文件名、当时的原话），或者告诉我大概是什么时候的事，我再试着回忆。',
        '如果确实没聊过，就把它当作新话题开始。',
    ].join('\n');
}
/* -------------------------------------------------------------------------- */
/* Phase 2：蒸馏 + 切除                                                       */
/* -------------------------------------------------------------------------- */
const WORD_STOP = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'will', 'been', 'would', 'could',
    'should', 'about', 'there', 'their', 'when', 'what', 'which', 'your', 'you', 'are', 'was',
    'were', 'not', 'but', 'can', 'all', 'any', 'into', 'than', 'then', 'them', 'they', 'its',
    'http', 'https',
]);
const CJK_STOP = new Set([
    '但是', '然后', '因为', '所以', '现在', '可以', '需要', '我们', '你们', '他们', '这个', '那个',
    '就是', '已经', '还是', '如果', '不过', '其实', '一下', '东西', '问题', '时候', '可能', '这样',
    '那样', '什么', '怎么', '没有', '不是', '一个', '这里', '那里', '同时', '并且',
]);
function clip(text, max) {
    const value = text.replace(/\s+/g, ' ').trim();
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
/**
 * 规则蒸馏：不开 LLM 也能把两轮对话压成几条线索词。
 * 想换成语义摘要时，只需要替换这个函数（保持返回结构不变）。
 */
export function extractClue(texts) {
    const joined = texts.join('\n');
    const found = [];
    const seen = new Set();
    const push = (raw) => {
        const word = raw.trim().replace(/^[\s"'`（(【\[]+|[\s"'`）)】\],.;:!?]+$/g, '');
        if (word.length < 2 || word.length > 60)
            return;
        const key = word.toLowerCase();
        if (seen.has(key) || WORD_STOP.has(key) || CJK_STOP.has(word))
            return;
        // 已经是某条更完整线索的后缀（或反之）就不再重复：E:/x/app.ts 与 app.ts 只留前者。
        if (found.some((existing) => {
            const lower = existing.toLowerCase();
            return lower.endsWith(`/${key}`) || key.endsWith(`/${lower}`);
        }))
            return;
        seen.add(key);
        found.push(word);
    };
    for (const match of joined.matchAll(/[「“"'‘]([^」”"'’]{2,30})[」”"'’]/g))
        push(match[1] ?? '');
    for (const match of joined.matchAll(/(?:[A-Za-z]:[\\/]|\/|\.{1,2}\/)?[\w@./\\-]+\.(?:ts|tsx|js|mjs|cjs|json|ya?ml|md|py|rs|go|sql|toml|env)\b/g))
        push(match[0]);
    for (const match of joined.matchAll(/[A-Za-z][A-Za-z0-9_.:\-/@]{2,40}/g))
        push(match[0]);
    for (const run of joined.split(/[，。！？；：、\s…,.!?;:\n\r\t()（）【】「」“”"'`]+/)) {
        const text = run.trim();
        if (text.length >= 2 && text.length <= 16 && /[\u4e00-\u9fa5]/.test(text))
            push(text);
    }
    const seedTokens = [];
    const first = (texts[0] ?? '').replace(/\s+/g, ' ').trim();
    if (first !== '')
        seedTokens.push(clip(first, 60));
    const last = (texts[texts.length - 1] ?? '').replace(/\s+/g, ' ').trim();
    if (last !== '' && last !== first)
        seedTokens.push(clip(last, 60));
    for (const match of joined.matchAll(/https?:\/\/\S{4,80}/g))
        seedTokens.push(clip(match[0], 80));
    const keywords = found.slice(0, 8);
    if (keywords.length === 0 && first !== '')
        keywords.push(clip(first, 16));
    return {
        keywords,
        seedTokens: [...new Set(seedTokens)].slice(0, 4),
        summary: first === '' ? '' : clip(first, 60),
    };
}
function messageText(message) {
    if (message === null || message === undefined)
        return '';
    const blocks = message.content ?? [];
    return blocks
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
}
/** seq → 轮次号。只记录 turn/start 到 turn/end 之间的事件。 */
function turnOfSeq(events) {
    const map = new Map();
    let turn = null;
    for (const event of events) {
        if (event.type === 'turn/start') {
            const value = event.data?.turn;
            turn = typeof value === 'number' ? value : null;
            continue;
        }
        if (event.type === 'turn/end') {
            turn = null;
            continue;
        }
        if (turn !== null)
            map.set(event.seq, turn);
    }
    return map;
}
function isSystemHead(session) {
    const first = session.surface.nodes[0];
    if (first === undefined)
        return false;
    return session.eventAt(first)?.type === 'system/message';
}
/**
 * 切除区间必须工具配对平衡：区间内不能留未回应的 tool-call，
 * 否则请求会带着半个 step 出去。这里按 surface 顺序重放增量。
 */
function spanIsBalanced(session, startIdx, endIdx) {
    const nodes = session.surface.nodes;
    let openCalls = 0;
    for (let index = startIdx; index <= endIdx; index += 1) {
        const event = session.eventAt(nodes[index]);
        if (event === undefined)
            return false;
        if (event.type === 'tool/result')
            openCalls -= 1;
        if (openCalls < 0)
            return false;
        if (event.type === 'assistant/message') {
            const content = (event.data?.message?.content ?? []);
            openCalls += content.filter((block) => block.type === 'tool-call').length;
        }
    }
    return openCalls === 0;
}
/** 找一个未闭合的 compaction/start：压缩正在进行时不要跟它抢 surface。 */
function compactionActive(events) {
    let active = false;
    for (const event of events) {
        if (event.type === 'compaction/start')
            active = true;
        else if (event.type === 'compaction/end')
            active = false;
    }
    return active;
}
/**
 * 选出最旧的 N 个「已完成轮次」对应的 surface 区间。
 * 只切已完成轮次 = 边界天然落在工具配对平衡处；同时永远保留最近 keepCompletedTurns 轮。
 */
export function selectForgettableSpan(session, options, events = session.snapshotEvents()) {
    const completed = [];
    for (const event of events) {
        if (event.type !== 'turn/end')
            continue;
        const turn = event.data?.turn;
        if (typeof turn === 'number' && !completed.includes(turn))
            completed.push(turn);
    }
    completed.sort((a, b) => a - b);
    if (completed.length < options.forgetTurns + options.keepCompletedTurns)
        return null;
    const turns = completed.slice(0, options.forgetTurns);
    const wanted = new Set(turns);
    const turnMap = turnOfSeq(events);
    const nodes = session.surface.nodes;
    let startIdx = -1;
    let endIdx = -1;
    for (let index = 0; index < nodes.length; index += 1) {
        const turn = turnMap.get(nodes[index]);
        const inside = turn !== undefined && wanted.has(turn);
        if (inside) {
            if (startIdx === -1)
                startIdx = index;
            endIdx = index;
            continue;
        }
        if (startIdx !== -1)
            break;
    }
    if (startIdx === -1 || endIdx < startIdx)
        return null;
    // surface 第 0 个节点若是 system prompt，绝不切它。
    if (startIdx === 0 && isSystemHead(session))
        startIdx = 1;
    if (startIdx > endIdx)
        return null;
    if (!spanIsBalanced(session, startIdx, endIdx))
        return null;
    return {
        startSeq: nodes[startIdx],
        endSeq: nodes[endIdx],
        shadowedSeqs: nodes.slice(startIdx, endIdx + 1),
        turns,
    };
}
function measureTokens(ctx, session) {
    const meter = ctx.get('tokenMeter');
    if (meter !== undefined && typeof meter.measure === 'function') {
        try {
            const measurement = meter.measure(session);
            if (typeof measurement?.totalTokens === 'number')
                return measurement.totalTokens;
        }
        catch {
            /* 测量失败就走下面的粗估分支 */
        }
    }
    let chars = 0;
    for (const seq of session.surface.nodes) {
        const message = session.deriveEventMessage?.(session.eventAt(seq));
        for (const block of message?.content ?? []) {
            if (block.type === 'text' && typeof block.text === 'string')
                chars += block.text.length;
        }
    }
    return Math.ceil(chars / 3);
}
function buildForgetNotice(clue, turnCount) {
    const keys = clue.keywords.length > 0 ? clue.keywords.slice(0, 3).join('、') : clue.summary;
    const tail = keys === '' ? '' : `留下的线索：${keys}。`;
    return `【🧠 记忆已折叠】为了腾出空间，我已淡忘更早的 ${turnCount} 轮对话，${tail}需要时我会用 recall_from_clues 自己回忆。`;
}
/** 被切掉的区间大概占多少 token，给 compaction 行做展示；测不到就退化成字符估算。 */
function shadowedTokens(ctx, session, seqs) {
    const meter = ctx.get('tokenMeter');
    try {
        const nodes = meter?.measure(session)?.nodes ?? [];
        let total = 0;
        for (const node of nodes)
            if (seqs.includes(node.seq))
                total += node.tokens;
        if (total > 0)
            return total;
    }
    catch {
        /* 落回字符估算 */
    }
    let chars = 0;
    for (const seq of seqs) {
        const message = session.deriveEventMessage?.(session.eventAt(seq));
        for (const block of message?.content ?? []) {
            if (block.type === 'text' && typeof block.text === 'string')
                chars += block.text.length;
        }
    }
    return Math.ceil(chars / 3);
}
/**
 * 造一条与 dsh-llm 的 createUserMessage + compactCheckpointSource 等价的消息。
 * 不 import 它们，是为了让插件在任意解析根下都能加载（DSH 包不在本包的依赖树里）。
 */
function createNoticeMessage(text, compactionId) {
    return {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'compact-checkpoint', compactionId },
    };
}
/**
 * 注册自动遗忘钩子。
 *
 * agent/pre-step 是 waterfall，签名 (payload, next)：payload 里有 agent / turn / step / signal，
 * 返回 next() 表示放行当前这一步。它的 messages 只是“本步收件箱”，改不动历史——
 * 真正切历史靠 session.append 的 surfaceOp.replace，也就是 compaction 用的同一条路径。
 */
export function installForgettingHook(ctx, readSettings, connection) {
    let lastCutTurn = -1;
    ctx.on('agent/pre-step', async (payload, next) => {
        try {
            const settings = readSettings();
            const session = payload?.agent?.session;
            if (session === undefined)
                return await next();
            // 先认场景，再用「全局默认 + 场景覆盖」算出生效值
            const scene = sceneOf(session);
            const effective = resolveScene(settings, scene);
            if (!effective.autoForget)
                return await next();
            if (payload.signal?.aborted === true)
                return await next();
            // 同一轮只切一次，避免一步一刀把当前轮掏空。
            if (payload.turn === lastCutTurn)
                return await next();
            const tokens = measureTokens(ctx, session);
            if (tokens < effective.forgetThresholdTokens)
                return await next();
            const events = session.snapshotEvents();
            if (compactionActive(events))
                return await next();
            const span = selectForgettableSpan(session, effective, events);
            if (span === null)
                return await next();
            const texts = [];
            for (const seq of span.shadowedSeqs) {
                texts.push(messageText(session.deriveEventMessage?.(session.eventAt(seq))));
            }
            const clue = extractClue(texts.filter((text) => text.trim() !== ''));
            if (clue.seedTokens.length === 0)
                return await next();
            // 先落库：这一步失败就不开 compaction 事务，surface 保持原样。
            storeClue(connection(settings.dbPath), {
                sessionId: String(payload.agent?.id ?? session.id ?? ''),
                keywords: clue.keywords,
                seedTokens: clue.seedTokens,
                summary: clue.summary,
            });
            // 走 DSH 自己的 compaction 词汇：Chat 会把这一段渲染成一行“记忆已折叠”，
            // 模型则只看到被替换进去的那条 checkpoint 消息。
            const compactionId = randomUUID();
            const notice = buildForgetNotice(clue, span.turns.length);
            session.append('compaction/start', { compactionId, turn: payload.turn });
            try {
                session.append('compaction/summary', {
                    compactionId,
                    summary: [{ type: 'text', text: notice }],
                    shadowedRange: { start: span.startSeq, end: span.endSeq },
                    shadowedSeqs: span.shadowedSeqs,
                    shadowedTokenCount: shadowedTokens(ctx, session, span.shadowedSeqs),
                    provider: 'full-life-memory',
                    model: 'clue-rules',
                });
                session.append('user/message', createNoticeMessage(notice, compactionId), {
                    surfaceOp: { op: 'replace', startSeq: span.startSeq, endSeq: span.endSeq },
                    sourceEventSeqs: span.shadowedSeqs,
                });
            }
            finally {
                // 无论替换是否成功都闭合事务，避免留下会锁住真实 compaction 的 unpaired start。
                session.append('compaction/end', { compactionId, turn: payload.turn });
            }
            lastCutTurn = payload.turn;
            ctx.logger?.info?.(`full-life-memory: folded ${span.turns.length} turn(s) (~${tokens} tokens) in scene "${scene}" ` +
                `from surface seq ${span.startSeq}..${span.endSeq} as compaction ${compactionId}; clues: ${clue.keywords.join(', ')}`);
        }
        catch (error) {
            ctx.logger?.warn?.(`full-life-memory: forget skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
        return await next();
    });
}
/* -------------------------------------------------------------------------- */
/* 工具：recall_from_clues                                                    */
/* -------------------------------------------------------------------------- */
/**
 * 注册 recall_from_clues。
 * 参数 schema 用标准 JSON Schema：dsh-tools 的 register() 直接把它投影给模型，
 * 而 defineTool 只是把简写 DSL 变成这个形状的辅助函数。
 */
export function apply(ctx, config) {
    const readSettings = () => resolveConfig(currentConfig(ctx, config));
    let db;
    let openPath = '';
    const connection = (path) => {
        const target = path === '' ? DEFAULT_DB_PATH : path;
        if (db === undefined || openPath !== target) {
            try {
                db?.close();
            }
            catch {
                /* 换库时旧句柄可能已被关闭 */
            }
            db = openDb(target);
            openPath = target;
        }
        return db;
    };
    // 卸载 / HMR 时关掉句柄，避免 SQLite 文件被长期占住。
    ctx.effect(() => () => {
        db?.close();
        db = undefined;
        openPath = '';
    });
    // 自带设置页：关掉 schema 的自动生成页面，避免和自定义页面重复。
    try {
        const injectChild = ctx.inject;
        if (typeof injectChild === 'function') {
            injectChild.call(ctx, ['settings'], (child) => {
                child.effect(() => child.settings.configure({ auto: false }));
            });
        }
    }
    catch {
        /* 没有 settings 服务时保持默认 */
    }
    ctx.tools.register({
        name: 'recall_from_clues',
        description: 'Recall an earlier conversation from the clues kept when its details were forgotten. ' +
            'Use it when the user refers to something you have no context for ("as we discussed", "that project from last week", a name you do not recognize), ' +
            'or when a topic feels familiar but the specifics are gone. ' +
            'Returns a memory prompt assembled from clue words and leftover fragments: read it as your own recollection and reconstruct what was going on, ' +
            'rather than quoting it as a record. Call once per clue, starting with the most distinctive word the user just used.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['keyword'],
            properties: {
                keyword: {
                    type: 'string',
                    description: 'The clue to recall by: a distinctive name, project, file, term, or short phrase from the conversation. ' +
                        'One concrete word works better than a whole sentence.',
                },
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                required: ['found', 'keyword', 'count', 'prompt'],
                properties: {
                    found: { type: 'boolean' },
                    keyword: { type: 'string' },
                    count: { type: 'integer' },
                    prompt: { type: 'string' },
                },
            },
            // 模型看到的只有这段 prompt —— 线索本身不外泄，逼它自己做重建。
            render(_args, value) {
                return [{ type: 'text', text: value.prompt }];
            },
        },
        async execute(args) {
            const raw = args?.keyword;
            const keyword = typeof raw === 'string' ? raw.trim() : '';
            if (keyword === '')
                throw new Error('recall_from_clues requires a non-empty keyword');
            const settings = readSettings();
            const clues = searchClues(connection(settings.dbPath), keyword, settings.limit);
            if (clues.length === 0) {
                return { found: false, keyword, count: 0, prompt: buildEmptyPrompt(keyword) };
            }
            return {
                found: true,
                keyword,
                count: clues.length,
                prompt: buildRecallPrompt(keyword, clues, settings.maxPromptChars),
            };
        },
        presentCall(args) {
            const keyword = args?.keyword;
            return {
                card: 'generic',
                title: `Recall: ${typeof keyword === 'string' ? keyword : ''}`,
                kind: 'search',
            };
        },
    });
    // 钩子始终注册：开关每步从 readSettings() 读，设置页关掉后立即不再遗忘。
    installForgettingHook(ctx, readSettings, connection);
}
