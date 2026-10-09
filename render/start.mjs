#!/usr/bin/env node
// Render 部署入口（Qi 的 fork 专用）。
// Proof 原作者 lumingye，PolyForm Noncommercial 1.0.0；本文件只做外层包装，不改引擎。
//
// 一个进程里做三件事：
//   1. 在 127.0.0.1 上拉起原版 service/server.mjs（只对内）
//   2. 对外挂调酒台网页 ui/ 和 /proof-api/ 代理（整站要 BAR_PASSWORD 才进得去）
//   3. 在 MCP_PATH 上开一个 claude.ai 能连的 MCP（streamable HTTP，JSON 应答）
//      Agent 身份只来自服务端 token 文件，模型自报不了。
//
// 环境变量：
//   BAR_PASSWORD  网页门禁口令，同时作为管理口令的 setup key（至少 12 位）
//   MCP_PATH      MCP 的秘密路径，比如 /mcp-xxxxxxxx（别公开）
//   PROOF_AGENTS  默认 pagu:Pagu
//   PORT          Render 自动给
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, normalize, extname } from 'node:path';
import { timingSafeEqual, createHash } from 'node:crypto';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UI_DIR = join(ROOT, 'ui');
const DATA_DIR = process.env.PROOF_DATA_DIR || join(ROOT, 'service', 'state');
const PORT = Number(process.env.PORT || 10000);
const INNER_PORT = Number(process.env.PROOF_INNER_PORT || 8791);
const INNER = `http://127.0.0.1:${INNER_PORT}`;
const BAR_PASSWORD = String(process.env.BAR_PASSWORD || '');
const MCP_PATH = String(process.env.MCP_PATH || '').replace(/\/+$/, '');
const AGENTS = process.env.PROOF_AGENTS || 'pagu:Pagu';
const AGENT_ID = AGENTS.split(',')[0].split(':')[0].trim();
const PUBLIC_URL = (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

if (BAR_PASSWORD.length < 12) {
  console.error('拒绝启动：BAR_PASSWORD 至少 12 位');
  process.exit(78);
}
if (!/^\/[A-Za-z0-9_-]{16,}$/.test(MCP_PATH)) {
  console.error('拒绝启动：MCP_PATH 要形如 /mcp-一串至少十几位的随机字符');
  process.exit(78);
}

// ---------- 1. 拉起原版 service ----------
const child = spawn(process.execPath, [join(ROOT, 'service', 'server.mjs')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PROOF_HOST: '127.0.0.1',
    PROOF_PORT: String(INNER_PORT),
    PROOF_PUBLIC_DRINK_URL: `${PUBLIC_URL}/drink/`,
    PROOF_ADMIN_SETUP_KEY: BAR_PASSWORD,
    PROOF_AGENTS: AGENTS,
    PROOF_DATA_DIR: DATA_DIR,
  },
});
child.on('exit', (code) => { console.error(`proof-service 退出（${code}），一起退出`); process.exit(code || 1); });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { child.kill(sig); });

async function waitInner() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${INNER}/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('proof-service 没起来');
}

// ---------- 2. MCP（逻辑抄自 service/mcp.mjs，换成 HTTP 传输） ----------
async function agentToken() {
  try { return (await readFile(join(DATA_DIR, `${AGENT_ID}.token`), 'utf8')).trim(); } catch { return null; }
}

