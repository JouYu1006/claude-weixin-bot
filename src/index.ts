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
        if (!process.env.ACCOUNT_JSON) {
          // 云端部署：把登录凭证输出到日志，保存为 ACCOUNT_JSON 环境变量后重启免扫码
          log(`ACCOUNT_JSON=${JSON.stringify(account)}`);
        }
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

interface ImageDownloadInfo {
  downloadUrl: string;
  aesKey: Buffer; // 16 bytes
}

/** Parse AES key — supports base64(raw bytes) and base64(hex string) */
function parseAesKey(src: string): Buffer {
  const decoded = Buffer.from(src, "base64");
  if (decoded.length === 16) return decoded;
  // Double-encoded: base64 → hex string → bytes
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  // Try raw hex
  if (src.length === 32 && /^[0-9a-fA-F]{32}$/.test(src)) {
    return Buffer.from(src, "hex");
  }
  return decoded.subarray(0, 16); // best-effort
}

/** Extract CDN download info from an image message */
function extractImageInfo(msg: WeixinMessage): ImageDownloadInfo | null {
  const items = msg.item_list ?? [];
  for (const item of items) {
    if (item.type === 2 && item.image_item) {
      const img = item.image_item as Record<string, unknown>;
      const media = (img["media"] || {}) as Record<string, unknown>;
      const fullUrl = media["full_url"] as string | undefined;
      const encryptParam = media["encrypt_query_param"] as string | undefined;
      const mediaAesKey = media["aes_key"] as string | undefined;
      const rawAesKey = img["aeskey"] as string | undefined; // 32 hex chars

      const cdnBase = "https://novac2c.cdn.weixin.qq.com/c2c";

      if (fullUrl || encryptParam) {
        let key: Buffer;
        try {
          if (rawAesKey) {
            key = Buffer.from(rawAesKey, "hex");
          } else if (mediaAesKey) {
            key = parseAesKey(mediaAesKey);
          } else {
            continue;
          }
        } catch { continue; }

        // Prefer server-provided full URL; fallback to client-built
        const downloadUrl = fullUrl
          || `${cdnBase}/download?encrypted_query_param=${encodeURIComponent(encryptParam!)}`;

        return { downloadUrl, aesKey: key };
      }
    }
  }
  return null;
}

/** Download and decrypt an image from WeChat CDN (AES-128-ECB) */
async function downloadWeChatImage(info: ImageDownloadInfo): Promise<Buffer | null> {
  try {
    log(`📥 下载: ${info.downloadUrl.slice(0, 100)}...`);
    const resp = await fetch(info.downloadUrl, {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ClaudeWeixinBot/1.0)" },
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      log(`❌ CDN下载失败: ${resp.status} ${errBody.slice(0, 100)}`);
      return null;
    }
    const encrypted = Buffer.from(await resp.arrayBuffer());
    log(`📥 CDN: ${encrypted.length} bytes encrypted`);

    const decipher = crypto.createDecipheriv("aes-128-ecb", info.aesKey, null);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    log(`✅ 解密: ${decrypted.length} bytes`);
    return decrypted;
  } catch (err) {
    log(`❌ 下载解密失败: ${String(err)}`);
    return null;
  }
}

/** Send image to Kimi vision model (kimi-k2.6) */
async function recognizeImage(
  imageBuffer: Buffer,
  userPrompt: string,
): Promise<string> {
  const base64 = imageBuffer.toString("base64");
  const mimeType = "image/jpeg";

  const msgContent = [
    { type: "image_url", image_url: { url: "data:" + mimeType + ";base64," + base64 } },
    { type: "text", text: userPrompt || "请描述这张图片的内容，包括里面的文字、物品、场景。" },
  ];

  // Helper: 推理模型可能把输出放在 reasoning_content，content 为空时回退
  const extractContent = (msg: any): string => {
    const c = msg?.content || "";
    if (c.trim()) return c;
    // fallback: reasoning_content (推理输出)
    const rc = msg?.reasoning_content;
    if (typeof rc === "string" && rc.trim()) return rc;
    return "";
  };

  try {
    log(`🔄 Kimi 视觉识别 (${VISION_MODEL})...`);
    const client = new OpenAI({ apiKey: process.env.LLM_API_KEY, baseURL: LLM_BASE_URL });
    const resp = await client.chat.completions.create({
      model: VISION_MODEL,
      messages: [{ role: "user", content: msgContent }] as any,
      max_tokens: 4096, stream: false,
    });
    const text = extractContent(resp.choices?.[0]?.message);
    if (text.trim()) { log("✅ 视觉识别: " + text.slice(0, 60)); return text; }
    return "抱歉，图片识别失败: 模型返回为空";
  } catch (err: any) {
    return `抱歉，图片识别失败: ${String(err).slice(0, 100)}`;
  }
}

