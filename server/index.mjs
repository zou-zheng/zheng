import http from 'node:http';
import path from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
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
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL || 'gpt-5.6-luna';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
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
const insertEvent = db.prepare(`
  INSERT INTO user_events
    (user_id, event_name, page, subject_id, grade, semester, textbook, metadata_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
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

function parseTutorText(text, meta) {
  const clean = String(text || '').trim();
  try {
    const parsed = JSON.parse(clean.replace(/^```json\s*/i, '').replace(/```$/i, '').trim());
    return { ...parsed, isDemo: false, recognizedQuestion: parsed.recognizedQuestion || meta.question, knowledgePoint: parsed.knowledgePoint || parsed.tag || '基础知识点', courseTitle: parsed.courseTitle || parsed.knowledgePoint || parsed.tag || '基础知识点', approaches: parsed.approaches || [], followUpResponse: parsed.followUpResponse || (meta.followUp ? parsed.summary || '' : ''), sources: meta.sources };
  } catch {
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

async function solveWithOpenAI({ question, imageData, grade, subject, textbook, followUp, history = [] }) {
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

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      store: false,
      tools: [{ type: 'web_search' }],
      include: ['web_search_call.action.sources'],
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
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${detail.slice(0, 200)}`);
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
    response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
    return response.end();
  }
  if (request.method === 'GET' && request.url === '/api/health') return sendJson(response, 200, { ok: true, aiConfigured: Boolean(apiKey), model });
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
  if (request.method !== 'POST' || request.url !== '/api/ai/solve') return sendJson(response, 404, { error: 'Not found' });
  try {
    const payload = await readBody(request);
    if (!payload.question?.trim() && !payload.imageData) return sendJson(response, 400, { error: 'question or imageData is required' });
    if (payload.imageData && !/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(payload.imageData)) return sendJson(response, 400, { error: 'imageData must be a base64 image data URL' });
    if (payload.imageData && payload.imageData.length > 12_000_000) return sendJson(response, 413, { error: 'image is too large' });
    if (!apiKey) return sendJson(response, 503, { error: 'OPENAI_API_KEY is not configured' });
    return sendJson(response, 200, await solveWithOpenAI(payload));
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
