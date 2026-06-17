/**
 * Claude-Weixin-Bot
 * ================
 * Minimal bridge between Claude API and WeChat ClawBot via the iLink Bot protocol.
 * Zero OpenClaw dependency — pure HTTP/JSON + Anthropic SDK.
 *
 * Usage: set LLM_API_KEY in .env, then npm start
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Zero-dependency .env loader (runs before everything)
try {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch { /* ignore */ }

import OpenAI from "openai";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com";
const ILINK_APP_ID = "bot";
const CHANNEL_VERSION = "1.0.0";
const DEFAULT_BOT_AGENT = "ClaudeWeixinBot/1.0";
const BOT_TYPE = "3";

const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const GETUPDATES_LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const CONFIG_TIMEOUT_MS = 10_000;
const MAX_QR_REFRESH = 3;

const SESSION_EXPIRED_ERRCODE = -14;
const SESSION_PAUSE_MS = 60 * 60 * 1000; // 1 hour

const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

/** Max characters per WeChat text message before splitting. */
const MAX_TEXT_CHUNK = 4000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.resolve(process.env.STATE_DIR ?? path.join(__dirname, "..", "state"));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BaseInfo {
  channel_version: string;
  bot_agent: string;
}

interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  run_id?: string;
}

interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  image_item?: Record<string, unknown>;
  voice_item?: { text?: string; encode_type?: number; playtime?: number };
  file_item?: { file_name?: string };
  video_item?: Record<string, unknown>;
  ref_msg?: { message_item?: MessageItem; title?: string };
}

interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

interface QRCodeResp {
  qrcode: string;
  qrcode_img_content: string;
}

interface QRStatusResp {
  status: "wait" | "scaned" | "confirmed" | "expired" | "need_verifycode" | "verify_code_blocked" | "binded_redirect" | "scaned_but_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

interface AccountData {
  botToken: string;
  baseUrl: string;
  accountId: string;
  userId?: string;
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function ensureStateDir(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function loadJsonFile<T>(filename: string): T | null {
  try {
    const p = path.join(STATE_DIR, filename);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
}

function saveJsonFile(filename: string, data: unknown): void {
  ensureStateDir();
  fs.writeFileSync(path.join(STATE_DIR, filename), JSON.stringify(data, null, 2), "utf-8");
}

function loadAccount(): AccountData | null {
  // Cloud mode: load from env var (one-line JSON, no newlines)
  const envJson = process.env.ACCOUNT_JSON;
  if (envJson) {
    try { return JSON.parse(envJson) as AccountData; } catch { /* fall through */ }
  }
  return loadJsonFile("account.json");
}

function saveAccount(acc: AccountData): void {
  saveJsonFile("account.json", acc);
}

function loadSyncBuf(): string {
  const envBuf = process.env.SYNC_BUF;
  if (envBuf) return envBuf;
  const data = loadJsonFile<{ buf: string }>("sync-buf.json");
  return data?.buf ?? "";
}

function saveSyncBuf(buf: string): void {
  if (buf) saveJsonFile("sync-buf.json", { buf });
}

function loadContextTokens(): Record<string, string> {
  return loadJsonFile("context-tokens.json") ?? {};
}

function saveContextTokens(tokens: Record<string, string>): void {
  saveJsonFile("context-tokens.json", tokens);
}

const contextTokenCache: Record<string, string> = loadContextTokens();

function setContextToken(userId: string, token: string): void {
  contextTokenCache[userId] = token;
  saveContextTokens(contextTokenCache);
}

function getContextToken(userId: string): string | undefined {
  return contextTokenCache[userId];
}

// ---------------------------------------------------------------------------
// iLink HTTP helpers
// ---------------------------------------------------------------------------

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildClientVersion(version: string): number {
  const [major, minor, patch] = version.split(".").map(Number);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

const ILINK_APP_CLIENT_VERSION = buildClientVersion(CHANNEL_VERSION);

function buildBaseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION, bot_agent: DEFAULT_BOT_AGENT };
}

function buildHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

async function apiGet(params: {
  baseUrl: string;
  endpoint: string;
  timeoutMs?: number;
  label: string;
}): Promise<string> {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl));
  const hdrs = buildHeaders();
  const timeout = params.timeoutMs;
  const controller = timeout != null && timeout > 0 ? new AbortController() : undefined;
  const t = controller ? setTimeout(() => controller!.abort(), timeout) : undefined;
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: hdrs,
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (t) clearTimeout(t);
    const text = await res.text();
    if (!res.ok) throw new Error(`${params.label} ${res.status}: ${text}`);
    return text;
  } catch (err) {
    if (t) clearTimeout(t);
    throw err;
  }
}