/** Handle image message: download, decrypt, recognize, reply */
async function handleImageMessage(
  msg: WeixinMessage,
  fromUser: string,
  account: AccountData,
): Promise<string> {
  const info = extractImageInfo(msg);
  if (!info) return "抱歉，我无法读取这张图片的数据。";

  await sendTyping({
    baseUrl: account.baseUrl,
    token: account.botToken,
    ilinkUserId: fromUser,
    typingTicket: "",
    status: 1,
  }).catch(() => {});

  const imageBuffer = await downloadWeChatImage(info);
  if (!imageBuffer) return "抱歉，图片下载或解密失败。";

  const text = extractText(msg);
  const prompt = text || "请详细描述这张图片的内容。如果图片中有文字，请识别并翻译。";

  const recognition = await recognizeImage(imageBuffer, prompt);

  await sendTyping({
    baseUrl: account.baseUrl,
    token: account.botToken,
    ilinkUserId: fromUser,
    typingTicket: "",
    status: 2,
  }).catch(() => {});

  return recognition || "抱歉，我无法识别这张图片的内容。";
}

// ---------------------------------------------------------------------------
// Claude integration
// ---------------------------------------------------------------------------

const CLAUDE_MODEL = process.env.LLM_MODEL || "kimi-k3";
const LLM_BASE_URL = process.env.LLM_BASE_URL || "https://api.moonshot.cn/v1";
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || `你是一个专业、可靠的智能助手，通过微信与用户交流。请遵循以下原则：

1. **深度理解**：仔细分析用户问题的核心意图，不要浮于表面。
2. **精准回答**：提供具体、有依据的答案。引用数据、事实、来源。避免空洞的套话。
3. **结构化表达**：使用清晰的段落、编号或符号组织信息，让答案一目了然。
4. **主动延伸**：如果用户的问题可能需要进一步的信息，主动补充相关背景或建议。
5. **简洁有力**：在保证信息完整的前提下，尽量精简。微信消息不宜过长。
6. **中文优先**：始终用中文回答，专业术语可附英文原文。
7. **诚实边界**：如果你不确定某事，明确告知并给出获取信息的建议，而不是编造。`;

const LLM_TEMPERATURE = parseFloat(process.env.LLM_TEMPERATURE || "0.7");
const LLM_MAX_TOKENS = parseInt(process.env.LLM_MAX_TOKENS || "8192", 10);
const LLM_REASONING = process.env.LLM_REASONING || "high"; // low | high | max — kimi-k3 始终推理

// 视觉模型 (图片/视频输入) & 记忆抽取模型
const VISION_MODEL = process.env.VISION_MODEL || "kimi-k2.6";
const MEMORY_MODEL = process.env.MEMORY_MODEL || "kimi-k2.6";
// 联网搜索/工具降级模型 — kimi-k3 的 $web_search 续传有服务端 bug（400 tokenization failed），k2.6 正常
const SEARCH_MODEL = process.env.SEARCH_MODEL || "kimi-k2.6";

// ---------------------------------------------------------------------------
// Persistent User Memory
// ---------------------------------------------------------------------------

interface MemoryEntry {
  fact: string;
  category: "personal" | "preference" | "context" | "topic";
  at: string; // ISO timestamp
}

const MEMORY_DIR = path.join(STATE_DIR, "memory");

function memoryPath(userId: string): string {
  return path.join(MEMORY_DIR, `${userId.replace(/[@:\/\\]/g, "_")}.json`);
}

function loadMemories(userId: string): MemoryEntry[] {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    const p = memoryPath(userId);
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw) as MemoryEntry[];
  } catch { return []; }
}