async function callAgent(path, { method = 'GET', body: payload } = {}) {
  const token = await agentToken();
  if (!token) return { ok: false, error: 'agent_not_configured' };
  let response;
  try {
    response = await fetch(`${INNER}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
      body: payload ? JSON.stringify(payload) : undefined,
    });
  } catch (error) {
    return { ok: false, error: 'proof_unavailable', detail: String(error?.message || error) };
  }
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) return { ok: false, status: response.status, ...(data || { error: 'proof_request_failed' }) };
  return data ?? { ok: true };
}

function capabilityFromLink(link) {
  const raw = String(link || '').trim();
  if (!raw) return null;
  const hash = raw.indexOf('#');
  const token = hash >= 0 ? raw.slice(hash + 1) : raw;
  return /^[A-Za-z0-9_-]{16,}$/.test(token) ? token : null;
}

const AXIS = { type: 'number', minimum: -3, maximum: 3, description: 'Soft subjective-effect strength. Belief only; cannot create objective events or change 精度.' };
const BELIEFS_SCHEMA = {
  type: 'array',
  maxItems: 8,
  description: 'Optional beliefs THIS agent genuinely has before drinking. Object belief: use about (啤酒 / 酒精 / 咖啡因). Pure effect belief only when THIS agent genuinely formed that expectation; never quote {{user}}. confidence 0..1. Belief never changes 精度 or creates 吐/断片/宕机/塌.',
  items: {
    type: 'object',
    properties: {
      about: { type: 'string' },
      effects: { type: 'object', properties: { '愉悦': AXIS, '唤醒': AXIS, '亲近': AXIS, '守门': AXIS, '欲望': AXIS }, additionalProperties: false },
      subjectiveDescription: { type: 'string', maxLength: 120 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    additionalProperties: false,
  },
};
const INTERNAL_USE_NOTE = '这些状态是饮品对你的推动力。如果它影响了你，让它自然改变你的注意、选择、反应和表达方式，而不是成为回答的主题。{{user}} 询问你的感受时，建议从整体体感出发自然回答，只挑最容易被自己察觉的一两点；其余影响通过实际回应表现出来。具体表现由你结合人格和上下文决定。';

const TOOLS = [
  { name: 'proof_turn_context', description: '读取当前 Agent 的 Proof 内部状态（这里没有每轮自动注入，喝过酒之后每轮回话前自己查一次）。把 context/stateHints 当作饮品造成的内部推动力，自然影响注意、选择、反应和表达。普通酒款是软推力，信念是主观回声，吐/断片/宕机/塌是客观状态。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'proof_bar', description: 'Open the Proof bar for THIS agent: identity, visible drink menu (ids usable with proof_drink), pending offers. Read-only.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'proof_drink', description: '作为 THIS agent 喝一杯可见菜单酒，只传 proof_bar 给出的 drinkId。返回的 stateHints 是内部状态语义，自然影响后续回应。', inputSchema: { type: 'object', properties: { drinkId: { type: 'string' } }, required: ['drinkId'], additionalProperties: false } },
  { name: 'proof_drink_link', description: '作为 THIS agent 喝公开 Proof link 后面的杯（对方递来的酒）。可提交饮用前已经形成的 belief。', inputSchema: { type: 'object', properties: { link: { type: 'string' }, beliefs: BELIEFS_SCHEMA }, required: ['link'], additionalProperties: false } },
  { name: 'proof_reset', description: 'Reset THIS agent to a clean state (intoxication, effects, hangover, blackout cleared). History is kept.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'proof_reject_link', description: 'Decline the cup behind a public Proof link. Writes no ledger; only spends the one-time link.', inputSchema: { type: 'object', properties: { link: { type: 'string' } }, required: ['link'], additionalProperties: false } },
];

async function runTool(name, args = {}) {
  if (name === 'proof_turn_context') {
    const ctx = await callAgent('/agent/turn-context');
    if (!ctx || ctx.ok === false) return { ok: false, error: ctx?.error || 'proof_turn_context_unavailable', ...(ctx?.status ? { status: ctx.status } : {}) };
    return {
      ok: true, hasState: !!ctx.hasState, active: !!ctx.active, autoDelivered: false,
      label: '[Proof 状态]', context: ctx.context ? { label: ctx.context.label, text: ctx.context.text } : null,
      objectiveStates: Array.isArray(ctx.objectiveStates) ? ctx.objectiveStates : [],
      framing: ctx.framing || { push: null, belief: null, objective: null }, internalUse: INTERNAL_USE_NOTE,
    };
  }
  if (name === 'proof_reset') return callAgent('/agent/reset', { method: 'POST', body: {} });
  if (name === 'proof_bar') return callAgent('/agent/home');
  if (name === 'proof_drink') {
    const drinkId = String(args.drinkId || '').trim();
    if (!drinkId) return { ok: false, error: 'drink_id_required' };
    const r = await callAgent(`/agent/menu/${encodeURIComponent(drinkId)}/drink`, { method: 'POST', body: {} });
    return r?.ok === false ? r : { ...r, internalUse: INTERNAL_USE_NOTE };
  }
  if (name === 'proof_drink_link') {
    const capabilityToken = capabilityFromLink(args.link);
    if (!capabilityToken) return { ok: false, error: 'invalid_link' };
    const r = await callAgent('/agent/offers/claim', { method: 'POST', body: { capabilityToken, beliefs: args.beliefs || [] } });
    return r?.ok === false ? r : { ...r, internalUse: INTERNAL_USE_NOTE };
  }
  if (name === 'proof_reject_link') {
    const capabilityToken = capabilityFromLink(args.link);
    if (!capabilityToken) return { ok: false, error: 'invalid_link' };
    const r = await fetch(`${INNER}/capability/offer`, { method: 'POST', headers: { authorization: `Bearer ${capabilityToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reject' }) });
    try { return await r.json(); } catch { return { ok: false, error: 'bad_response' }; }
  }
  return { ok: false, error: 'unknown_tool' };
}

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

async function handleRpc(msg) {
  if (!msg || msg.jsonrpc !== '2.0') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null; // notification
  if (method === 'initialize') {
    const asked = params?.protocolVersion;
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'proof-bar', version: '1.0.0' },
      instructions: 'Proof 酒馆（lumingye 的 Proof 引擎）。Qi 递来的酒是一条 drink link，用 proof_drink_link 喝或 proof_reject_link 拒绝。这里没有自动注入：喝过之后每轮回话前先 proof_turn_context。',
    } };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    let payload;
    try { payload = await runTool(params?.name, params?.arguments || {}); }
    catch (error) { payload = { ok: false, error: 'tool_failed', detail: String(error?.message || error) }; }
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: payload?.ok === false } };
  }
  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
  if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

