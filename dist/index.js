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
            if (!trimmed || trimmed.startsWith("#"))
                continue;
            const eqIdx = trimmed.indexOf("=");
            if (eqIdx === -1)
                continue;
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim();
            if (!process.env[key])
                process.env[key] = val;
        }
    }
}
catch { /* ignore */ }
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
// State persistence
// ---------------------------------------------------------------------------
function ensureStateDir() {
    fs.mkdirSync(STATE_DIR, { recursive: true });
}
function loadJsonFile(filename) {
    try {
        const p = path.join(STATE_DIR, filename);
        if (!fs.existsSync(p))
            return null;
        return JSON.parse(fs.readFileSync(p, "utf-8"));
    }
    catch {
        return null;
    }
}
function saveJsonFile(filename, data) {
    ensureStateDir();
    fs.writeFileSync(path.join(STATE_DIR, filename), JSON.stringify(data, null, 2), "utf-8");
}
function loadAccount() {
    // Cloud mode: load from env var (one-line JSON, no newlines)
    const envJson = process.env.ACCOUNT_JSON;
    if (envJson) {
        try {
            return JSON.parse(envJson);
        }
        catch { /* fall through */ }
    }
    return loadJsonFile("account.json");
}
function saveAccount(acc) {
    saveJsonFile("account.json", acc);
}
function loadSyncBuf() {
    const envBuf = process.env.SYNC_BUF;
    if (envBuf)
        return envBuf;
    const data = loadJsonFile("sync-buf.json");
    return data?.buf ?? "";
}
function saveSyncBuf(buf) {
    if (buf)
        saveJsonFile("sync-buf.json", { buf });
}
function loadContextTokens() {
    return loadJsonFile("context-tokens.json") ?? {};
}
function saveContextTokens(tokens) {
    saveJsonFile("context-tokens.json", tokens);
}
const contextTokenCache = loadContextTokens();
function setContextToken(userId, token) {
    contextTokenCache[userId] = token;
    saveContextTokens(contextTokenCache);
}
function getContextToken(userId) {
    return contextTokenCache[userId];
}
// ---------------------------------------------------------------------------
// iLink HTTP helpers
// ---------------------------------------------------------------------------
function randomWechatUin() {
    const uint32 = crypto.randomBytes(4).readUInt32BE(0);
    return Buffer.from(String(uint32), "utf-8").toString("base64");
}
function buildClientVersion(version) {
    const [major, minor, patch] = version.split(".").map(Number);
    return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}