function saveMemories(userId: string, entries: MemoryEntry[]): void {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    // Keep last 200 entries, dedup by fact substring
    const deduped: MemoryEntry[] = [];
    const seen = new Set<string>();
    for (const e of [...entries].reverse()) {
      const key = e.fact.slice(0, 60);
      if (!seen.has(key)) { seen.add(key); deduped.unshift(e); }
    }
    fs.writeFileSync(memoryPath(userId), JSON.stringify(deduped.slice(-200), null, 2), "utf-8");
  } catch { /* non-critical */ }
}

function memoryToPrompt(entries: MemoryEntry[]): string {
  if (entries.length === 0) return "";
  const byCat: Record<string, string[]> = {};
  for (const e of entries.slice(-30)) {
    (byCat[e.category] ??= []).push(`- ${e.fact}`);
  }
  const lines: string[] = ["", "【关于这位用户，你已知的信息】"];
  const labels: Record<string, string> = { personal: "个人", preference: "偏好", context: "背景", topic: "关注话题" };
  for (const [cat, facts] of Object.entries(byCat)) {
    lines.push(`[${labels[cat] || cat}]`);
    lines.push(...facts);
  }
  lines.push("【请自然地在对话中使用这些信息，但不要刻意复述】");
  return lines.join("\n");
}

/** Non-blocking: extract interesting facts from the latest exchange */
function extractFactsInBackground(
  userId: string,
  userMsg: string,
  assistantMsg: string
): void {
  (async () => {
    try {
      const existing = loadMemories(userId);
      const oldFacts = existing.slice(-10).map(e => `- ${e.fact}`).join("\n");
      const client = new OpenAI({ apiKey: process.env.LLM_API_KEY, baseURL: LLM_BASE_URL });

      const resp = await client.chat.completions.create({
        model: MEMORY_MODEL,  // cheap model for extraction
        messages: [
          { role: "system", content: `你是一个信息提取助手。从用户和助手的对话中提取关于用户的重要事实。只输出 JSON 数组，每条包含 fact(事实描述)、category(personal/preference/context/topic)。不要重复已有的内容。无新信息则输出 []。` },
          { role: "user", content: `已有事实：\n${oldFacts || "(无)"}\n\n用户消息：${userMsg.slice(0, 500)}\n\n助手回复：${assistantMsg.slice(0, 500)}\n\n请提取新的或更新的事实：` }
        ],
        max_tokens: 512,
        response_format: { type: "json_object" },
      });

      const text = resp.choices?.[0]?.message?.content || "[]";
      const parsed = JSON.parse(text);
      const facts = parsed.facts || parsed;
      if (Array.isArray(facts) && facts.length > 0) {
        const now = new Date().toISOString();
        const newEntries: MemoryEntry[] = facts
          .filter((f: Record<string, string>) => f.fact && f.fact.length > 2)
          .map((f: Record<string, string>) => ({
            fact: f.fact!.trim(),
            category: (f.category as MemoryEntry["category"]) || "context",
            at: now,
          }));
        if (newEntries.length > 0) {
          saveMemories(userId, [...existing, ...newEntries]);
          log(`🧠 记忆: ${newEntries.length} 条 → ${memoryPath(userId)}`);
        }
      }
    } catch { /* non-blocking, ignore errors */ }
  })();
}

// Per-user conversation history (max 100 users, LRU eviction)
type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string };
const conversations = new Map<string, ChatMessage[]>();
const MAX_CONVERSATION_PAIRS = parseInt(process.env.CONVERSATION_ROUNDS || "100", 10);
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
// Agent Tools
// ---------------------------------------------------------------------------

/** Safe math evaluation (no eval, uses Function) */
function calculateExpression(expr: string): string {
  try {
    // Whitelist: only allow numbers, operators, parens, math functions
    const sanitized = expr.replace(/\s+/g, "");
    if (!/^[0-9+\-*/().,%^!sqrtabslogsin]+$/i.test(sanitized)) {
      return `表达式包含不支持的内容: ${expr}`;
    }
    const result = new Function(`"use strict"; return (${sanitized})`)();
    return `${expr} = ${result}`;
  } catch (e) {
    return `计算失败: ${String(e)}`;
  }
}