async function apiPost(params: {
  baseUrl: string;
  endpoint: string;
  body: unknown;
  token?: string;
  timeoutMs?: number;
  label: string;
}): Promise<string> {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl));
  const hdrs = buildHeaders(params.token);
  const timeout = params.timeoutMs;
  const controller = timeout != null && timeout > 0 ? new AbortController() : undefined;
  const t = controller ? setTimeout(() => controller!.abort(), timeout) : undefined;
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify(params.body),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (t) clearTimeout(t);
    const text = await res.text();
    if (!res.ok) throw new Error(`${params.label} ${res.status}: ${text}`);
    return text;
  } catch (err) {
    if (t) clearTimeout(t);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// QR Login
// ---------------------------------------------------------------------------

async function fetchQrCode(): Promise<QRCodeResp> {
  const raw = await apiPost({
    baseUrl: FIXED_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
    body: { local_token_list: [] },
    label: "fetchQR",
  });
  return JSON.parse(raw);
}

async function pollQrStatus(qrcode: string, verifyCode?: string): Promise<QRStatusResp> {
  try {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) {
      endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    }
    const raw = await apiGet({
      baseUrl: FIXED_BASE_URL,
      endpoint,
      timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
      label: "pollQR",
    });
    return JSON.parse(raw);
  } catch (err) {
    // Timeout is normal — server holds 35s, then we retry
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    log(`⚠️  pollQR network error: ${String(err)}, retrying...`);
    return { status: "wait" };
  }
}

function log(msg: string): void {
  const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  process.stdout.write(`[${ts}] ${msg}\n`);
}

async function readLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise<string>((resolve) => {
    let input = "";
    const onData = (chunk: Buffer | string) => {
      input += chunk.toString();
      if (input.includes("\n")) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(input.trim());
      }
    };
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", onData);
  });
}

async function displayQr(url: string): Promise<void> {
  try {
    const qrterm = await import("qrcode-terminal");
    qrterm.default.generate(url, { small: true });
  } catch {
    log(`⚠️  无法显示二维码，请访问: ${url}`);
  }
  log(`\n备用链接: ${url}\n`);
}