const ILINK_APP_CLIENT_VERSION = buildClientVersion(CHANNEL_VERSION);
function buildBaseInfo() {
    return { channel_version: CHANNEL_VERSION, bot_agent: DEFAULT_BOT_AGENT };
}
function buildHeaders(token) {
    const h = {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": randomWechatUin(),
        "iLink-App-Id": ILINK_APP_ID,
        "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
    };
    if (token)
        h.Authorization = `Bearer ${token}`;
    return h;
}
function ensureTrailingSlash(url) {
    return url.endsWith("/") ? url : `${url}/`;
}
async function apiGet(params) {
    const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl));
    const hdrs = buildHeaders();
    const timeout = params.timeoutMs;
    const controller = timeout != null && timeout > 0 ? new AbortController() : undefined;
    const t = controller ? setTimeout(() => controller.abort(), timeout) : undefined;
    try {
        const res = await fetch(url.toString(), {
            method: "GET",
            headers: hdrs,
            ...(controller ? { signal: controller.signal } : {}),
        });
        if (t)
            clearTimeout(t);
        const text = await res.text();
        if (!res.ok)
            throw new Error(`${params.label} ${res.status}: ${text}`);
        return text;
    }
    catch (err) {
        if (t)
            clearTimeout(t);
        throw err;
    }
}
async function apiPost(params) {
    const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl));
    const hdrs = buildHeaders(params.token);
    const timeout = params.timeoutMs;
    const controller = timeout != null && timeout > 0 ? new AbortController() : undefined;
    const t = controller ? setTimeout(() => controller.abort(), timeout) : undefined;
    try {
        const res = await fetch(url.toString(), {
            method: "POST",
            headers: hdrs,
            body: JSON.stringify(params.body),
            ...(controller ? { signal: controller.signal } : {}),
        });
        if (t)
            clearTimeout(t);
        const text = await res.text();
        if (!res.ok)
            throw new Error(`${params.label} ${res.status}: ${text}`);
        return text;
    }
    catch (err) {
        if (t)
            clearTimeout(t);
        throw err;
    }
}
// ---------------------------------------------------------------------------
// QR Login
// ---------------------------------------------------------------------------
async function fetchQrCode() {
    const raw = await apiPost({
        baseUrl: FIXED_BASE_URL,
        endpoint: `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
        body: { local_token_list: [] },
        label: "fetchQR",
    });
    return JSON.parse(raw);
}
async function pollQrStatus(qrcode, verifyCode) {
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
    }
    catch (err) {
        // Timeout is normal — server holds 35s, then we retry
        if (err instanceof Error && err.name === "AbortError") {
            return { status: "wait" };
        }
        log(`⚠️  pollQR network error: ${String(err)}, retrying...`);
        return { status: "wait" };
    }
}
function log(msg) {
    const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    process.stdout.write(`[${ts}] ${msg}\n`);
}
async function readLine(prompt) {
    process.stdout.write(prompt);
    return new Promise((resolve) => {
        let input = "";
        const onData = (chunk) => {
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
async function displayQr(url) {
    try {
        const qrterm = await import("qrcode-terminal");
        qrterm.default.generate(url, { small: true });
    }
    catch {
        log(`⚠️  无法显示二维码，请访问: ${url}`);
    }
    log(`\n备用链接: ${url}\n`);
}
async function doLogin() {
    log("🔑 正在获取登录二维码...");
    const qrResp = await fetchQrCode();
    log("📱 请用手机微信扫描以下二维码：\n");
    await displayQr(qrResp.qrcode_img_content);
    log("⏳ 等待扫码...\n");
    let qrcode = qrResp.qrcode;
    let refreshCount = 1;
    let scannedShown = false;
    let pendingVerifyCode;
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
                const account = {
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
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
// ---------------------------------------------------------------------------
// iLink Bot API
// ---------------------------------------------------------------------------
async function getUpdates(params) {
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
    }
    catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
            // Long-poll timeout is normal — return empty
            return { ret: 0, msgs: [], get_updates_buf: params.buf };
        }
        throw err;
    }
}
async function sendMessage(params) {
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
async function sendTyping(params) {
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
async function getConfig(params) {
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
    }
    catch {
        // getConfig failure is non-fatal
        return {};
    }
}
async function notifyStart(params) {
    try {
        await apiPost({
            baseUrl: params.baseUrl,
            endpoint: "ilink/bot/msg/notifystart",
            body: { base_info: buildBaseInfo() },
            token: params.token,
            timeoutMs: CONFIG_TIMEOUT_MS,
            label: "notifyStart",
        });
    }
    catch (err) {
        log(`⚠️  notifyStart 失败（可忽略）: ${String(err)}`);
    }
}
async function notifyStop(params) {
    try {
        await apiPost({
            baseUrl: params.baseUrl,
            endpoint: "ilink/bot/msg/notifystop",
            body: { base_info: buildBaseInfo() },
            token: params.token,
            timeoutMs: CONFIG_TIMEOUT_MS,
            label: "notifyStop",
        });
    }
    catch {
        // Best-effort
    }
}
// ---------------------------------------------------------------------------
// Message text extraction
// ---------------------------------------------------------------------------
function extractText(msg) {
    const items = msg.item_list ?? [];
    for (const item of items) {
        if (item.type === 1 && item.text_item?.text) {
            let text = item.text_item.text;
            // Handle quoted messages
            if (item.ref_msg) {
                const ref = item.ref_msg;
                const parts = [];
                if (ref.title)
                    parts.push(ref.title);
                if (ref.message_item?.text_item?.text)
                    parts.push(ref.message_item.text_item.text);
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
function getMediaType(msg) {
    const items = msg.item_list ?? [];
    for (const item of items) {
        if (item.type === 2)
            return "image";
        if (item.type === 3)
            return "voice";
        if (item.type === 4)
            return "file";
        if (item.type === 5)
            return "video";
    }
    return undefined;
}
// ---------------------------------------------------------------------------
// Claude integration
// ---------------------------------------------------------------------------
const CLAUDE_MODEL = process.env.LLM_MODEL || "deepseek-chat";
const LLM_BASE_URL = process.env.LLM_BASE_URL || "https://api.deepseek.com/v1";
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || "你是一个微信 AI 助手。请用简洁、友好的中文回复。回答要有条理，避免冗长。";
const conversations = new Map();
const MAX_CONVERSATION_PAIRS = 20; // 20 round-trips = 40 messages
const MAX_USERS = 100;
function getConversation(userId) {
    let convo = conversations.get(userId);
    if (!convo) {
        if (conversations.size >= MAX_USERS) {
            const oldest = conversations.keys().next().value;
            if (oldest)
                conversations.delete(oldest);
        }
        convo = [];
        conversations.set(userId, convo);
    }
    return convo;
}
function trimConversation(convo) {
    const maxMsgs = MAX_CONVERSATION_PAIRS * 2;
    if (convo.length > maxMsgs) {
        convo.splice(0, convo.length - maxMsgs);
    }
}
/** Heuristic: does this message likely need a web search? */
function shouldSearch(text) {
    const t = text.trim();
    // Explicit: "搜索 xxx", "搜 xxx", "/s xxx"
    const explicit = t.match(/^(?:搜索|搜一下|查一下|帮我搜|帮我查|网上查|联网搜|查查|\/s|\/search)[：:\s]+(.+)/i);
    if (explicit)
        return explicit[1].trim();
    // Short "?" prefix: "?xxx" triggers search
    if (t.startsWith("?"))
        return t.slice(1).trim();
    // Auto-detect: time-sensitive / factual keywords
    const triggers = [
        "今天", "现在", "最近", "最新", "刚刚", "当前", "实时", "目前",
        "新闻", "天气", "股价", "汇率", "热搜", "发生什么", "发生了什么",
        "动态", "进展", "更新", "变化", "趋势", "行情",
        "几点了", "星期几", "日期", "时间",
        "realtime", "today", "news", "latest", "update",
    ];
    if (triggers.some(kw => t.toLowerCase().includes(kw.toLowerCase())))
        return t;
    return null;
}
/**
 * Search engine status (set by startup self-test, visible via /diag)
 */
/** Improve Chinese queries for English search engines */
function optimizeSearchQuery(raw) {
    const hasChinese = /[一-鿿]/.test(raw);
    if (!hasChinese)
        return raw;
    const year = new Date().getFullYear();
    let q = raw
        .replace(/[？?!！。，,、]/g, " ")
        .replace(/(有什么|是什么|怎么样|如何|有哪些|帮我|搜一下|查一下|最近|最新的)/g, "")
        .trim();
    if (/科技|技术/.test(raw))
        q += " technology";
    if (/新闻|动态|最新|进展/.test(raw))
        q += ` news ${year}`;
    if (/天气/.test(raw))
        q += " weather today";
    if (/股价|股票/.test(raw))
        q += ` stock price ${year}`;
    return q.trim();
}
let searchEngineStatus = "未检测";
let lastSearchError = "";
/**
 * Reliable search: DDG JSON API (free, no key, works from US datacenters).
 */
async function performSearch(query) {
    const slog = (msg) => { log(`[search] ${msg}`); };
    let anyEngineReachable = false;
    let status = "";
    // Engine 1: DuckDuckGo JSON API (proper API, not HTML scraping)
    try {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
        slog(`DDG JSON...`);
        const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const data = await resp.json();
        anyEngineReachable = true;
        const results = [];
        const abs = data.AbstractText?.trim();
        if (abs)
            results.push({ title: data.Heading || query, snippet: abs, url: data.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}` });
        const related = data.RelatedTopics;
        if (related)
            for (const r of related) {
                if (r.Text && results.length < 6)
                    results.push({ title: "", snippet: r.Text.replace(/<[^>]+>/g, ""), url: r.FirstURL || "" });
            }
        slog(`DDG JSON: ${resp.status}, abstract=${abs ? "yes" : "no"}, related=${related?.length || 0}, results=${results.length}`);
        status = "DDG JSON OK";
        if (results.length > 0) {
            searchEngineStatus = status;
            lastSearchError = "";
            return results;
        }
    }
    catch (err) {
        slog(`DDG JSON err: ${String(err)}`);
    }
    // Engine 2: DDG HTML
    try {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        slog(`DDG HTML...`);
        const resp = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { "User-Agent": "Mozilla/5.0 (compatible; ClaudeWeixinBot/1.0)" } });
        anyEngineReachable = true;
        const html = await resp.text();
        const results = [];
        const re = /class="result__body"[^>]*>([\s\S]*?)<\/td>/gi;
        let b;
        while ((b = re.exec(html)) !== null && results.length < 6) {
            const body = b[1];
            const tm = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(body);
            const sm = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(body);
            if (tm) {
                const t = tm[2].replace(/<[^>]+>/g, "").trim();
                if (t)
                    results.push({ title: t, snippet: sm?.[1]?.replace(/<[^>]+>/g, "").trim() || "", url: tm[1].startsWith("//") ? `https:${tm[1]}` : tm[1] });
            }
        }
        slog(`DDG HTML: ${resp.status}, ${results.length} results`);
        status = "DDG HTML OK";
        if (results.length > 0) {
            searchEngineStatus = status;
            lastSearchError = "";
            return results;
        }
    }
    catch (err) {
        slog(`DDG HTML err: ${String(err)}`);
    }
    // Engine 3: Bing
    try {
        const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10`;
        slog(`Bing...`);
        const resp = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { "User-Agent": "Mozilla/5.0 (compatible; ClaudeWeixinBot/1.0)" } });
        anyEngineReachable = true;
        const html = await resp.text();
        const results = [];
        const re2 = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
        let b2;
        while ((b2 = re2.exec(html)) !== null && results.length < 6) {
            const body = b2[1];
            const tm = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(body);
            const sm = /<(?:p|div)[^>]*>([\s\S]{15,300}?)<\/(?:p|div)>/i.exec(body);
            if (tm) {
                const t = tm[2].replace(/<[^>]+>/g, "").trim();
                if (t && t.length > 2)
                    results.push({ title: t, snippet: sm?.[1]?.replace(/<[^>]+>/g, "").trim() || "", url: tm[1].startsWith("http") ? tm[1] : `https://www.bing.com${tm[1]}` });
            }
        }
        slog(`Bing: ${resp.status}, ${results.length} results`);
        status = "Bing OK";
        if (results.length > 0) {
            searchEngineStatus = status;
            lastSearchError = "";
            return results;
        }
    }
    catch (err) {
        slog(`Bing err: ${String(err)}`);
    }
    searchEngineStatus = anyEngineReachable ? `${status} (空结果)` : "ALL DEAD";
    lastSearchError = anyEngineReachable ? "" : "全部搜索引擎无法连接";
    if (!anyEngineReachable)
        slog(`ALL engines unreachable`);
    return [];
}
/** Startup self-test: try a simple search and report */
async function testSearch() {
    log(`🧪 搜索引擎自检...`);
    const results = await performSearch("hello world");
    if (results.length > 0) {
        log(`✅ 搜索正常 (${results.length} 条)`);
        return `✅ 搜索正常 — ${searchEngineStatus}`;
    }
    log(`❌ 搜索失败: ${lastSearchError}`);
    return `❌ 搜索失败 — ${lastSearchError}`;
}
function formatSearchResults(query, results) {
    if (results.length === 0)
        return `未找到与 "${query}" 相关的结果。`;
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
async function callLLM(userId, userMessage, account) {
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
        sendTyping({ baseUrl: account.baseUrl, token: account.botToken, ilinkUserId: userId, typingTicket: config.typing_ticket, status: 1 }).catch(() => { });
    }
    // --- Decide whether to search first ---
    let searchContext = "";
    let searchHint = "";
    const searchQuery = shouldSearch(userMessage);
    if (searchQuery) {
        log(`🔍 搜索触发: "${searchQuery}"`);
        const optimized = optimizeSearchQuery(searchQuery);
        log(`🔍 优化后: "${optimized}"`);
        const results = await performSearch(optimized);
        log(`🔍 搜索结果: ${results.length} 条`);
        if (results.length > 0) {
            searchContext = `互联网信息（${new Date().toLocaleDateString("zh-CN")}）：\n${formatSearchResults(searchQuery, results)}`;
            searchHint = "【已联网搜索】 ";
        }
        else {
            searchHint = "【搜索无结果】 ";
            log(`⚠️ 所有搜索引擎均失败`);
        }
    }
    // --- Build prompt ---
    // CRITICAL: DeepSeek Chat refuses to acknowledge search capability.
    // Strategy: DON'T mention "搜索" at all. Frame as "参考資料" (reference material).
    // The model thinks it's reading pre-prepared notes, not searching.
    let systemMsg = SYSTEM_PROMPT;
    let promptUserMessage = userMessage;
    if (searchContext) {
        // DON'T modify system prompt — don't mention search at all.
        // Frame the entire request as document analysis.
        promptUserMessage = `请根据下面的参考资料，回答用户的问题。

[用户的问题]
${userMessage}

[参考资料]
${searchContext}

请用中文简洁清晰地回答。不要说"我无法联网"，资料已经提供给你了，你只需要阅读并回答。`;
    }
    const messages = [
        { role: "system", content: systemMsg },
        ...convo.map(m => ({ role: m.role, content: m.content })),
        { role: "user", content: promptUserMessage },
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
            if (delta)
                replyText += delta;
        }
        // Stop typing
        if (config.typing_ticket) {
            sendTyping({ baseUrl: account.baseUrl, token: account.botToken, ilinkUserId: userId, typingTicket: config.typing_ticket, status: 2 }).catch(() => { });
        }
        // Store conversation (original message, not the search-augmented one)
        convo.push({ role: "user", content: userMessage });
        convo.push({ role: "assistant", content: replyText });
        trimConversation(convo);
        // Prepend search indicator if search was triggered
        const result = splitText(replyText);
        if (searchHint && result.length > 0) {
            result[0] = searchHint + " " + result[0];
        }
        return result;
    }
    catch (err) {
        if (config.typing_ticket) {
            sendTyping({ baseUrl: account.baseUrl, token: account.botToken, ilinkUserId: userId, typingTicket: config.typing_ticket, status: 2 }).catch(() => { });
        }
        throw err;
    }
}
/** Split text into WeChat-friendly chunks (<= 4000 chars each, at sentence boundaries). */
function splitText(text) {
    if (!text)
        return [""];
    if (text.length <= MAX_TEXT_CHUNK)
        return [text];
    const chunks = [];
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
    if (remaining)
        chunks.push(remaining);
    return chunks;
}
// ---------------------------------------------------------------------------
// Monitor loop
// ---------------------------------------------------------------------------
let sessionPausedUntil = 0;
function pauseSession() {
    sessionPausedUntil = Date.now() + SESSION_PAUSE_MS;
    log(`⏸️  Session 过期，暂停 ${SESSION_PAUSE_MS / 60_000} 分钟...`);
}
function isSessionPaused() {
    if (sessionPausedUntil === 0)
        return false;
    if (Date.now() >= sessionPausedUntil) {
        sessionPausedUntil = 0;
        log("▶️  Session 暂停结束，恢复运行。");
        return false;
    }
    return true;
}
async function runMonitor(account) {
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
                }
                else {
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
                if (!text && !mediaType)
                    continue; // Empty message
                log(`📩 收到消息 from=${fromUser}: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`);
                if (mediaType)
                    log(`   📎 附件类型: ${mediaType}`);
                // --- Slash commands ---
                if (text === "/diag" || text === "/debug") {
                    const diag = `🤖 Claude-Weixin-Bot v1.0.0
📡 模型: ${CLAUDE_MODEL}
🔗 API: ${LLM_BASE_URL}
🔍 搜索引擎: ${searchEngineStatus}
⚠️ 最后错误: ${lastSearchError || "无"}
💾 状态: ${isSessionPaused() ? "暂停中" : "运行中"}`;
                    await sendMessage({ baseUrl: account.baseUrl, token: account.botToken, toUserId: fromUser, text: diag, contextToken: getContextToken(fromUser) });
                    log(`📤 诊断回复 to=${fromUser}`);
                    continue;
                }
                if (text === "/testsearch" || text.startsWith("/s ")) {
                    const sq = text === "/testsearch" ? "hello world" : text.slice(3).trim();
                    log(`🧪 手动搜索测试: "${sq}"`);
                    const results = await performSearch(sq);
                    if (results.length > 0) {
                        const formatted = formatSearchResults(sq, results);
                        await sendMessage({ baseUrl: account.baseUrl, token: account.botToken, toUserId: fromUser, text: `【搜索正常】${searchEngineStatus}\n\n${formatted}`, contextToken: getContextToken(fromUser) });
                    }
                    else {
                        await sendMessage({ baseUrl: account.baseUrl, token: account.botToken, toUserId: fromUser, text: `【搜索失败】${searchEngineStatus} — ${lastSearchError}`, contextToken: getContextToken(fromUser) });
                    }
                    continue;
                }
                // Build prompt with media awareness
                let prompt = text;
                if (mediaType && !text) {
                    prompt = `[用户发送了一个${mediaType === "image" ? "图片" : mediaType === "voice" ? "语音" : mediaType === "file" ? "文件" : "视频"}，但我无法直接查看其内容]`;
                }
                else if (mediaType && text) {
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
                        if (chunks.length > 1)
                            await sleep(500);
                    }
                }
                catch (err) {
                    log(`❌ Claude 调用失败: ${String(err)}`);
                    try {
                        await sendMessage({
                            baseUrl: account.baseUrl,
                            token: account.botToken,
                            toUserId: fromUser,
                            text: "抱歉，我暂时无法处理你的消息。请稍后再试。",
                            contextToken: getContextToken(fromUser),
                        });
                    }
                    catch {
                        // If even error message fails, give up
                    }
                }
            }
        }
        catch (err) {
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
            }
            else {
                await sleep(RETRY_DELAY_MS);
            }
        }
    }
}
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
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
    }
    else {
        log("🔐 首次使用，需要扫码登录微信 ClawBot\n");
        try {
            account = await doLogin();
        }
        catch (err) {
            if (err instanceof Error && err.message === "ALREADY_CONNECTED") {
                log("⚠️  该机器人已连接过，但本地没有找到凭证。请确认后重试。");
                process.exit(1);
            }
            log(`❌ 登录失败: ${String(err)}`);
            process.exit(1);
        }
    }
    log("");
    // Startup self-diagnostic
    const searchDiag = await testSearch();
    log(searchDiag);
    log("");
    log("━━━━━━━━━━━━━━━━━━━━━━━━━");
    log("📡 开始监听微信消息...");
    log("   /diag — 查看诊断信息");
    log("   /testsearch — 测试搜索");
    log("   按 Ctrl+C 停止");
    log("");
    // Handle graceful shutdown
    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown)
            return;
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
//# sourceMappingURL=index.js.map