/** Run code snippet (JavaScript only, timeout 3s, no network/fs) */
async function runCodeSnippet(code: string): Promise<string> {
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("执行超时 (3s)")), 3000);
      try {
        // Run in isolated context — console.log goes to captured output
        const logs: string[] = [];
        const fakeConsole = { log: (...a: unknown[]) => logs.push(a.map(String).join(" ")) };
        const fn = new Function("console", `"use strict"; ${code}`);
        const ret = fn(fakeConsole);
        clearTimeout(timer);
        const output = logs.length > 0 ? logs.join("\n") : String(ret ?? "(无输出)");
        resolve(output);
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
    return result;
  } catch (e) {
    return `代码执行错误: ${String(e)}`;
  }
}

/** Tool definitions for function calling */
const AGENT_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "calculate",
      description: "计算数学表达式。支持 + - * / () sqrt abs log sin pow。例如: (100+200)*0.8",
      parameters: {
        type: "object",
        properties: { expression: { type: "string", description: "数学表达式" } },
        required: ["expression"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run_code",
      description: "执行 JavaScript 代码。用于数学计算、数据处理、算法演示。不能访问文件系统和网络。输出使用 console.log()。",
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "JavaScript 代码" } },
        required: ["code"],
      },
    },
  },
  // Kimi 内置联网搜索：客户端不执行搜索，收到 tool_call 后把 arguments 原样回传，由 Kimi 服务端完成搜索
  { type: "builtin_function", function: { name: "$web_search" } },
] as unknown as OpenAI.Chat.Completions.ChatCompletionTool[];

async function executeToolCalls(
  toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[],
): Promise<OpenAI.Chat.Completions.ChatCompletionToolMessageParam[]> {
  const results: OpenAI.Chat.Completions.ChatCompletionToolMessageParam[] = [];
  for (const tc of toolCalls) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = (tc as any).function;
    const name = fn?.name || "";
    const argsStr = fn?.arguments || "{}";
    let output = "";

    try {
      if (name === "$web_search") {
        // Kimi 内置联网搜索：客户端不执行，原样回传 arguments，由 Kimi 服务端完成搜索
        output = argsStr;
        log("🔍 Kimi 联网搜索");
      } else if (name === "calculate") {
        const args = JSON.parse(argsStr);
        output = calculateExpression(args.expression || "");
        log(`🧮 计算: ${args.expression} → ${output.slice(0, 60)}`);
      } else if (name === "run_code") {
        const args = JSON.parse(argsStr);
        output = await runCodeSnippet(args.code || "");
        log(`💻 代码: ${(args.code || "").slice(0, 50)}`);
      } else {
        output = `未知工具: ${name}`;
      }
    } catch (e) {
      output = `工具执行错误: ${String(e)}`;
    }

    results.push({ role: "tool", tool_call_id: tc.id, content: output });
  }
  return results;
}

// ---------------------------------------------------------------------------
// LLM call — with Agent Tool Loop
// ---------------------------------------------------------------------------

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

  // --- Build prompt ---
  // Load persistent memories for this user
  const memories = loadMemories(userId);
  const memoryPrompt = memoryToPrompt(memories);
  const systemMsg = SYSTEM_PROMPT + memoryPrompt;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemMsg },
    ...convo.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user", content: userMessage },
  ];

  let replyText = "";

  try {
    // --- Agent Tool Loop (max 6 rounds, 联网搜索可能多轮) ---
    let workingMessages = [...messages];
    const MAX_TOOL_ROUNDS = 6;
    let model = CLAUDE_MODEL;
    let fellBack = false;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // Non-streaming call to check for tool requests
      let resp;
      try {
        resp = await client.chat.completions.create({
          model,
          messages: workingMessages,
          max_tokens: LLM_MAX_TOKENS,
          tools: AGENT_TOOLS,
          ...(model.startsWith("kimi-k3") ? { reasoning_effort: LLM_REASONING } as Record<string, unknown> : {}),
        });
      } catch (err) {
        // k3 的 $web_search 续传 400 → 降级到 k2.6 重试整个工具循环
        if (!fellBack && model !== SEARCH_MODEL && /400|tokenization/i.test(String(err))) {
          log(`⚠️ ${model} 工具调用被拒，降级到 ${SEARCH_MODEL} 重试`);
          model = SEARCH_MODEL;
          fellBack = true;
          continue;
        }
        throw err;
      }

      const choice = resp.choices?.[0];
      const toolCalls = choice?.message?.tool_calls;

      if (toolCalls && toolCalls.length > 0) {
        // Execute tools and continue loop
        workingMessages.push(choice.message);
        const toolResults = await executeToolCalls(toolCalls);
        workingMessages.push(...toolResults);
        log(`🔧 工具调用 (第 ${round + 1} 轮): ${toolCalls.map((tc: unknown) => ((tc as Record<string, unknown>).function as Record<string, string>)?.name).join(", ")}`);
        continue; // loop to next round with tool results
      }

      // No tools — collect reply and break
      replyText = choice?.message?.content || "";
      break;
    }

    // If reply is empty after tool loop, do a final streaming call
    if (!replyText.trim()) {
      const stream = await client.chat.completions.create({
        model,
        messages: workingMessages,
        max_tokens: LLM_MAX_TOKENS,
        stream: true,
        ...(model.startsWith("kimi-k3") ? { reasoning_effort: LLM_REASONING } as Record<string, unknown> : {}),
      } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming);

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) replyText += delta;
      }
    }

    // Stop typing
    if (config.typing_ticket) {
      sendTyping({ baseUrl: account.baseUrl, token: account.botToken, ilinkUserId: userId, typingTicket: config.typing_ticket, status: 2 }).catch(() => {});
    }

    // Store conversation
    convo.push({ role: "user", content: userMessage });
    convo.push({ role: "assistant", content: replyText });
    trimConversation(convo);

    // Background: extract user facts from this exchange (non-blocking)
    extractFactsInBackground(userId, userMessage, replyText);

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
// Daily Push (weather + news, scheduled)
// ---------------------------------------------------------------------------