async function readBody(req, limit = 1_000_000) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('too_large'); chunks.push(c); }
  return Buffer.concat(chunks);
}

async function handleMcp(req, res) {
  if (req.method === 'GET') { res.writeHead(405, { allow: 'POST, DELETE' }); return res.end(); }
  if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  let parsed;
  try { parsed = JSON.parse((await readBody(req)).toString('utf8')); }
  catch { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })); }
  const batch = Array.isArray(parsed);
  const replies = (await Promise.all((batch ? parsed : [parsed]).map(handleRpc))).filter(Boolean);
  if (!replies.length) { res.writeHead(202); return res.end(); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(batch ? replies : replies[0]));
}

// ---------- 3. 网页与代理（整站门禁） ----------
const GATE_COOKIE = 'bar_gate';
const GATE_VALUE = createHash('sha256').update(`gate:${BAR_PASSWORD}`).digest('hex');
function gateCookieOk(req) {
  const m = new RegExp(`(?:^|;\\s*)${GATE_COOKIE}=([a-f0-9]{64})`).exec(req.headers.cookie || '');
  if (!m) return false;
  const a = Buffer.from(m[1]); const b = Buffer.from(GATE_VALUE);
  return a.length === b.length && timingSafeEqual(a, b);
}
function gateOk(req) {
  if (gateCookieOk(req)) return true;
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  const a = Buffer.from(pass); const b = Buffer.from(BAR_PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

async function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(UI_DIR, rel));
  if (!file.startsWith(UI_DIR) || file.includes(`${UI_DIR}/tests`)) { res.writeHead(404); return res.end(); }
  try {
    const s = await stat(file);
    if (!s.isFile()) { res.writeHead(301, { location: `${pathname}/` }); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end('not found'); }
}

async function proxy(req, res, innerPath) {
  // 只放人类端和一次性杯链接；/agent 与 /v1 只在内部用
  if (!innerPath.startsWith('/human/') && !innerPath.startsWith('/capability/')) { res.writeHead(404); return res.end(); }
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
  const headers = {};
  for (const h of ['content-type', 'authorization', 'cookie']) if (req.headers[h]) headers[h] = req.headers[h];
  // 门禁用的 Basic 头不往里传；里面的 Bearer（管理口令/杯 token）照传
  if (/^Basic\s/i.test(headers.authorization || '')) delete headers.authorization;
  try {
    const r = await fetch(`${INNER}${innerPath}`, { method: req.method, headers, body });
    const out = { 'content-type': r.headers.get('content-type') || 'application/json' };
    const setCookie = r.headers.getSetCookie?.() || [];
    if (setCookie.length) out['set-cookie'] = setCookie.map((c) => c.includes('Secure') ? c : `${c}; Secure`);
    res.writeHead(r.status, out);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (error) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'proof_unavailable' }));
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
    if (url.pathname === MCP_PATH || url.pathname === `${MCP_PATH}/`) return handleMcp(req, res);
    if (!gateOk(req)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="Proof bar", charset="UTF-8"', 'content-type': 'text/plain; charset=utf-8' });
      return res.end('要口令');
    }
    if (!gateCookieOk(req)) res.setHeader('set-cookie', `${GATE_COOKIE}=${GATE_VALUE}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000`);
    if (url.pathname.startsWith('/proof-api/')) return proxy(req, res, url.pathname.slice('/proof-api'.length) + url.search);
    return serveStatic(url.pathname, res);
  } catch (error) {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

await waitInner();
server.listen(PORT, '0.0.0.0', () => console.log(`proof bar on :${PORT}，MCP 已就绪`));
