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
 * 从用户消息里猜发送者的默认正则（取最后一个非空捕获组）。
 * QQ / 微信桥接插件没有统一的 metadata，通常把发送者写在正文前缀里，
 * 所以这里覆盖几种常见写法（含 AstrBot 常见的「昵称: 内容」）；具体部署可在 senderPatterns 里覆盖。
 */
const DEFAULT_SENDER_PATTERNS = [
    '\\[(?:user|uid|qq|sender|from|用户|发送者|成员|群友)\\s*[:：=]\\s*([^\\]\\s]{1,64})\\]',
    '^\\s*\\[(\\d{5,12})\\]',
    '^\\s*([^\\s:：]{1,32})[（(](\\d{5,12})[)）]\\s*[:：]',
    '^\\s*(?:qq|user|uid)\\s*[:=]\\s*(\\d{5,12})\\b',
    // 「昵称: 内容」/「[昵称]: 内容」：要求名字里至少有一个字母或汉字，避免把 12:30、http:// 当成发送者
    '^\\s*\\[?([^\\s:：\\[\\]（）()]*[\\p{L}\\u4e00-\\u9fa5][^\\s:：\\[\\]（）()]{0,31})\\]?\\s*[:：](?!//)\\s*',
];
/** 容易被「昵称:」误判成发送者的常见词。 */
const SENDER_STOPWORDS = new Set([
    '注意', '提示', '警告', '备注', '说明', '系统', '公告', '更新', '时间', 'ps', 'p.s.', 'note', 're',
]);
/**
 * 场景覆盖：键是场景标识（会话 header.agentPreset，缺省时用 origin，最后回落到 default）。
 * 只有写出来的字段才覆盖全局值。
 */