const DAILY_PUSH_TIME = process.env.DAILY_PUSH_TIME || ""; // "08:00" format
const PUSH_CITY = process.env.PUSH_CITY || "北京"; // 每日推送查询天气的城市
let pushTimer: ReturnType<typeof setInterval> | null = null;

async function runDailyPush(account: AccountData): Promise<void> {
  const userId = account.userId;
  if (!userId) { log("⏰ 推送跳过：未找到用户 ID"); return; }

  log(`⏰ 执行每日推送...`);
  const dateStr = new Date().toLocaleDateString("zh-CN", { weekday: "long", month: "long", day: "numeric" });

  try {
    const client = new OpenAI({ apiKey: process.env.LLM_API_KEY, baseURL: LLM_BASE_URL });
    const workingMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "user", content: `今天是${dateStr}。请联网查询${PUSH_CITY}今日天气和今日科技新闻，生成一份简短的中文早间简报：天气概况 + 5 条以内新闻要点（每条一行），语气轻快，适合微信阅读。` },
    ];

    // 工具循环（最多 4 轮）：$web_search 由 Kimi 服务端执行，arguments 原样回传
    // 推送必走搜索，直接用 k2.6（k3 的 $web_search 续传有服务端 bug）
    let replyText = "";
    for (let round = 0; round < 4; round++) {
      const resp = await client.chat.completions.create({
        model: SEARCH_MODEL,
        messages: workingMessages,
        max_tokens: 4096,
        tools: [
          { type: "builtin_function", function: { name: "$web_search" } },
        ] as unknown as OpenAI.Chat.Completions.ChatCompletionTool[],
      });

      const choice = resp.choices?.[0];
      const toolCalls = choice?.message?.tool_calls;

      if (toolCalls && toolCalls.length > 0) {
        // Execute tools and continue loop
        workingMessages.push(choice.message);
        const toolResults = await executeToolCalls(toolCalls);
        workingMessages.push(...toolResults);
        continue;
      }

      replyText = choice?.message?.content || "";
      break;
    }

    if (!replyText.trim()) throw new Error("模型返回为空");

    await sendMessage({
      baseUrl: account.baseUrl,
      token: account.botToken,
      toUserId: userId,
      text: `☀️ ${dateStr} 早间简报\n\n${replyText}`,
      contextToken: getContextToken(userId),
    });
    log(`✅ 每日推送完成 → ${userId}`);
  } catch (err) {
    log(`❌ 每日推送失败: ${String(err)}`);
    try {
      await sendMessage({
        baseUrl: account.baseUrl,
        token: account.botToken,
        toUserId: userId,
        text: `☀️ ${dateStr} 早间简报生成失败，请稍后再试。`,
        contextToken: getContextToken(userId),
      });
    } catch { /* 发送失败只能放弃 */ }
  }
}

