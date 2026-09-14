import http from 'node:http';
import path from 'node:path';
import { createReadStream, mkdirSync, readFileSync, statSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

function loadLocalEnv() {
  try {
    const contents = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    contents.split(/\r?\n/).forEach((line) => {
      const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]] !== undefined) return;
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    });
  } catch {
    // .env is optional; the server can still run in demo mode.
  }
}

loadLocalEnv();

const port = Number(process.env.PORT || process.env.AI_PORT || 3001);
const aiProvider = String(process.env.AI_PROVIDER || 'openai').trim().toLowerCase();
const apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
const adminPassword = String(process.env.ADMIN_PASSWORD || '').trim();
const adminSessions = new Map();
const adminSessionLifetimeMs = 12 * 60 * 60 * 1000;
const baseUrl = String(process.env.AI_BASE_URL || (aiProvider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com')).replace(/\/+$/, '');
const model = process.env.AI_MODEL || (aiProvider === 'deepseek' ? 'deepseek-v4-flash' : process.env.OPENAI_MODEL || 'gpt-5.6-luna');
const visionModel = process.env.AI_VISION_MODEL || (aiProvider === 'deepseek' ? 'deepseek-v4-flash-vision-exp' : model);
const responsesUrl = process.env.AI_RESPONSES_URL || `${baseUrl}${aiProvider === 'deepseek' ? '/responses' : '/v1/responses'}`;

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(serverDir, '..', 'dist');
const dataDir = process.env.DATA_DIR || path.join(serverDir, 'data');
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'minghui-learning.sqlite'));
db.exec(`
  CREATE TABLE IF NOT EXISTS user_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    event_name TEXT NOT NULL,
    page TEXT,
    subject_id TEXT,
    grade TEXT,
    semester TEXT,
    textbook TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_user_events_user_time ON user_events(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_user_events_name_time ON user_events(event_name, created_at);
`);
const eventColumns = db.prepare('PRAGMA table_info(user_events)').all().map((column) => column.name);
if (!eventColumns.includes('client_event_id')) db.exec('ALTER TABLE user_events ADD COLUMN client_event_id TEXT');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_user_events_client_event_id ON user_events(client_event_id) WHERE client_event_id IS NOT NULL');
const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO user_events
    (client_event_id, user_id, event_name, page, subject_id, grade, semester, textbook, metadata_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 15_000_000) reject(new Error('request too large'));
    });
    request.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('invalid json')); }
    });
    request.on('error', reject);
  });
}

function serveStatic(request, response) {
  if (request.method !== 'GET') return false;
  try {
    const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
    const requestedPath = decodeURIComponent(url.pathname);
    const relativePath = requestedPath === '/' ? 'index.html' : requestedPath.replace(/^\/+/, '');
    const filePath = path.resolve(distDir, relativePath);
    if (filePath !== distDir && !filePath.startsWith(`${distDir}${path.sep}`)) return false;
    const candidate = statSync(filePath).isFile() ? filePath : path.join(distDir, 'index.html');
    const contentTypes = {
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon',
      '.m4a': 'audio/mp4',
    };
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(candidate).toLowerCase()] || 'application/octet-stream' });
    createReadStream(candidate).pipe(response);
    return true;
  } catch {
    return false;
  }
}