export const SceneSchema = z.object({
    enabled: z.boolean().default(true),
    forgetThresholdTokens: z.natural().min(500).max(200000),
    forgetTurns: z.natural().min(1).max(10),
    keepCompletedTurns: z.natural().min(0).max(50),
    isolateByUser: z.boolean(),
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
    isolateByUser: z.boolean().default(false).volatile(),
    senderPatterns: z.array(z.string()).default([...DEFAULT_SENDER_PATTERNS]).volatile(),
    othersAsGlobal: z.boolean().default(true).volatile(),
    debugSender: z.boolean().default(false).volatile(),
    isolationScope: z.string().default('user').volatile(),
    sceneMap: z.dict(z.string()).default({}).volatile(),
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
 * user_id 为空表示“全群共享记忆”（Phase 3 之前写入的历史都落在这里）。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_clues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT,
  user_id     TEXT,
  scene       TEXT,
  created_at  INTEGER NOT NULL,
  keywords    TEXT NOT NULL,
  seed_tokens TEXT NOT NULL,
  summary     TEXT
);
CREATE INDEX IF NOT EXISTS memory_clues_created_at ON memory_clues (created_at DESC);
`;
const LIKE_ESCAPE = "ESCAPE '\\'";
/**
 * 旧库平滑升级：0.3.x 的库没有 user_id，0.4.x 的库没有 scene。
 * ALTER 前先查 PRAGMA，避免重复执行时报 duplicate column。
 */
function migrate(db) {
    const columns = db.prepare('PRAGMA table_info(memory_clues)').all();
    const has = (name) => columns.some((column) => column.name === name);
    if (!has('user_id'))
        db.exec('ALTER TABLE memory_clues ADD COLUMN user_id TEXT');
    if (!has('scene'))
        db.exec('ALTER TABLE memory_clues ADD COLUMN scene TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS memory_clues_user ON memory_clues (user_id, created_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS memory_clues_scene ON memory_clues (scene, user_id, created_at DESC)');
}
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
        isolateByUser: liveValue(raw.isolateByUser),
        othersAsGlobal: liveValue(raw.othersAsGlobal),
        debugSender: liveValue(raw.debugSender),
        isolationScope: liveValue(raw.isolationScope) === 'user+scene' ? 'user+scene' : 'user',
        sceneMap: liveValue(raw.sceneMap),
        senderPatterns: liveValue(raw.senderPatterns),
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
        isolateByUser: liveValue(config?.isolateByUser) === true,
        senderPatterns: normalizePatterns(liveValue(config?.senderPatterns)),
        othersAsGlobal: liveValue(config?.othersAsGlobal) !== false,
        debugSender: liveValue(config?.debugSender) === true,
        isolationScope: liveValue(config?.isolationScope) === 'user+scene' ? 'user+scene' : 'user',
        sceneMap: normalizeSceneMap(liveValue(config?.sceneMap)),
        sceneOverrides: normalizeScenes(liveValue(config?.sceneOverrides)),
    };
}
/** 只保留能编译的正则，避免一条写错的配置让整个插件崩溃。 */
function normalizePatterns(value) {
    if (Array.isArray(value)) {
        const usable = value
            .filter((item) => typeof item === 'string' && item.trim() !== '')
            .filter((item) => {
            try {
                new RegExp(item, 'i');
                return true;
            }
            catch {
                return false;
            }
        });
        if (usable.length > 0)
            return usable;
    }
    return [...DEFAULT_SENDER_PATTERNS];
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
        if (typeof scene.isolateByUser === 'boolean')
            entry.isolateByUser = scene.isolateByUser;
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
/** 场景映射表：键是正则，值是场景名；写坏的正则直接丢弃。 */
function normalizeSceneMap(value) {
    if (value === null || typeof value !== 'object')
        return {};
    const result = {};
    for (const [pattern, scene] of Object.entries(value)) {
        if (typeof scene !== 'string' || scene.trim() === '')
            continue;
        try {
            new RegExp(pattern, 'i');
        }
        catch {
            continue;
        }
        result[pattern] = scene.trim().toLowerCase();
    }
    return result;
}
/**
 * 当前会话属于哪个场景。
 * DSH 的 SessionHeader 没有独立的渠道字段：外部接入（QQ/微信）通常以自己的 agent 预设建会话。
 * 先看 sceneMap（可匹配 preset / origin / 会话 id / cwd），再退回 agentPreset → origin → default。
 */
export function sceneOf(session, sceneMap = {}) {
    const header = session.header ?? {};
    const candidates = [header.agentPreset, header.origin, session.id, header.cwd].filter((value) => typeof value === 'string' && value.trim() !== '');
    for (const [pattern, scene] of Object.entries(sceneMap)) {
        let regex;
        try {
            regex = new RegExp(pattern, 'i');
        }
        catch {
            continue;
        }
        if (candidates.some((value) => regex.test(value)))
            return scene;
    }
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
        isolateByUser: override.isolateByUser ?? settings.isolateByUser,
    };
}
/** 打开（并按需创建）线索库；PRAGMA 放在这里，所有入口共享同一套设置。 */
function openDb(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 3000');
    db.exec(SCHEMA);
    migrate(db);
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
        .prepare(`INSERT INTO memory_clues (session_id, user_id, scene, created_at, keywords, seed_tokens, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(clue.sessionId ?? null, clue.userId ?? null, clue.scene ?? null, clue.createdAt ?? Date.now(), keywords, seedTokens, clue.summary ?? null);
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
export function searchClues(db, keyword, limit, options = {}) {
    const pattern = `%${escapeLike(keyword)}%`;
    const scope = options.scope ?? 'auto';
    const userId = options.userId;
    const scene = options.scene;
    const hasUser = typeof userId === 'string' && userId !== '';
    const perScene = options.isolationScope === 'user+scene' && hasUser && typeof scene === 'string' && scene !== '';
    const filterParts = [];
    const filterValues = [];
    if (scope === 'global') {
        filterParts.push('user_id IS NULL');
    }
    else if (scope === 'user' && hasUser) {
        filterParts.push(perScene ? '(user_id = ? AND scene = ?)' : 'user_id = ?');
        filterValues.push(userId);
        if (perScene)
            filterValues.push(scene);
    }
    else if (hasUser) {
        filterParts.push(perScene ? '((user_id = ? AND scene = ?) OR user_id IS NULL)' : '(user_id = ? OR user_id IS NULL)');
        filterValues.push(userId);
        if (perScene)
            filterValues.push(scene);
    }
    const filter = filterParts.length > 0 ? ` AND (${filterParts.join(' OR ')})` : '';
    const rows = db
        .prepare(`SELECT id, created_at, keywords, seed_tokens, summary, user_id, scene,
              (CASE WHEN keywords    LIKE ? ${LIKE_ESCAPE} THEN 2 ELSE 0 END
             + CASE WHEN seed_tokens LIKE ? ${LIKE_ESCAPE} THEN 1 ELSE 0 END) AS score
         FROM memory_clues
        WHERE (keywords    LIKE ? ${LIKE_ESCAPE}
            OR seed_tokens LIKE ? ${LIKE_ESCAPE}
            OR summary     LIKE ? ${LIKE_ESCAPE})${filter}
        ORDER BY score DESC, created_at DESC
        LIMIT ?`)
        .all(pattern, pattern, pattern, pattern, pattern, ...filterValues, limit);
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
/**
 * 从消息正文里猜发送者。
 * DSH 的 UserMessage 没有发送者元数据，QQ/微信桥接一般把 `[User: 12345]` 这类前缀写进正文，
 * 所以这里按配置的正则列表逐个匹配，取第一个捕获组；都匹配不上就返回 undefined。
 */
export function extractSenderId(text, patterns = DEFAULT_SENDER_PATTERNS) {
    if (typeof text !== 'string' || text.trim() === '')
        return undefined;
    // 只看开头一段：前缀一定在正文最前面，避免正文里偶然出现的方括号被误判
    const head = text.slice(0, 200);
    for (const source of patterns) {
        let regex;
        try {
            regex = new RegExp(source, 'i');
        }
        catch {
            continue;
        }
        const match = regex.exec(head);
        if (match === null)
            continue;
        // 取最后一个非空捕获组：像「小明(123456):」这种模式，名字在第一组、ID 在第二组
        const groups = match.slice(1).filter((part) => typeof part === 'string' && part.trim() !== '');
        const value = groups[groups.length - 1];
        if (typeof value !== 'string')
            continue;
        const trimmed = value.trim();
        if (SENDER_STOPWORDS.has(trimmed.toLowerCase()))
            continue;
        return trimmed;
    }
    return undefined;
}
/**
 * 按换行拆段并逐行识别发送者。
 * 群聊里用户连发几条、桥接合并成一条 prompt 时，这样才不会把整段都算给第一个人。
 */
export function splitBySender(text, patterns = DEFAULT_SENDER_PATTERNS) {
    if (typeof text !== 'string' || text.trim() === '')
        return [];
    const segments = [];
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === '')
            continue;
        segments.push({ sender: extractSenderId(trimmed, patterns), text: trimmed });
    }
    return segments.length > 0 ? segments : [{ text }];
}
/**
 * 蒸馏前清洗：去掉 CQ 码、行首发送者前缀、行首 @提及，避免它们变成线索词。
 * 只处理开头的匹配，正文里出现的方括号/冒号保持原样。
 */
export function cleanForClues(text, patterns = DEFAULT_SENDER_PATTERNS) {
    if (typeof text !== 'string')
        return '';
    let value = text.replace(/\[CQ:[^\]]*\]/g, ' ').trim();
    for (const source of patterns) {
        let regex;
        try {
            regex = new RegExp(source, 'i');
        }
        catch {
            continue;
        }
        const match = regex.exec(value);
        if (match !== null && match.index === 0) {
            value = value.slice(match[0].length);
            break;
        }
    }
    value = value.replace(/^(?:@\S+\s*)+/u, ' ');
    return value.replace(/[ \t]+/g, ' ').trim();
}
/** 当前会话“最近一条用户消息”的发送者；取不到就是 undefined（走全局模式）。 */
export function senderOfSession(session, patterns) {
    const nodes = session.surface.nodes;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const event = session.eventAt(nodes[index]);
        if (event?.type !== 'user/message')
            continue;
        const message = session.deriveEventMessage?.(event) ?? event.data;
        const segments = splitBySender(messageText(message), patterns);
        // 合并消息里最后一个带前缀的人才是“当前说话的人”
        for (let position = segments.length - 1; position >= 0; position -= 1) {
            const sender = segments[position]?.sender;
            if (sender !== undefined)
                return sender;
        }
        return undefined;
    }
    return undefined;
}
/** pre-step 的 payload.messages 是本步收件箱，优先用它判断“谁在说话”。 */
function senderFromPayload(payload, patterns) {
    const messages = payload?.messages;
    if (!Array.isArray(messages))
        return undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        const segments = splitBySender(messageText(message), patterns);
        for (let position = segments.length - 1; position >= 0; position -= 1) {
            const sender = segments[position]?.sender;
            if (sender !== undefined)
                return sender;
        }
    }
    return undefined;
}
/**
 * 把要折叠的消息按发送者分组。
 *
 * 发送者只能从用户消息的正文前缀里认；assistant / tool 消息归属于它们前面的那位发言者。
 * 没开隔离、或者认不出当前发言者时，全部落进 global 一组——也就是退化回原来的行为。
 */