async function doLogin(): Promise<AccountData> {
  log("🔑 正在获取登录二维码...");
  const qrResp = await fetchQrCode();
  log("📱 请用手机微信扫描以下二维码：\n");
  await displayQr(qrResp.qrcode_img_content);
  log("⏳ 等待扫码...\n");

  let qrcode = qrResp.qrcode;
  let refreshCount = 1;
  let scannedShown = false;
  let pendingVerifyCode: string | undefined;

  while (true) {
    const status = await pollQrStatus(qrcode, pendingVerifyCode);

    switch (status.status) {
      case "wait":
        break;

      case "scaned":
        // If we had a pending verify code and got "scaned", code was correct
        if (pendingVerifyCode) {
          pendingVerifyCode = undefined;
          log("✅ 验证码正确，继续...");
        }
        if (!scannedShown) {
          log("✅ 已扫描，正在确认...");
          scannedShown = true;
        }
        break;

      case "need_verifycode": {
        const prompt = pendingVerifyCode
          ? "❌ 验证码不正确，请重新输入："
          : "🔢 请输入手机微信显示的配对数字：";
        pendingVerifyCode = await readLine(prompt);
        // Continue loop immediately — pendingVerifyCode will be sent in next poll
        continue;
      }

      case "expired":
        pendingVerifyCode = undefined;
        refreshCount++;
        if (refreshCount > MAX_QR_REFRESH) {
          throw new Error("二维码多次过期，请重新运行。");
        }
        log(`⏳ 二维码已过期 (${refreshCount}/${MAX_QR_REFRESH})，正在刷新...`);
        const newQr = await fetchQrCode();
        qrcode = newQr.qrcode;
        scannedShown = false;
        await displayQr(newQr.qrcode_img_content);
        log("🔄 请重新扫描新二维码。");
        break;

      case "verify_code_blocked":
        pendingVerifyCode = undefined;
        refreshCount++;
        if (refreshCount > MAX_QR_REFRESH) {
          throw new Error("多次输入错误，请重新运行。");
        }
        log("⛔ 多次输入错误，正在刷新二维码...");
        const blockedQr = await fetchQrCode();
        qrcode = blockedQr.qrcode;
        scannedShown = false;
        await displayQr(blockedQr.qrcode_img_content);
        log("🔄 请重新扫描新二维码。");
        break;

      case "binded_redirect":
        log("✅ 此机器人已连接过，无需重复登录。");
        throw new Error("ALREADY_CONNECTED");

      case "scaned_but_redirect":
        log("📍 正在路由到就近服务器...");
        break;

      case "confirmed": {
        if (!status.ilink_bot_id) {
          throw new Error("登录失败：服务器未返回 ilink_bot_id");
        }
        const account: AccountData = {
          botToken: status.bot_token ?? "",
          baseUrl: status.baseurl ?? FIXED_BASE_URL,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id,
        };
        saveAccount(account);
        log(`✅ 登录成功！Bot ID: ${account.accountId}`);
        return account;
      }
    }

    await sleep(1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// iLink Bot API
// ---------------------------------------------------------------------------

async function getUpdates(params: {
  baseUrl: string;
  token: string;
  buf: string;
  timeoutMs: number;
}): Promise<GetUpdatesResp> {
  try {
    const raw = await apiPost({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: {
        get_updates_buf: params.buf,
        base_info: buildBaseInfo(),
      },
      token: params.token,
      timeoutMs: params.timeoutMs,
      label: "getUpdates",
    });
    return JSON.parse(raw);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      // Long-poll timeout is normal — return empty
      return { ret: 0, msgs: [], get_updates_buf: params.buf };
    }
    throw err;
  }
}

async function sendMessage(params: {
  baseUrl: string;
  token: string;
  toUserId: string;
  text: string;
  contextToken?: string;
}): Promise<void> {
  const { baseUrl, token, toUserId, text, contextToken } = params;
  const clientId = crypto.randomUUID();
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: clientId,
      message_type: 2, // BOT
      message_state: 2, // FINISH
      item_list: [{ type: 1, text_item: { text } }],
      context_token: contextToken ?? undefined,
    },
    base_info: buildBaseInfo(),
  };

  await apiPost({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body,
    token,
    timeoutMs: API_TIMEOUT_MS,
    label: "sendMessage",
  });
}

async function sendTyping(params: {
  baseUrl: string;
  token: string;
  ilinkUserId: string;
  typingTicket: string;
  status: number; // 1=typing, 2=cancel
}): Promise<void> {
  await apiPost({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: {
      ilink_user_id: params.ilinkUserId,
      typing_ticket: params.typingTicket,
      status: params.status,
      base_info: buildBaseInfo(),
    },
    token: params.token,
    timeoutMs: CONFIG_TIMEOUT_MS,
    label: "sendTyping",
  });
}

async function getConfig(params: {
  baseUrl: string;
  token: string;
  ilinkUserId: string;
  contextToken?: string;
}): Promise<{ typing_ticket?: string }> {
  try {
    const raw = await apiPost({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getconfig",
      body: {
        ilink_user_id: params.ilinkUserId,
        context_token: params.contextToken,
        base_info: buildBaseInfo(),
      },
      token: params.token,
      timeoutMs: CONFIG_TIMEOUT_MS,
      label: "getConfig",
    });
    const resp = JSON.parse(raw);
    return { typing_ticket: resp.typing_ticket };
  } catch {
    // getConfig failure is non-fatal
    return {};
  }
}

async function notifyStart(params: { baseUrl: string; token: string }): Promise<void> {
  try {
    await apiPost({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/msg/notifystart",
      body: { base_info: buildBaseInfo() },
      token: params.token,
      timeoutMs: CONFIG_TIMEOUT_MS,
      label: "notifyStart",
    });
  } catch (err) {
    log(`⚠️  notifyStart 失败（可忽略）: ${String(err)}`);
  }
}