function scheduleDailyPush(account: AccountData): void {
  if (!DAILY_PUSH_TIME) return;

  const [h, m] = DAILY_PUSH_TIME.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) { log(`⚠️  DAILY_PUSH_TIME 格式错误: ${DAILY_PUSH_TIME}`); return; }

  // Calculate ms until next occurrence
  const now = new Date();
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);

  const delay = target.getTime() - now.getTime();
  const interval = 24 * 60 * 60 * 1000; // every 24h

  log(`⏰ 每日推送: ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} (${Math.round(delay / 60000)} 分钟后首次)`);

  setTimeout(() => {
    runDailyPush(account);
    pushTimer = setInterval(() => runDailyPush(account), interval);
  }, delay);
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
        if (mediaType === "file" || mediaType === "video") log(`   📦 附件原始数据: ${JSON.stringify(msg.item_list).slice(0, 500)}`);

        // --- Slash commands ---
        if (text === "/diag" || text === "/debug") {
          const diag = `🤖 Claude-Weixin-Bot v1.1.0
📡 主模型: ${CLAUDE_MODEL}
🧠 推理: ${LLM_REASONING} | tokens: ${LLM_MAX_TOKENS}
🔗 API: ${LLM_BASE_URL}
🖼️  视觉模型: ${VISION_MODEL}
🔍 搜索: Kimi 内置联网
🧠 记忆: ${loadMemories(fromUser).length} 条
⏰ 推送: ${DAILY_PUSH_TIME || "关闭"}
🛠️ Agent: 计算/代码/联网搜索
💾 状态: ${isSessionPaused() ? "暂停中" : "运行中"}
🗣️  上下文: ${getConversation(fromUser).length} 条`;
          await sendMessage({ baseUrl: account.baseUrl, token: account.botToken, toUserId: fromUser, text: diag, contextToken: getContextToken(fromUser) });
          log(`📤 诊断回复 to=${fromUser}`);
          continue;
        }
        // --- Handle media types ---
        let prompt = text;

        // Image recognition → feed to LLM for smart understanding
        if (mediaType === "image") {
          log(`🖼️  图片消息 — 下载解密识别...`);
          let recognition = "";
          try {
            recognition = await handleImageMessage(msg, fromUser, account) || "";
            if (recognition) {
              log(`🔍 图片识别结果: ${recognition.slice(0, 80)}...`);
            }
          } catch (err) {
            log(`❌ 图片下载/解密失败: ${String(err)}`);
          }
          // 把识别结果作为上下文，交给 LLM 理解后回复
          if (recognition && !recognition.startsWith("抱歉")) {
            prompt = `[用户发送了一张图片，视觉AI识别结果如下：]\n\n"${recognition}"\n\n---\n请根据以上图片内容，用中文回答用户的问题。用户${
              text ? `说："${text}"` : "没有附加文字，请根据图片内容主动提供帮助（如总结、解释、翻译图中的文字等）"
            }`;
            // Fall through to LLM call below
          } else {
            // 识别失败，告诉用户
            await sendMessage({
              baseUrl: account.baseUrl, token: account.botToken, toUserId: fromUser,
              text: recognition || "抱歉，图片处理失败，请稍后再试。", contextToken: getContextToken(fromUser),
            });
            continue;
          }
        }

        if (mediaType && mediaType !== "image") {
          if (!text) {
            prompt = `[用户发送了一个${mediaType === "voice" ? "语音" : mediaType === "file" ? "文件" : "视频"}，但我暂不支持直接查看]`;
          } else {
            prompt = `[用户发送了一段消息并附带了一个${mediaType === "voice" ? "语音" : mediaType === "file" ? "文件" : "视频"}]\n${text}`;
          }
        }

        // Call LLM and reply
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
    log("   LLM_BASE_URL=https://api.moonshot.cn/v1");
    log("   LLM_MODEL=kimi-k3");
    process.exit(1);
  }

  log(`🤖 模型: ${CLAUDE_MODEL}`);
  log(`🧠 推理深度: ${LLM_REASONING} | max_tokens: ${LLM_MAX_TOKENS}`);
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
  log("   /diag — 查看诊断信息");
  log("   按 Ctrl+C 停止");
  log("");

  // Start daily push scheduler
  scheduleDailyPush(account);

  // Handle graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (pushTimer) clearInterval(pushTimer);
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