export function groupTextsBySender(session, seqs, options, currentSender) {
    const groups = new Map();
    const push = (userId, text) => {
        const cleaned = cleanForClues(text, options.senderPatterns);
        if (cleaned === '')
            return;
        const key = userId ?? '';
        let group = groups.get(key);
        if (group === undefined) {
            group = { userId, texts: [] };
            groups.set(key, group);
        }
        group.texts.push(cleaned);
    };
    const isolate = options.isolateByUser && typeof currentSender === 'string' && currentSender !== '';
    let speaker = null;
    const attribute = (text) => {
        if (!isolate) {
            push(null, text);
            return;
        }
        if (speaker !== null && speaker === currentSender) {
            push(speaker, text);
        }
        else if (options.othersAsGlobal) {
            push(null, text);
        }
        // othersAsGlobal=false：别人的对话直接跳过，不留任何痕迹
    };
    for (const seq of seqs) {
        const event = session.eventAt(seq);
        if (event === undefined)
            continue;
        const message = session.deriveEventMessage?.(event) ?? event.data;
        const text = messageText(message);
        if (event.type !== 'user/message') {
            attribute(text);
            continue;
        }
        // 一条消息里可能合并了多个发言人：逐行归属，而不是整条算给第一个人
        for (const segment of splitBySender(text, options.senderPatterns)) {
            if (segment.sender !== undefined)
                speaker = segment.sender;
            attribute(segment.text);
        }
    }
    return [...groups.values()];
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
    // 每个会话各自记“上一次切到第几轮”，不能跨会话共享（QQ 群 + 桌面会互相吞掉折叠）
    const lastCutTurn = new WeakMap();
    ctx.on('agent/pre-step', async (payload, next) => {
        try {
            const settings = readSettings();
            const session = payload?.agent?.session;
            if (session === undefined)
                return await next();
            // 先认场景，再用「全局默认 + 场景覆盖」算出生效值
            const scene = sceneOf(session, settings.sceneMap);
            const effective = resolveScene(settings, scene);
            if (!effective.autoForget)
                return await next();
            if (payload.signal?.aborted === true)
                return await next();
            // 同一轮只切一次，避免一步一刀把当前轮掏空。
            if (payload.turn === lastCutTurn.get(session))
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
            // 群聊隔离：识别当前发言者，再把要折叠的消息按发送者分组
            const currentSender = effective.isolateByUser
                ? senderFromPayload(payload, effective.senderPatterns) ?? senderOfSession(session, effective.senderPatterns)
                : undefined;
            const groups = groupTextsBySender(session, span.shadowedSeqs, effective, currentSender);
            const clues = groups
                .map((group) => ({ userId: group.userId, clue: extractClue(group.texts) }))
                .filter((entry) => entry.clue.seedTokens.length > 0);
            if (clues.length === 0)
                return await next();
            // 先落库：这一步失败就不开 compaction 事务，surface 保持原样。
            const db = connection(settings.dbPath);
            const sessionId = String(payload.agent?.id ?? session.id ?? '');
            for (const entry of clues) {
                storeClue(db, {
                    sessionId,
                    userId: entry.userId,
                    scene,
                    keywords: entry.clue.keywords,
                    seedTokens: entry.clue.seedTokens,
                    summary: entry.clue.summary,
                });
            }
            // 走 DSH 自己的 compaction 词汇：Chat 会把这一段渲染成一行“记忆已折叠”，
            // 模型则只看到被替换进去的那条 checkpoint 消息。
            const compactionId = randomUUID();
            const notice = buildForgetNotice(clues[0]?.clue ?? extractClue([]), span.turns.length);
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
            lastCutTurn.set(session, payload.turn);
            const owners = clues.map((entry) => entry.userId ?? 'global').join(', ');
            ctx.logger?.info?.(`full-life-memory: folded ${span.turns.length} turn(s) (~${tokens} tokens) in scene "${scene}" ` +
                `from surface seq ${span.startSeq}..${span.endSeq} as compaction ${compactionId}; ` +
                `clues: ${clues.map((entry) => entry.clue.keywords.join('/')).join(' | ')}; owners: ${owners}`);
            // 诊断探针：排查「桥接到底把发送者写成什么前缀」时打开 debugSender
            if (effective.debugSender) {
                const probe = senderFromPayload(payload, effective.senderPatterns) ?? senderOfSession(session, effective.senderPatterns);
                ctx.logger?.info?.(`full-life-memory: sender probe scene=${JSON.stringify(scene)} ` +
                    `preset=${JSON.stringify(session.header?.agentPreset ?? null)} ` +
                    `sender=${JSON.stringify(probe ?? null)} scope=${effective.isolationScope} groups=${groups.length} ` +
                    `sample=${JSON.stringify((groups[0]?.texts[0] ?? '').slice(0, 120))}`);
            }
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
            'rather than quoting it as a record. Call once per clue, starting with the most distinctive word the user just used. ' +
            'In a group chat, results are scoped to the current speaker by default; pass scope "global" to search memories shared by the whole group.',
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
                scope: {
                    type: 'string',
                    enum: ['auto', 'user', 'global'],
                    description: 'Whose memory to search. "auto" (default) reads the current speaker plus group-shared clues; ' +
                        '"user" limits to the current speaker; "global" searches only group-shared memories.',
                },
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                required: ['found', 'keyword', 'count', 'prompt', 'scope'],
                properties: {
                    found: { type: 'boolean' },
                    keyword: { type: 'string' },
                    count: { type: 'integer' },
                    prompt: { type: 'string' },
                    scope: { type: 'string' },
                    userId: { type: 'string' },
                },
            },
            // 模型看到的只有这段 prompt —— 线索本身不外泄，逼它自己做重建。
            render(_args, value) {
                return [{ type: 'text', text: value.prompt }];
            },
        },
        async execute(args, exec) {
            const raw = args?.keyword;
            const keyword = typeof raw === 'string' ? raw.trim() : '';
            if (keyword === '')
                throw new Error('recall_from_clues requires a non-empty keyword');
            const rawScope = args?.scope;
            const scope = rawScope === 'user' || rawScope === 'global' ? rawScope : 'auto';
            const settings = readSettings();
            const session = exec?.agent?.session;
            const scene = session !== undefined ? sceneOf(session, settings.sceneMap) : undefined;
            // 找不到会话或识别不出发送者时，userId 为空 → 查询退化为全局（不报错）
            const userId = settings.isolateByUser && session !== undefined
                ? senderOfSession(session, settings.senderPatterns)
                : undefined;
            const clues = searchClues(connection(settings.dbPath), keyword, settings.limit, {
                userId,
                scope,
                scene,
                isolationScope: settings.isolationScope,
            });
            if (clues.length === 0) {
                return { found: false, keyword, count: 0, scope, userId: userId ?? '', prompt: buildEmptyPrompt(keyword) };
            }
            return {
                found: true,
                keyword,
                count: clues.length,
                scope,
                userId: userId ?? '',
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