async function notifyStop(params: { baseUrl: string; token: string }): Promise<void> {
  try {
    await apiPost({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/msg/notifystop",
      body: { base_info: buildBaseInfo() },
      token: params.token,
      timeoutMs: CONFIG_TIMEOUT_MS,
      label: "notifyStop",
    });
  } catch {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// Message text extraction
// ---------------------------------------------------------------------------

function extractText(msg: WeixinMessage): string {
  const items = msg.item_list ?? [];
  for (const item of items) {
    if (item.type === 1 && item.text_item?.text) {
      let text = item.text_item.text;

      // Handle quoted messages
      if (item.ref_msg) {
        const ref = item.ref_msg;
        const parts: string[] = [];
        if (ref.title) parts.push(ref.title);
        if (ref.message_item?.text_item?.text) parts.push(ref.message_item.text_item.text);
        if (parts.length) {
          text = `[引用: ${parts.join(" | ")}]\n${text}`;
        }
      }
      return text;
    }
    // Voice with transcription
    if (item.type === 3 && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

function getMediaType(msg: WeixinMessage): string | undefined {
  const items = msg.item_list ?? [];
  for (const item of items) {
    if (item.type === 2) return "image";
    if (item.type === 3) return "voice";
    if (item.type === 4) return "file";
    if (item.type === 5) return "video";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Claude integration
// ---------------------------------------------------------------------------

const CLAUDE_MODEL = process.env.LLM_MODEL || "deepseek-chat";
const LLM_BASE_URL = process.env.LLM_BASE_URL || "https://api.deepseek.com/v1";
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || "你是一个微信 AI 助手。请用简洁、友好的中文回复。回答要有条理，避免冗长。";

// Per-user conversation history (max 100 users, LRU eviction)
type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string };
const conversations = new Map<string, ChatMessage[]>();
const MAX_CONVERSATION_PAIRS = 20; // 20 round-trips = 40 messages
const MAX_USERS = 100;

function getConversation(userId: string): ChatMessage[] {
  let convo = conversations.get(userId);
  if (!convo) {
    if (conversations.size >= MAX_USERS) {
      const oldest = conversations.keys().next().value;
      if (oldest) conversations.delete(oldest);
    }
    convo = [];
    conversations.set(userId, convo);
  }
  return convo;
}

function trimConversation(convo: ChatMessage[]): void {
  const maxMsgs = MAX_CONVERSATION_PAIRS * 2;
  if (convo.length > maxMsgs) {
    convo.splice(0, convo.length - maxMsgs);
  }
}

// ---------------------------------------------------------------------------
// Web Search (DuckDuckGo — free, no API key)
// ---------------------------------------------------------------------------

interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

/** Heuristic: does this message likely need a web search? */
function shouldSearch(text: string): string | null {
  const t = text.trim();
  // Explicit commands
  if (/^(搜索|搜一下|查一下|帮我搜|网上查)/.test(t)) {
    return t.replace(/^(搜索|搜一下|查一下|帮我搜|网上查)[：:]*\s*/, "");
  }
  // Time-sensitive / factual keywords
  const triggers = [
    "今天", "现在", "最近", "最新", "刚刚", "当前", "实时",
    "新闻", "天气", "股价", "汇率", "热搜", "发生了",
    "什么时候", "多少钱", "价格", "对比", "区别",
    "realtime", "today", "news", "latest",
  ];
  if (triggers.some(kw => t.includes(kw))) {
    return t;
  }
  return null;
}

async function performSearch(query: string): Promise<SearchResult[]> {
  const log = (msg: string) => process.stdout.write(`[search] ${msg}\n`);
  try {
    // DuckDuckGo Instant Answer API
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await resp.json() as Record<string, unknown>;

    const results: SearchResult[] = [];

    // Abstract (instant answer)
    const abstract = (data.AbstractText as string)?.trim();
    if (abstract) {
      results.push({ title: data.Heading as string || query, snippet: abstract, url: (data.AbstractURL as string) || "" });
    }

    // Related topics
    const topics = data.RelatedTopics as Array<{ Text?: string; FirstURL?: string }> | undefined;
    if (topics) {
      for (const t of topics) {
        if (t.Text && results.length < 8) {
          results.push({ title: "", snippet: t.Text, url: t.FirstURL || "" });
        }
      }
    }

    if (results.length > 0) {
      log(`DuckDuckGo: ${results.length} results for "${query}"`);
      return results;
    }
  } catch (err) {
    log(`DuckDuckGo failed: ${String(err)}, trying Lite...`);
  }

  // Fallback: DuckDuckGo Lite HTML scrape
  try {
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    const html = await resp.text();

    const results: SearchResult[] = [];
    // Parse Lite results: <a rel="nofollow" href="...">title</a><span>snippet</span>
    const linkRe = /<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>\s*<span[^>]*>([^<]*)<\/span>/g;
    let m;
    while ((m = linkRe.exec(html)) !== null && results.length < 6) {
      results.push({ title: m[2].trim(), snippet: m[3].trim(), url: m[1] });
    }

    // Also try: <a rel="nofollow" href="...">title</a><br>snippet<br>
    if (results.length === 0) {
      const altRe = /<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a><br>([^<]+)/gi;
      let m2;
      while ((m2 = altRe.exec(html)) !== null && results.length < 6) {
        results.push({ title: m2[2].trim(), snippet: m2[3].trim(), url: m2[1] });
      }
    }

    log(`DuckDuckGo Lite: ${results.length} results for "${query}"`);
    return results;
  } catch (err) {
    log(`DuckDuckGo Lite failed: ${String(err)}`);
  }

  return [];
}

function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return `未找到与 "${query}" 相关的结果。`;
  return results.map((r, i) => {
    const title = r.title ? `**${r.title}**\n` : "";
    return `[${i + 1}] ${title}${r.snippet}\n   ${r.url ? `🔗 ${r.url}` : ""}`;
  }).join("\n\n");
}

// ---------------------------------------------------------------------------
// LLM call — search-before-answer strategy
// ---------------------------------------------------------------------------

/**
 * Before calling the LLM, check if the message likely needs web search.
 * If yes, search first, then prepend the results to the system prompt.
 * This works with ANY model — no function calling needed.
 */

const SEARCH_PROMPT_HINT = `\n\n[重要：你已接入联网搜索。下方搜索结果来自互联网，请综合这些信息回答。如果搜索结果不足或不相关，直接基于你的知识回答。]`;

async function callLLM(
  userId: string,
  userMessage: string,
  account: AccountData,
): Promise<string[]> {
  const client = new OpenAI({
    apiKey: process.env.LLM_API_KEY,
    baseURL: LLM_BASE_URL,
  });
  const convo = getConversation(userId);

  // "typing..." indicator
  const config = await getConfig({
    baseUrl: account.baseUrl,
    token: account.botToken,
    ilinkUserId: userId,
    contextToken: getContextToken(userId),
  });
  if (config.typing_ticket) {
    sendTyping({ baseUrl: account.baseUrl, token: account.botToken, ilinkUserId: userId, typingTicket: config.typing_ticket, status: 1 }).catch(() => {});
  }

  // --- Decide whether to search first ---
  let searchContext = "";
  const searchQuery = shouldSearch(userMessage);
  if (searchQuery) {
    log(`🔍 搜索: ${searchQuery}`);
    const results = await performSearch(searchQuery);
    if (results.length > 0) {
      searchContext = `\n\n【以下是从互联网搜索到的实时信息，请参考：】\n${formatSearchResults(searchQuery, results)}\n【搜索信息结束】\n`;
    }
  }

  // --- Build messages ---
  const systemMsg = SYSTEM_PROMPT + (searchContext ? SEARCH_PROMPT_HINT : "");
  const enhancedUserMessage = searchContext
    ? `${userMessage}\n\n${searchContext}`
    : userMessage;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemMsg },
    ...convo.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user", content: enhancedUserMessage },
  ];

  let replyText = "";

  try {
    const stream = await client.chat.completions.create({
      model: CLAUDE_MODEL,
      messages,
      max_tokens: 4096,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) replyText += delta;
    }

    // Stop typing
    if (config.typing_ticket) {
      sendTyping({ baseUrl: account.baseUrl, token: account.botToken, ilinkUserId: userId, typingTicket: config.typing_ticket, status: 2 }).catch(() => {});
    }

    // Store conversation (original message, not the search-augmented one)
    convo.push({ role: "user", content: userMessage });
    convo.push({ role: "assistant", content: replyText });
    trimConversation(convo);

    return splitText(replyText);

  } catch (err) {
    if (config.typing_ticket) {
      sendTyping({ baseUrl: account.baseUrl, token: account.botToken, ilinkUserId: userId, typingTicket: config.typing_ticket, status: 2 }).catch(() => {});
    }
    throw err;
  }
}

/** Split text into WeChat-friendly chunks (<= 4000 chars each, at sentence boundaries). */
function splitText(text: string): string[] {
  if (!text) return [""];
  if (text.length <= MAX_TEXT_CHUNK) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > MAX_TEXT_CHUNK) {
    // Try to break at sentence boundary
    let splitAt = remaining.lastIndexOf("\n", MAX_TEXT_CHUNK);
    if (splitAt === -1 || splitAt < MAX_TEXT_CHUNK * 0.5) {
      splitAt = remaining.lastIndexOf("。", MAX_TEXT_CHUNK);
    }
    if (splitAt === -1 || splitAt < MAX_TEXT_CHUNK * 0.5) {
      splitAt = remaining.lastIndexOf("，", MAX_TEXT_CHUNK);
    }
    if (splitAt === -1 || splitAt < MAX_TEXT_CHUNK * 0.5) {
      splitAt = remaining.lastIndexOf(" ", MAX_TEXT_CHUNK);
    }
    if (splitAt === -1 || splitAt < 100) {
      splitAt = MAX_TEXT_CHUNK;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

// ---------------------------------------------------------------------------
// Monitor loop
// ---------------------------------------------------------------------------

let sessionPausedUntil = 0;

function pauseSession(): void {
  sessionPausedUntil = Date.now() + SESSION_PAUSE_MS;
  log(`⏸️  Session 过期，暂停 ${SESSION_PAUSE_MS / 60_000} 分钟...`);
}

function isSessionPaused(): boolean {
  if (sessionPausedUntil === 0) return false;
  if (Date.now() >= sessionPausedUntil) {
    sessionPausedUntil = 0;
    log("▶️  Session 暂停结束，恢复运行。");
    return false;
  }
  return true;
}

async function runMonitor(account: AccountData): Promise<void> {
  log(`🚀 启动监控循环 (baseUrl=${account.baseUrl})`);

  // Notify server we're starting
  await notifyStart({ baseUrl: account.baseUrl, token: account.botToken });

  let buf = loadSyncBuf();
  if (buf) {
    log(`📦 从上次位置恢复 (buf ${buf.length} bytes)`);
  }

  let consecutiveFailures = 0;
  let pollTimeout = GETUPDATES_LONG_POLL_TIMEOUT_MS;

  // Keep running — user Ctrl+C to stop
  while (true) {
    // Check session pause
    if (isSessionPaused()) {
      await sleep(30_000);
      continue;
    }

    try {
      const resp = await getUpdates({
        baseUrl: account.baseUrl,
        token: account.botToken,
        buf,
        timeoutMs: pollTimeout,
      });

      // Update poll timeout from server hint
      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        pollTimeout = resp.longpolling_timeout_ms;
      }

      // Check for API errors
      const isError = (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isError) {
        if (resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE) {
          pauseSession();
          consecutiveFailures = 0;
          continue;
        }

        consecutiveFailures++;
        log(`❌ getUpdates 错误: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          log(`⚠️  连续 ${MAX_CONSECUTIVE_FAILURES} 次失败，退避 30s...`);
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS);
        } else {
          await sleep(RETRY_DELAY_MS);
        }
        continue;
      }

      consecutiveFailures = 0;

      // Save sync buf
      if (resp.get_updates_buf) {
        buf = resp.get_updates_buf;
        saveSyncBuf(buf);
      }

      // Process messages
      const msgs = resp.msgs ?? [];
      for (const msg of msgs) {
        const fromUser = msg.from_user_id ?? "";
        const text = extractText(msg);
        const mediaType = getMediaType(msg);
        const contextToken = msg.context_token;

        if (contextToken && fromUser) {
          setContextToken(fromUser, contextToken);
        }

        if (!text && !mediaType) continue; // Empty message

        log(`📩 收到消息 from=${fromUser}: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`);
        if (mediaType) log(`   📎 附件类型: ${mediaType}`);

        // Build prompt with media awareness
        let prompt = text;
        if (mediaType && !text) {
          prompt = `[用户发送了一个${mediaType === "image" ? "图片" : mediaType === "voice" ? "语音" : mediaType === "file" ? "文件" : "视频"}，但我无法直接查看其内容]`;
        } else if (mediaType && text) {
          prompt = `[用户发送了一段消息并附带了一个${mediaType === "image" ? "图片" : mediaType === "voice" ? "语音" : mediaType === "file" ? "文件" : "视频"}]\n${text}`;
        }

        // Call Claude and reply
        try {
          const chunks = await callLLM(fromUser, prompt, account);
          for (const chunk of chunks) {
            await sendMessage({
              baseUrl: account.baseUrl,
              token: account.botToken,
              toUserId: fromUser,
              text: chunk,
              contextToken: getContextToken(fromUser),
            });
            log(`📤 回复 to=${fromUser}: ${chunk.slice(0, 80)}${chunk.length > 80 ? "..." : ""}`);
            // Small delay between chunks
            if (chunks.length > 1) await sleep(500);
          }
        } catch (err) {
          log(`❌ Claude 调用失败: ${String(err)}`);
          try {
            await sendMessage({
              baseUrl: account.baseUrl,
              token: account.botToken,
              toUserId: fromUser,
              text: "抱歉，我暂时无法处理你的消息。请稍后再试。",
              contextToken: getContextToken(fromUser),
            });
          } catch {
            // If even error message fails, give up
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        // Normal during shutdown
        continue;
      }
      consecutiveFailures++;
      log(`❌ getUpdates 异常 (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)}`);

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        log(`⚠️  连续 ${MAX_CONSECUTIVE_FAILURES} 次异常，退避 30s...`);
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS);
      } else {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log("🤖 Claude-Weixin-Bot v1.0.0");
  log("━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Check API key
  if (!process.env.LLM_API_KEY) {
    log("❌ 请在 .env 中设置 LLM_API_KEY");
    log("   LLM_API_KEY=sk-...");
    log("   LLM_BASE_URL=https://api.deepseek.com/v1");
    log("   LLM_MODEL=deepseek-chat");
    process.exit(1);
  }

  log(`🤖 模型: ${CLAUDE_MODEL}`);
  log(`🔗 API: ${LLM_BASE_URL}`);
  log(`💾 状态目录: ${STATE_DIR}`);

  // Load or create account
  let account = loadAccount();

  if (account) {
    log(`✅ 已有登录信息: ${account.accountId}`);
    log(`   如果要重新登录，请删除 ${STATE_DIR}/account.json 后重新运行`);
    log("");
  } else {
    log("🔐 首次使用，需要扫码登录微信 ClawBot\n");
    try {
      account = await doLogin();
    } catch (err) {
      if (err instanceof Error && err.message === "ALREADY_CONNECTED") {
        log("⚠️  该机器人已连接过，但本地没有找到凭证。请确认后重试。");
        process.exit(1);
      }
      log(`❌ 登录失败: ${String(err)}`);
      process.exit(1);
    }
  }

  log("");
  log("━━━━━━━━━━━━━━━━━━━━━━━━━");
  log("📡 开始监听微信消息...");
  log("   按 Ctrl+C 停止");
  log("");

  // Handle graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("\n🛑 正在退出...");
    if (account) {
      await notifyStop({ baseUrl: account.baseUrl, token: account.botToken });
    }
    log("👋 再见！");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start tiny health-check HTTP server (cloud platforms need a port)
  const PORT = parseInt(process.env.PORT ?? "8080", 10);
  const healthServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK\n");
  });
  healthServer.listen(PORT, () => {
    log(`💓 健康检查端口: ${PORT}`);
  });

  // Start the monitor (this runs forever until SIGINT)
  if (!account) {
    log("❌ 未登录，无法启动监听。");
    process.exit(1);
  }
  await runMonitor(account);
}

main().catch((err) => {
  log(`❌ 致命错误: ${String(err)}`);
  process.exit(1);
});