function safeSecretEquals(value, expected) {
  const left = Buffer.from(String(value || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && timingSafeEqual(left, right);
}

function createAdminSession() {
  const token = randomBytes(32).toString('hex');
  adminSessions.set(token, Date.now() + adminSessionLifetimeMs);
  return token;
}

function hasAdminAccess(request) {
  if (!adminPassword) return false;
  const authorization = String(request.headers.authorization || '');
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const expiresAt = adminSessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  adminSessions.set(token, Date.now() + adminSessionLifetimeMs);
  return true;
}

function requireAdmin(request, response) {
  if (!adminPassword) {
    sendJson(response, 503, { error: 'ADMIN_PASSWORD is not configured' });
    return false;
  }
  if (!hasAdminAccess(request)) {
    sendJson(response, 401, { error: 'admin authentication required' });
    return false;
  }
  return true;
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function chinaDateOnly(date = new Date()) {
  return new Date(date.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function shiftDateOnly(dateOnly, amount) {
  const date = new Date(`${dateOnly}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function chinaDateToUtcSql(dateOnly) {
  return new Date(`${dateOnly}T00:00:00+08:00`).toISOString().slice(0, 19).replace('T', ' ');
}

function isDateOnly(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

function analyticsRange(searchParams) {
  const today = chinaDateOnly();
  const requestedDays = Math.min(366, Math.max(1, Number(searchParams.get('days') || 30)));
  const endDate = isDateOnly(searchParams.get('end') || '') ? searchParams.get('end') : today;
  let startDate = isDateOnly(searchParams.get('start') || '') ? searchParams.get('start') : shiftDateOnly(endDate, -(requestedDays - 1));
  if (startDate > endDate) startDate = endDate;
  const dayCount = Math.min(366, Math.max(1, Math.round((new Date(`${endDate}T00:00:00Z`) - new Date(`${startDate}T00:00:00Z`)) / 86400000) + 1));
  return {
    startDate,
    endDate,
    endExclusiveDate: shiftDateOnly(endDate, 1),
    days: dayCount,
    startUtc: chinaDateToUtcSql(startDate),
    endUtc: chinaDateToUtcSql(shiftDateOnly(endDate, 1)),
  };
}

function analyticsFilters(searchParams) {
  const clean = (key, length) => String(searchParams.get(key) || '').trim().slice(0, length);
  return {
    subjectId: clean('subjectId', 40),
    grade: clean('grade', 20),
    semester: clean('semester', 20),
    eventName: clean('eventName', 80),
  };
}

function eventWhere(range, filters = {}, alias = 'e', includeDates = true) {
  const column = (name) => `${alias}.${name}`;
  const clauses = includeDates ? [`${column('created_at')} >= ?`, `${column('created_at')} < ?`] : [];
  const params = includeDates ? [range.startUtc, range.endUtc] : [];
  for (const [key, columnName] of [['subjectId', 'subject_id'], ['grade', 'grade'], ['semester', 'semester'], ['eventName', 'event_name']]) {
    if (filters[key]) {
      clauses.push(`${column(columnName)} = ?`);
      params.push(filters[key]);
    }
  }
  return { where: clauses.length ? clauses.join(' AND ') : '1 = 1', params };
}

function numericRow(row) {
  return Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key, Number(value || 0)]));
}

function percentChange(current, previous) {
  if (!previous) return current ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function adminOverview(searchParams) {
  const range = analyticsRange(searchParams);
  const filters = analyticsFilters(searchParams);
  const current = eventWhere(range, filters);
  const previousRange = {
    ...range,
    startDate: shiftDateOnly(range.startDate, -range.days),
    endDate: shiftDateOnly(range.startDate, -1),
    startUtc: chinaDateToUtcSql(shiftDateOnly(range.startDate, -range.days)),
    endUtc: chinaDateToUtcSql(range.startDate),
  };
  const previous = eventWhere(previousRange, filters);
  const totals = numericRow(db.prepare(`
    SELECT COUNT(*) AS totalEvents,
      COUNT(DISTINCT e.user_id) AS totalUsers,
      COUNT(DISTINCT date(e.created_at, '+8 hours')) AS activeDays,
      ROUND(CAST(COUNT(*) AS REAL) / NULLIF(COUNT(DISTINCT e.user_id), 0), 1) AS avgEventsPerUser
    FROM user_events e WHERE ${current.where}
  `).get(...current.params));
  const previousTotals = numericRow(db.prepare(`
    SELECT COUNT(*) AS totalEvents, COUNT(DISTINCT e.user_id) AS totalUsers,
      COUNT(DISTINCT date(e.created_at, '+8 hours')) AS activeDays
    FROM user_events e WHERE ${previous.where}
  `).get(...previous.params));
  const newUsers = numericRow(db.prepare(`
    SELECT COUNT(*) AS count FROM (
      SELECT user_id, MIN(created_at) AS firstSeen FROM user_events GROUP BY user_id
    ) first_users WHERE firstSeen >= ? AND firstSeen < ?
  `).get(range.startUtc, range.endUtc)).count;
  const returningUsers = Math.max(0, totals.totalUsers - newUsers);
  const eventTypes = db.prepare(`
    SELECT e.event_name AS eventName, COUNT(*) AS count, COUNT(DISTINCT e.user_id) AS users, MAX(e.created_at) AS lastSeen
    FROM user_events e WHERE ${current.where}
    GROUP BY e.event_name ORDER BY count DESC, lastSeen DESC LIMIT 40
  `).all(...current.params).map((item) => ({ ...item, count: Number(item.count || 0), users: Number(item.users || 0) }));
  const subjects = db.prepare(`
    SELECT COALESCE(NULLIF(e.subject_id, ''), '未选择') AS subjectId, COUNT(*) AS count, COUNT(DISTINCT e.user_id) AS users
    FROM user_events e WHERE ${current.where}
    GROUP BY subjectId ORDER BY count DESC
  `).all(...current.params).map((item) => ({ ...item, count: Number(item.count || 0), users: Number(item.users || 0) }));
  const pages = db.prepare(`
    SELECT COALESCE(NULLIF(e.page, ''), '未标记页面') AS page, COUNT(*) AS count
    FROM user_events e WHERE ${current.where}
    GROUP BY page ORDER BY count DESC LIMIT 20
  `).all(...current.params).map((item) => ({ ...item, count: Number(item.count || 0) }));
  const dailyRows = db.prepare(`
    SELECT date(e.created_at, '+8 hours') AS day, COUNT(*) AS count,
      COUNT(DISTINCT e.user_id) AS users,
      SUM(CASE WHEN e.event_name LIKE 'ai_%' THEN 1 ELSE 0 END) AS aiEvents,
      SUM(CASE WHEN e.event_name IN ('submit_answer', 'submit_self_test') THEN 1 ELSE 0 END) AS answerEvents
    FROM user_events e WHERE ${current.where}
    GROUP BY day ORDER BY day ASC
  `).all(...current.params);
  const dailyNewRows = db.prepare(`
    SELECT date(firstSeen, '+8 hours') AS day, COUNT(*) AS newUsers
    FROM (SELECT user_id, MIN(created_at) AS firstSeen FROM user_events GROUP BY user_id)
    WHERE firstSeen >= ? AND firstSeen < ? GROUP BY day
  `).all(range.startUtc, range.endUtc);
  const dailyReturningRows = db.prepare(`
    SELECT date(e.created_at, '+8 hours') AS day, COUNT(DISTINCT e.user_id) AS returningUsers
    FROM user_events e JOIN (SELECT user_id, MIN(created_at) AS firstSeen FROM user_events GROUP BY user_id) first_users
      ON first_users.user_id = e.user_id
    WHERE ${current.where} AND first_users.firstSeen < ? GROUP BY day
  `).all(...current.params, range.startUtc);
  const dailyMap = new Map(dailyRows.map((item) => [item.day, item]));
  const dailyNewMap = new Map(dailyNewRows.map((item) => [item.day, Number(item.newUsers || 0)]));
  const dailyReturningMap = new Map(dailyReturningRows.map((item) => [item.day, Number(item.returningUsers || 0)]));
  const daily = Array.from({ length: range.days }, (_, index) => {
    const day = shiftDateOnly(range.startDate, index);
    const item = dailyMap.get(day) || {};
    return {
      day,
      count: Number(item.count || 0),
      users: Number(item.users || 0),
      aiEvents: Number(item.aiEvents || 0),
      answerEvents: Number(item.answerEvents || 0),
      newUsers: dailyNewMap.get(day) || 0,
      returningUsers: dailyReturningMap.get(day) || 0,
    };
  });
  const hourly = db.prepare(`
    SELECT CAST(strftime('%H', datetime(e.created_at, '+8 hours')) AS INTEGER) AS hour,
      COUNT(*) AS count, COUNT(DISTINCT e.user_id) AS users
    FROM user_events e WHERE ${current.where}
    GROUP BY hour ORDER BY hour ASC
  `).all(...current.params).map((item) => ({ hour: Number(item.hour || 0), count: Number(item.count || 0), users: Number(item.users || 0) }));
  const answerStats = numericRow(db.prepare(`
    SELECT COUNT(*) AS attempts,
      SUM(CASE WHEN json_extract(e.metadata_json, '$.correct') = 1 THEN 1 ELSE 0 END) AS correct
    FROM user_events e WHERE ${current.where}
      AND e.event_name IN ('submit_answer', 'submit_self_test')
  `).get(...current.params));
  answerStats.accuracy = answerStats.attempts ? Math.round(answerStats.correct / answerStats.attempts * 1000) / 10 : 0;
  const recentUsers = db.prepare(`
    SELECT e.user_id AS userId, COUNT(*) AS eventCount, MIN(e.created_at) AS firstSeen,
      MAX(e.created_at) AS lastSeen, MAX(e.grade) AS grade, MAX(e.subject_id) AS lastSubject, MAX(e.page) AS lastPage
    FROM user_events e WHERE ${current.where}
    GROUP BY e.user_id ORDER BY lastSeen DESC LIMIT 100
  `).all(...current.params).map((item) => ({ ...item, eventCount: Number(item.eventCount || 0) }));
  const topUsers = [...recentUsers].sort((left, right) => right.eventCount - left.eventCount || String(right.lastSeen).localeCompare(String(left.lastSeen))).slice(0, 20);
  const recentEvents = db.prepare(`
    SELECT e.id, e.client_event_id AS eventId, e.user_id AS userId, e.event_name AS eventName,
      e.page, e.subject_id AS subjectId, e.grade, e.semester, e.textbook,
      e.metadata_json AS metadata, e.created_at AS createdAt
    FROM user_events e WHERE ${current.where} ORDER BY e.id DESC LIMIT 80
  `).all(...current.params).map((event) => ({
    ...event,
    metadata: (() => { try { return JSON.parse(event.metadata || '{}'); } catch { return {}; } })(),
  }));
  const optionsWhere = eventWhere(range, {}, 'e');
  const optionRows = (column) => db.prepare(`SELECT DISTINCT ${column} AS value FROM user_events e WHERE ${optionsWhere.where} AND ${column} IS NOT NULL AND ${column} <> '' ORDER BY value`).all(...optionsWhere.params).map((item) => item.value);
  return {
    range: { startDate: range.startDate, endDate: range.endDate, days: range.days, timezone: 'Asia/Shanghai' },
    filters,
    totals: { ...totals, newUsers, returningUsers },
    comparison: {
      events: percentChange(totals.totalEvents, previousTotals.totalEvents),
      users: percentChange(totals.totalUsers, previousTotals.totalUsers),
      activeDays: percentChange(totals.activeDays, previousTotals.activeDays),
    },
    answerStats,
    eventTypes,
    subjects,
    pages,
    daily,
    hourly,
    recentUsers,
    topUsers,
    recentEvents,
    options: {
      subjects: optionRows('e.subject_id'),
      grades: optionRows('e.grade'),
      semesters: optionRows('e.semester'),
      eventNames: optionRows('e.event_name'),
    },
  };
}

function parseTutorText(text, meta) {
  const clean = String(text || '').trim();
  const candidates = [];
  const normalized = clean.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  candidates.push(normalized);
  for (let start = 0; start < clean.length; start += 1) {
    if (clean[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < clean.length; index += 1) {
      const character = clean[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}' && --depth === 0) {
        candidates.push(clean.slice(start, index + 1));
        break;
      }
    }
  }
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== 'object' || (!parsed.final && !parsed.steps && !parsed.knowledgePoint)) continue;
      return { ...parsed, isDemo: false, recognizedQuestion: parsed.recognizedQuestion || meta.question, knowledgePoint: parsed.knowledgePoint || parsed.tag || '基础知识点', courseTitle: parsed.courseTitle || parsed.knowledgePoint || parsed.tag || '基础知识点', approaches: parsed.approaches || [], followUpResponse: parsed.followUpResponse || (meta.followUp ? parsed.summary || '' : ''), sources: meta.sources };
    } catch {
      // DeepSeek thinking responses may contain explanatory text around the final JSON.
    }
  }
  return {
    isDemo: false,
    subject: meta.subject || '综合',
    tag: '联网解析',
    final: '请根据下方分步思路作答',
    summary: clean.slice(0, 120),
    steps: [clean],
    approaches: [],
    knowledgePoint: '对应教材基础知识点',
    courseTitle: '基础知识点讲解',
    concept: '建议结合参考来源和对应教材章节再次核对。',
    similar: '',
    recognizedQuestion: meta.question,
    followUpResponse: meta.followUp ? clean.slice(0, 240) : '',
    sources: meta.sources,
  };
}

function extractOutputText(data) {
  if (data.output_text) return data.output_text;
  return (data.output || [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === 'output_text')
    .map((item) => item.text || '')
    .join('\n');
}

async function solveWithProvider({ question, imageData, grade, subject, textbook, followUp, history = [] }) {
  const historyPrompt = history.length
    ? `此前追问记录：${history.slice(-4).map((item) => `${item.role === 'student' ? '学生' : '老师'}：${item.content}`).join(' | ')}`
    : '';
  const userPrompt = [
    `学生年级：${grade || '初中'}`,
    `当前学科：${subject || '综合'}`,
    `教材版本：${textbook || '未指定'}`,
    question ? `题目：${question}` : '题目：请先从附带图片中识别完整题目。',
    historyPrompt,
    followUp ? `学生追问：${followUp}` : '',
  ].filter(Boolean).join('\n');

  const requestBody = {
    model: imageData ? visionModel : model,
    tools: [{ type: 'web_search' }],
    text: { format: { type: 'json_object' } },
    instructions: `你是“铭惠学习”的初中辅导老师。你的目标是帮助学生真正学会，而不是只给最终答案。
学生基础可能较弱，请使用鼓励、低门槛的表达，先补前置知识，再讲当前题目；不要批评分数，也不要一上来拔高难度。不要输出隐藏思维链、内部推理草稿或冗长自言自语，只提供简洁、可验证的分步解法。
如果附带图片，请先识别题目文字；图片中有多道题时，优先解最清晰或学生文字补充指定的那一道。
请根据题目定位到一个具体、可学习的教材知识点，并给出对应的学习点标题。必须提供三种解题思路：第一种适合基础学生，第二种使用公式、定理或图像方法，第三种用于快速验证或迁移；如果某一种不是等价的完整解法，请明确标记为“验证思路”。
请只返回 JSON，不要加 Markdown 代码围栏，字段必须是：
{"recognizedQuestion":"从图片识别出的完整题目","subject":"学科","tag":"题型标签","knowledgePoint":"对应教材中的具体知识点","courseTitle":"对应学习点讲解标题","final":"最终答案","summary":"一句话概括","followUpResponse":"针对学生追问的简短补充解释，没有追问时留空","steps":["步骤1","步骤2"],"approaches":[{"title":"方法一","content":"另一种完整解法","bestFor":"适用场景"},{"title":"方法二","content":"再一种解法或验证方法","bestFor":"适用场景"}],"concept":"关键知识点","similar":"一道简短同类变式题"}
如果题目依赖时效信息、教材外事实或存在不确定性，请联网搜索并在解答中明确说明依据。优先使用权威教育、政府、学校或原始资料来源。`,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: userPrompt },
        ...(imageData ? [{ type: 'input_image', image_url: imageData, detail: 'high' }] : []),
      ],
    }],
  };
  if (aiProvider === 'openai') {
    requestBody.store = false;
    requestBody.include = ['web_search_call.action.sources'];
  }

  const response = await fetch(responsesUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${aiProvider} request failed: ${response.status} ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const sources = (data.output || [])
    .filter((item) => item.type === 'web_search_call')
    .flatMap((item) => item.action?.sources || [])
    .map((source) => ({ title: source.title || source.url, url: source.url }))
    .filter((source, index, list) => source.url && list.findIndex((item) => item.url === source.url) === index);
  return parseTutorText(extractOutputText(data), { subject, sources, question, followUp });
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
    return response.end();
  }
  if (request.method === 'GET' && request.url === '/api/health') return sendJson(response, 200, { ok: true, aiConfigured: Boolean(apiKey), analyticsConfigured: Boolean(adminPassword), provider: aiProvider, model, visionModel });
  if (request.method === 'POST' && request.url === '/api/admin/login') {
    try {
      if (!adminPassword) return sendJson(response, 503, { error: 'ADMIN_PASSWORD is not configured' });
      const payload = await readBody(request);
      if (!safeSecretEquals(payload.password, adminPassword)) return sendJson(response, 401, { error: 'invalid admin password' });
      return sendJson(response, 200, { ok: true, token: createAdminSession(), expiresIn: adminSessionLifetimeMs });
    } catch {
      return sendJson(response, 400, { error: 'invalid login request' });
    }
  }
  if (request.method === 'GET' && request.url.startsWith('/api/admin/overview')) {
    if (!requireAdmin(request, response)) return;
    const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
    return sendJson(response, 200, { ok: true, ...adminOverview(url.searchParams) });
  }
  if (request.method === 'GET' && request.url.startsWith('/api/admin/events')) {
    if (!requireAdmin(request, response)) return;
    const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
    const userId = String(url.searchParams.get('userId') || '').trim().slice(0, 80);
    const filters = analyticsFilters(url.searchParams);
    const range = analyticsRange(url.searchParams);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 100)));
    const eventFilter = eventWhere(range, filters, 'e');
    const where = [eventFilter.where];
    const params = [...eventFilter.params];
    if (userId) {
      where.push('e.user_id = ?');
      params.push(userId);
    }
    params.push(limit);
    const events = db.prepare(`
      SELECT e.id, e.client_event_id AS eventId, e.user_id AS userId, e.event_name AS eventName,
        e.page, e.subject_id AS subjectId, e.grade, e.semester, e.textbook,
        e.metadata_json AS metadata, e.created_at AS createdAt
      FROM user_events
      e WHERE ${where.join(' AND ')}
      ORDER BY e.id DESC
      LIMIT ?
    `).all(...params).map((event) => ({
      ...event,
      metadata: (() => {
        try { return JSON.parse(event.metadata || '{}'); } catch { return {}; }
      })(),
    }));
    return sendJson(response, 200, { ok: true, range, filters, events });
  }
  if (request.method === 'POST' && request.url === '/api/events') {
    try {
      const payload = await readBody(request);
      const userId = String(payload.userId || '').trim();
      const eventName = String(payload.eventName || '').trim();
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(userId)) return sendJson(response, 400, { error: 'invalid userId' });
      if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(eventName)) return sendJson(response, 400, { error: 'invalid eventName' });
      const rawMetadata = payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata) ? payload.metadata : {};
      const metadata = Object.fromEntries(Object.entries(rawMetadata).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 12));
      const result = insertEvent.run(
        String(payload.eventId || '').slice(0, 100) || null,
        userId,
        eventName,
        String(payload.page || '').slice(0, 40) || null,
        String(payload.subjectId || '').slice(0, 40) || null,
        String(payload.grade || '').slice(0, 20) || null,
        String(payload.semester || '').slice(0, 20) || null,
        String(payload.textbook || '').slice(0, 40) || null,
        JSON.stringify(metadata).slice(0, 2000),
      );
      return sendJson(response, 201, { ok: true, eventId: Number(result.lastInsertRowid) });
    } catch (error) {
      console.error('[events]', error.message);
      return sendJson(response, 500, { error: 'event record failed' });
    }
  }
  if (request.method === 'GET' && request.url.startsWith('/api/events/summary')) {
    if (!requireAdmin(request, response)) return;
    const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
    const userId = String(url.searchParams.get('userId') || '').trim();
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(userId)) return sendJson(response, 400, { error: 'valid userId is required' });
    const total = db.prepare('SELECT COUNT(*) AS count FROM user_events WHERE user_id = ?').get(userId);
    const events = db.prepare(`
      SELECT event_name AS eventName, COUNT(*) AS count, MAX(created_at) AS lastSeen
      FROM user_events
      WHERE user_id = ?
      GROUP BY event_name
      ORDER BY count DESC, lastSeen DESC
    `).all(userId);
    return sendJson(response, 200, { ok: true, total: Number(total.count), events });
  }
  if (serveStatic(request, response)) return;
  if (request.method !== 'POST' || request.url !== '/api/ai/solve') return sendJson(response, 404, { error: 'Not found' });
  try {
    const payload = await readBody(request);
    if (!payload.question?.trim() && !payload.imageData) return sendJson(response, 400, { error: 'question or imageData is required' });
    if (payload.imageData && !/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(payload.imageData)) return sendJson(response, 400, { error: 'imageData must be a base64 image data URL' });
    if (payload.imageData && payload.imageData.length > 12_000_000) return sendJson(response, 413, { error: 'image is too large' });
    if (!apiKey) return sendJson(response, 503, { error: 'OPENAI_API_KEY is not configured' });
    return sendJson(response, 200, await solveWithProvider(payload));
  } catch (error) {
    console.error('[ai/solve]', error.message);
    return sendJson(response, 500, { error: 'AI solve failed' });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`AI server listening on port ${port} (configured: ${Boolean(apiKey)})`);
});

function closeDatabase() {
  if (db.isOpen) db.close();
}

process.once('SIGINT', () => { closeDatabase(); process.exit(0); });
process.once('SIGTERM', () => { closeDatabase(); process.exit(0); });
