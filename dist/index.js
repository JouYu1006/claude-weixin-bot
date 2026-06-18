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
/** Parse AES key — supports base64(raw bytes) and base64(hex string) */
function parseAesKey(src) {
    const decoded = Buffer.from(src, "base64");
    if (decoded.length === 16)
        return decoded;
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
function extractImageInfo(msg) {
    const items = msg.item_list ?? [];
    for (const item of items) {
        if (item.type === 2 && item.image_item) {
            const img = item.image_item;
            const media = (img["media"] || {});
            const fullUrl = media["full_url"];
            const encryptParam = media["encrypt_query_param"];
            const mediaAesKey = media["aes_key"];
            const rawAesKey = img["aeskey"]; // 32 hex chars
            const cdnBase = "https://novac2c.cdn.weixin.qq.com/c2c";
            if (fullUrl || encryptParam) {
                let key;
                try {
                    if (rawAesKey) {
                        key = Buffer.from(rawAesKey, "hex");
                    }
                    else if (mediaAesKey) {
                        key = parseAesKey(mediaAesKey);
                    }
                    else {
                        continue;
                    }
                }
                catch {
                    continue;
                }
                // Prefer server-provided full URL; fallback to client-built
                const downloadUrl = fullUrl
                    || `${cdnBase}/download?encrypted_query_param=${encodeURIComponent(encryptParam)}`;
                return { downloadUrl, aesKey: key };
            }
        }
    }
    return null;
}
/** Download and decrypt an image from WeChat CDN (AES-128-ECB) */
async function downloadWeChatImage(info) {
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
    }
    catch (err) {
        log(`❌ 下载解密失败: ${String(err)}`);
        return null;
    }
}
/** Send image to vision model — DeepSeek first, fallback to Groq (free) */
async function recognizeImage(imageBuffer, userPrompt) {
    const base64 = imageBuffer.toString("base64");
    const mimeType = "image/jpeg";
    const msgContent = [
        { type: "image_url", image_url: { url: "data:" + mimeType + ";base64," + base64 } },
        { type: "text", text: userPrompt || "请描述这张图片的内容，包括里面的文字、物品、场景。" },
    ];
    // Helper: Gemini thinking may consume content, fallback to reasoning_content
    const extractContent = (msg) => {
        const c = msg?.content || "";
        if (c.trim())
            return c;
        // fallback: reasoning_content (Gemini thinking output)
        const rc = msg?.reasoning_content;
        if (typeof rc === "string" && rc.trim())
            return rc;
        return "";
    };
    const failReasons = [];
    // Try 1: nonelinear Gemini Flash (cheap, always available)
    const nlKey = process.env.NONELINEAR_API_KEY;
    const nlBase = process.env.NONELINEAR_BASE_URL || "https://api.nonelinear.com/v1";
    if (nlKey) {
        try {
            log("🔄 nonelinear Gemini...");
            const nl = new OpenAI({ apiKey: nlKey, baseURL: nlBase });
            const resp = await nl.chat.completions.create({
                model: "gemini-2.5-flash",
                messages: [{ role: "user", content: msgContent }],
                max_tokens: 4096, temperature: 0.3, stream: false,
            });
            const msg = resp.choices?.[0]?.message;
            const text = extractContent(msg);
            if (text.trim()) {
                log("✅ nonelinear: " + text.slice(0, 60));
                return text;
            }
            // diagnose why empty
            const cLen = (msg?.content || "").length;
            const rcLen = (msg?.reasoning_content || "").length;
            const tokens = resp.usage?.total_tokens ?? 0;
            failReasons.push(`nonelinear: content=${cLen} reasoning=${rcLen} tokens=${tokens}`);
        }
        catch (err) {
            failReasons.push(`nonelinear: ${String(err).slice(0, 80)}`);
        }
    }
    else {
        failReasons.push("nonelinear: 未配置KEY");
    }
    // Try 2: SiliconFlow (free tier)
    const sfKey = process.env.SILICONFLOW_API_KEY;
    if (sfKey) {
        try {
            log("🔄 SiliconFlow...");
            const sf = new OpenAI({ apiKey: sfKey, baseURL: "https://api.siliconflow.cn/v1" });
            const resp = await sf.chat.completions.create({
                model: "Qwen/Qwen3-VL-32B",
                messages: [{ role: "user", content: msgContent }],
                max_tokens: 2048, temperature: 0.3, stream: false,
            });
            const text = extractContent(resp.choices?.[0]?.message);
            if (text.trim()) {
                log("✅ SiliconFlow: " + text.slice(0, 60));
                return text;
            }
            failReasons.push("SiliconFlow: 返回空");
        }
        catch (err) {
            failReasons.push(`SiliconFlow: ${String(err).slice(0, 80)}`);
        }
    }
    // Try 3: Groq
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) {
        try {
            log("🔄 Groq...");
            const groq = new OpenAI({ apiKey: groqKey, baseURL: "https://api.groq.com/openai/v1" });
            const resp = await groq.chat.completions.create({
                model: "llama-4-scout-17b-16e-instruct",
                messages: [{ role: "user", content: msgContent }],
                max_tokens: 2048, temperature: 0.3, stream: false,
            });
            const text = extractContent(resp.choices?.[0]?.message);
            if (text.trim()) {
                log("✅ Groq: " + text.slice(0, 60));
                return text;
            }
            failReasons.push("Groq: 返回空");
        }
        catch (err) {
            failReasons.push(`Groq: ${String(err).slice(0, 80)}`);
        }
    }
    return `抱歉，图片识别暂时不可用。\n[${failReasons.join(" | ")}]`;
}
/** Handle image message: download, decrypt, recognize, reply */
async function handleImageMessage(msg, fromUser, account) {
    const info = extractImageInfo(msg);
    if (!info)
        return "抱歉，我无法读取这张图片的数据。";
    await sendTyping({
        baseUrl: account.baseUrl,
        token: account.botToken,
        ilinkUserId: fromUser,
        typingTicket: "",
        status: 1,
    }).catch(() => { });
    const imageBuffer = await downloadWeChatImage(info);
    if (!imageBuffer)
        return "抱歉，图片下载或解密失败。";
    const text = extractText(msg);
    const prompt = text || "请详细描述这张图片的内容。如果图片中有文字，请识别并翻译。";
    const recognition = await recognizeImage(imageBuffer, prompt);
    await sendTyping({
        baseUrl: account.baseUrl,
        token: account.botToken,
        ilinkUserId: fromUser,
        typingTicket: "",
        status: 2,
    }).catch(() => { });
    return recognition || "抱歉，我无法识别这张图片的内容。";
}
// ---------------------------------------------------------------------------
// Claude integration
// ---------------------------------------------------------------------------
const CLAUDE_MODEL = process.env.LLM_MODEL || "deepseek-chat";
const LLM_BASE_URL = process.env.LLM_BASE_URL || "https://api.deepseek.com/v1";
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
const LLM_REASONING = process.env.LLM_REASONING || "medium"; // low | medium | high — only for v4-pro
// nonelinear: 图片识别 & 搜索兜底 (Gemini)
const NL_API_KEY = process.env.NONELINEAR_API_KEY || "";
const NL_BASE_URL = process.env.NONELINEAR_BASE_URL || "https://api.nonelinear.com/v1";
const MEMORY_DIR = path.join(STATE_DIR, "memory");
function memoryPath(userId) {
    return path.join(MEMORY_DIR, `${userId.replace(/[@:\/\\]/g, "_")}.json`);
}
function loadMemories(userId) {
    try {
        fs.mkdirSync(MEMORY_DIR, { recursive: true });
        const p = memoryPath(userId);
        if (!fs.existsSync(p))
            return [];
        const raw = fs.readFileSync(p, "utf-8");
        return JSON.parse(raw);
    }
    catch {
        return [];
    }
}
function saveMemories(userId, entries) {
    try {
        fs.mkdirSync(MEMORY_DIR, { recursive: true });
        // Keep last 200 entries, dedup by fact substring
        const deduped = [];
        const seen = new Set();
        for (const e of [...entries].reverse()) {
            const key = e.fact.slice(0, 60);
            if (!seen.has(key)) {
                seen.add(key);
                deduped.unshift(e);
            }
        }
        fs.writeFileSync(memoryPath(userId), JSON.stringify(deduped.slice(-200), null, 2), "utf-8");
    }
    catch { /* non-critical */ }
}
function memoryToPrompt(entries) {
    if (entries.length === 0)
        return "";
    const byCat = {};
    for (const e of entries.slice(-30)) {
        (byCat[e.category] ??= []).push(`- ${e.fact}`);
    }
    const lines = ["", "【关于这位用户，你已知的信息】"];
    const labels = { personal: "个人", preference: "偏好", context: "背景", topic: "关注话题" };
    for (const [cat, facts] of Object.entries(byCat)) {
        lines.push(`[${labels[cat] || cat}]`);
        lines.push(...facts);
    }
    lines.push("【请自然地在对话中使用这些信息，但不要刻意复述】");
    return lines.join("\n");
}
/** Non-blocking: extract interesting facts from the latest exchange */
function extractFactsInBackground(userId, userMsg, assistantMsg) {
    (async () => {
        try {
            const existing = loadMemories(userId);
            const oldFacts = existing.slice(-10).map(e => `- ${e.fact}`).join("\n");
            const client = new OpenAI({ apiKey: process.env.LLM_API_KEY, baseURL: LLM_BASE_URL });
            const resp = await client.chat.completions.create({
                model: "deepseek-v4-flash", // cheap model for extraction
                messages: [
                    { role: "system", content: `你是一个信息提取助手。从用户和助手的对话中提取关于用户的重要事实。只输出 JSON 数组，每条包含 fact(事实描述)、category(personal/preference/context/topic)。不要重复已有的内容。无新信息则输出 []。` },
                    { role: "user", content: `已有事实：\n${oldFacts || "(无)"}\n\n用户消息：${userMsg.slice(0, 500)}\n\n助手回复：${assistantMsg.slice(0, 500)}\n\n请提取新的或更新的事实：` }
                ],
                max_tokens: 512,
                temperature: 0.3,
                response_format: { type: "json_object" },
            });
            const text = resp.choices?.[0]?.message?.content || "[]";
            const parsed = JSON.parse(text);
            const facts = parsed.facts || parsed;
            if (Array.isArray(facts) && facts.length > 0) {
                const now = new Date().toISOString();
                const newEntries = facts
                    .filter((f) => f.fact && f.fact.length > 2)
                    .map((f) => ({
                    fact: f.fact.trim(),
                    category: f.category || "context",
                    at: now,
                }));
                if (newEntries.length > 0) {
                    saveMemories(userId, [...existing, ...newEntries]);
                    log(`🧠 记忆: ${newEntries.length} 条 → ${memoryPath(userId)}`);
                }
            }
        }
        catch { /* non-blocking, ignore errors */ }
    })();
}
const conversations = new Map();
const MAX_CONVERSATION_PAIRS = parseInt(process.env.CONVERSATION_ROUNDS || "100", 10);
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
    // Auto-detect: time-sensitive / factual / question keywords
    const triggers = [
        // Time-sensitive
        "今天", "现在", "最近", "最新", "刚刚", "当前", "实时", "目前",
        "新闻", "天气", "股价", "汇率", "热搜", "发生什么", "发生了什么",
        "动态", "进展", "更新", "变化", "趋势", "行情",
        "几点了", "星期几", "日期", "时间",
        "realtime", "today", "news", "latest", "update",
        // Question patterns → likely factual lookup needed
        "是什么", "什么是", "为什么", "怎么", "如何",
        "多少钱", "多少", "哪个", "哪里", "在哪", "怎么样",
        "区别", "对比", "比较", "排名", "排行榜",
        "是什么", "解释", "定义",
        // Tech/product queries
        "发布了", "推出了", "更新了", "发布", "上市",
        "多少钱", "价格", "售价",
    ];
    if (triggers.some(kw => t.includes(kw)))
        return t;
    // Auto-detect: contains URL → user sharing a link, search for context
    if (/https?:\/\//.test(t))
        return null; // don't search URLs, they'll be fetched directly
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
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    // Detect intent and build clean English query
    const isNews = /新闻|动态|最新|今天|最近|进展|大事/.test(raw);
    const isTech = /科技|技术|AI|人工智能|数码|手机|电脑|软件/.test(raw);
    const isWeather = /天气|气温|下雨|台风/.test(raw);
    const isStock = /股价|股票|大盘|基金|币|行情/.test(raw);
    const isSport = /比赛|足球|篮球|NBA|英超|中超|体育/.test(raw);
    // Extract meaningful nouns (keep English words and Chinese characters)
    const cleanChinese = raw
        .replace(/[？?!！。，,、\s]+/g, " ")
        .replace(/(有什么|是什么|怎么样|如何|有哪些|帮我|搜一下|查一下|一下|吗|吧|最近|最新|今天|现在|的)/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
    // Extract any English/alphanumeric words (product names, model numbers, etc.)
    const engWords = raw.match(/[A-Za-z0-9]+/g)?.join(" ") || "";
    let q = "";
    if (isWeather) {
        q = `weather forecast today`;
    }
    else if (isStock) {
        q = engWords ? `${engWords} stock price` : "stock market";
        if (cleanChinese.length > 2)
            q += ` ${cleanChinese}`;
    }
    else if (isSport) {
        q = engWords ? `${engWords} sports` : `sports news ${dateStr}`;
    }
    else if (isTech && isNews) {
        q = `latest technology news ${dateStr}`;
        if (engWords)
            q = `${engWords} ${q}`;
    }
    else if (isNews) {
        q = `latest news ${dateStr}`;
        if (engWords)
            q = `${engWords} ${q}`;
    }
    else if (isTech) {
        q = engWords ? `${engWords} technology` : `technology`;
        if (cleanChinese.length > 2 && cleanChinese !== engWords)
            q += ` ${cleanChinese}`;
    }
    else {
        // General: merge English words + cleaned Chinese, deduplicating
        const parts = new Set();
        if (engWords)
            engWords.split(/\s+/).forEach(w => parts.add(w.toLowerCase()));
        cleanChinese.split(/\s+/).forEach(w => { const l = w.toLowerCase(); if (!parts.has(l))
            parts.add(w); });
        q = [...parts].join(" ");
    }
    return q || raw.replace(/[？?!！。，,、]/g, " ").trim();
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
    const isNewsItem = /news|新闻|动态|进展|大事|\d{4}-\d{2}-\d{2}/.test(query);
    // Engine 1 (news): Google News RSS — free, real articles with titles+snippets
    if (isNewsItem) {
        try {
            const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
            slog(`Google News RSS...`);
            const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
            const xml = await resp.text();
            anyEngineReachable = true;
            const results = [];
            const itemRe = /<item>([\s\S]*?)<\/item>/gi;
            let m;
            while ((m = itemRe.exec(xml)) !== null && results.length < 8) {
                const item = m[1];
                // CDATA or plain text for title/desc/link
                const tm = /<title>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/title>/i.exec(item);
                const sm = /<description>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/description>/i.exec(item);
                const lm = /<link>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))\s*<\/link>/i.exec(item);
                // Google News: <source url="...">Name</source>
                const srcUrlM = /<source\b[^>]*url="([^"]*)"/i.exec(item);
                const srcNameM = /<source\b[^>]*>([^<]*)<\/source>/i.exec(item);
                const title = (tm?.[1] || tm?.[2] || "").replace(/<[^>]+>/g, "").trim();
                let snippet = (sm?.[1] || sm?.[2] || "").replace(/<[^>]+>/g, "").trim();
                const link = (lm?.[1] || lm?.[2] || "").trim();
                const source = srcNameM?.[1]?.trim() || "";
                if (title && title.length > 5 && !/video|watch|live/i.test(title)) {
                    if (source)
                        snippet = `[来源: ${source}] ${snippet}`;
                    results.push({ title, snippet, url: link.trim() });
                }
            }
            slog(`Google News: ${resp.status}, ${results.length} articles`);
            status = "Google News OK";
            if (results.length > 0) {
                searchEngineStatus = status;
                lastSearchError = "";
                return results;
            }
        }
        catch (err) {
            slog(`Google News err: ${String(err)}`);
        }
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
        while ((b = re.exec(html)) !== null && results.length < 8) {
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
    // Engine 2: Bing HTML (current structure, tested 2026-06)
    try {
        const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10&setlang=en`;
        slog(`Bing...`);
        const resp = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept-Language": "en-US,en;q=0.9" } });
        anyEngineReachable = true;
        const html = await resp.text();
        slog(`Bing: ${resp.status}, ${html.length}b`);
        const results = [];
        // Structure: <li class="b_algo"> ... <a target="_blank" href="URL">TITLE</a> ... <p>SNIPPET</p> ... </li>
        const blockRe = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
        let b2;
        while ((b2 = blockRe.exec(html)) !== null && results.length < 8) {
            const body = b2[1];
            // Title: the second <a> with target="_blank" usually has the clean title
            const titleM = /<a[^>]*target="_blank"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(body)
                || /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(body);
            // Snippet: first <p> with content
            const snipM = /<p[^>]*>([\s\S]{10,500}?)<\/p>/i.exec(body);
            if (titleM) {
                const title = titleM[2].replace(/<[^>]+>/g, "").trim();
                const url = titleM[1].startsWith("http") ? titleM[1] : `https://www.bing.com${titleM[1]}`;
                const snippet = snipM ? snipM[1].replace(/<[^>]+>/g, "").trim() : "";
                if (title && title.length > 3 && !/baidu\.com|百度/.test(title))
                    results.push({ title, snippet, url });
            }
        }
        slog(`Bing: ${results.length} results`);
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
    // Engine 3: DDG JSON (instant answers only — for facts, not news)
    try {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
        slog(`DDG JSON...`);
        const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
        const data = await resp.json();
        anyEngineReachable = true;
        const results = [];
        const abs = data.AbstractText?.trim();
        if (abs)
            results.push({ title: data.Heading || query, snippet: abs, url: data.AbstractURL || "" });
        // Only include RelatedTopics if they contain real content (not just links)
        const related = data.RelatedTopics;
        if (related)
            for (const r of related) {
                if (r.Text && results.length < 6) {
                    const clean = r.Text.replace(/<[^>]+>/g, "").trim();
                    // Skip entries that are just link descriptions (no real content)
                    if (clean.length > 30)
                        results.push({ title: "", snippet: clean, url: r.FirstURL || "" });
                }
            }
        slog(`DDG JSON: ${resp.status}, abstract=${abs ? "yes" : "no"}, useful=${results.length}`);
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
// Full-text page fetching (for deep summarization)
// ---------------------------------------------------------------------------
/** Extract visible text from HTML, removing scripts/styles/tags */
function htmlToText(html) {
    let text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
        .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "")
        .replace(/<[^>]+>/g, "\n")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#x27;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]+/g, " ")
        .split("\n")
        .map(l => l.trim())
        .filter(l => l.length > 20) // skip navigation/empty lines
        .join("\n");
    // Truncate to reasonable size
    if (text.length > 4000)
        text = text.slice(0, 4000) + "...";
    return text;
}
async function fetchPageText(url) {
    try {
        const resp = await fetch(url, {
            signal: AbortSignal.timeout(8000),
            headers: { "User-Agent": "Mozilla/5.0 (compatible; ClaudeWeixinBot/1.0)", "Accept": "text/html", "Accept-Language": "zh-CN,en" },
        });
        const html = await resp.text();
        return htmlToText(html);
    }
    catch {
        return "";
    }
}
/**
 * Fetch full text of top N search results for deep summarization.
 * Returns concatenated page contents with source attribution.
 */
/** Filter out junk domains that don't contain useful article text */
const JUNK_DOMAINS = [
    "amazon.", "ebay.", "etsy.", "walmart.", "bestbuy.", "target.",
    "youtube.", "vimeo.", "reddit.", "twitter.", "facebook.", "instagram.",
    "wikipedia.org", "britannica.com", "dictionary.com",
    "pinterest.", "tripadvisor.", "booking.com"
];
function isNewsWorthy(url) {
    const lower = url.toLowerCase();
    return !JUNK_DOMAINS.some(d => lower.includes(d));
}
async function fetchTopPages(results, maxPages = 3) {
    const urls = results
        .filter(r => r.url && !r.url.includes("duckduckgo.com") && isNewsWorthy(r.url))
        .slice(0, maxPages);
    if (urls.length === 0)
        return "";
    log(`📄 抓取 ${urls.length} 个页面全文...`);
    const pages = [];
    for (const r of urls) {
        const text = await fetchPageText(r.url);
        if (text) {
            pages.push(`--- 来源: ${r.title || r.url} ---\n${r.url}\n\n${text}`);
            log(`   ✅ ${r.title?.slice(0, 40) || r.url.slice(0, 40)} (${text.length} 字)`);
        }
        else {
            log(`   ⚠️  ${r.title?.slice(0, 40) || r.url.slice(0, 40)} 抓取失败`);
        }
    }
    return pages.length > 0 ? pages.join("\n\n") : "";
}
// ---------------------------------------------------------------------------
// Agent Tools
// ---------------------------------------------------------------------------
/** Safe math evaluation (no eval, uses Function) */
function calculateExpression(expr) {
    try {
        // Whitelist: only allow numbers, operators, parens, math functions
        const sanitized = expr.replace(/\s+/g, "");
        if (!/^[0-9+\-*/().,%^!sqrtabslogsin]+$/i.test(sanitized)) {
            return `表达式包含不支持的内容: ${expr}`;
        }
        const result = new Function(`"use strict"; return (${sanitized})`)();
        return `${expr} = ${result}`;
    }
    catch (e) {
        return `计算失败: ${String(e)}`;
    }
}
/** Simple translation via pre-search */
async function quickTranslate(text, targetLang) {
    const q = `translate "${text}" to ${targetLang}`;
    const results = await performSearch(q);
    if (results.length > 0) {
        return results.slice(0, 2).map(r => `${r.title}\n${r.snippet}`).join("\n\n");
    }
    return `无法翻译 "${text.slice(0, 50)}"`;
}
/** Run code snippet (JavaScript only, timeout 3s, no network/fs) */
async function runCodeSnippet(code) {
    try {
        const result = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("执行超时 (3s)")), 3000);
            try {
                // Run in isolated context — console.log goes to captured output
                const logs = [];
                const fakeConsole = { log: (...a) => logs.push(a.map(String).join(" ")) };
                const fn = new Function("console", `"use strict"; ${code}`);
                const ret = fn(fakeConsole);
                clearTimeout(timer);
                const output = logs.length > 0 ? logs.join("\n") : String(ret ?? "(无输出)");
                resolve(output);
            }
            catch (e) {
                clearTimeout(timer);
                reject(e);
            }
        });
        return result;
    }
    catch (e) {
        return `代码执行错误: ${String(e)}`;
    }
}
/** Tool definitions for function calling */
const AGENT_TOOLS = [
    {
        type: "function",
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
        type: "function",
        function: {
            name: "translate",
            description: "翻译文本到指定语言。当用户要求翻译时使用。",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "要翻译的文本" },
                    target: { type: "string", description: "目标语言，如 English、中文、日语、法语" },
                },
                required: ["text", "target"],
            },
        },
    },
    {
        type: "function",
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
];
async function executeToolCalls(toolCalls) {
    const results = [];
    for (const tc of toolCalls) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fn = tc.function;
        const name = fn?.name || "";
        const argsStr = fn?.arguments || "{}";
        const args = JSON.parse(argsStr);
        let output = "";
        try {
            if (name === "calculate") {
                output = calculateExpression(args.expression || "");
                log(`🧮 计算: ${args.expression} → ${output.slice(0, 60)}`);
            }
            else if (name === "translate") {
                output = await quickTranslate(args.text || "", args.target || "English");
                log(`🌐 翻译: ${(args.text || "").slice(0, 30)} → ${args.target}`);
            }
            else if (name === "run_code") {
                output = await runCodeSnippet(args.code || "");
                log(`💻 代码: ${(args.code || "").slice(0, 50)}`);
            }
            else {
                output = `未知工具: ${name}`;
            }
        }
        catch (e) {
            output = `工具执行错误: ${String(e)}`;
        }
        results.push({ role: "tool", tool_call_id: tc.id, content: output });
    }
    return results;
}
// ---------------------------------------------------------------------------
// LLM call — with Agent Tool Loop + Pre-Search
// ---------------------------------------------------------------------------
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
            searchContext = `（${new Date().toLocaleDateString("zh-CN")}）：\n${formatSearchResults(searchQuery, results)}`;
            searchHint = "📡 ";
            // Fetch full pages only if snippets are thin (not from Google News RSS)
            const hasRichSnippets = results.some(r => r.snippet && r.snippet.length > 100);
            if (!hasRichSnippets) {
                const fullPages = await fetchTopPages(results, 2);
                if (fullPages)
                    searchContext += `\n\n--- 详细内容 ---\n${fullPages}`;
            }
        }
        else {
            searchHint = "";
            log(`⚠️ 所有搜索引擎均失败`);
        }
    }
    // --- Build prompt ---
    // Strategy: Don't say "search" or "web" or "资料". Just splice results into the user message
    // as if the user copy-pasted them. DeepSeek can't refuse to read user-provided text.
    // Load persistent memories for this user
    const memories = loadMemories(userId);
    const memoryPrompt = memoryToPrompt(memories);
    let systemMsg = SYSTEM_PROMPT + memoryPrompt;
    let promptUserMessage = userMessage;
    if (searchContext) {
        // Rewrite the entire user message: results ARE the user message now
        const cleanResults = searchContext
            .replace(/搜索/g, "")
            .replace(/互联网/g, "")
            .replace(/联网/g, "")
            .replace(/抓取/g, "");
        promptUserMessage = `我整理了一些相关内容，帮我看看并回答：

${cleanResults}

--- 请帮我总结以上内容的要点，用中文回答 ---`;
    }
    const messages = [
        { role: "system", content: systemMsg },
        ...convo.map(m => ({ role: m.role, content: m.content })),
        { role: "user", content: promptUserMessage },
    ];
    let replyText = "";
    try {
        // --- Agent Tool Loop (max 3 rounds) ---
        let workingMessages = [...messages];
        const MAX_TOOL_ROUNDS = 3;
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            // Non-streaming call to check for tool requests
            const resp = await client.chat.completions.create({
                model: CLAUDE_MODEL,
                messages: workingMessages,
                max_tokens: LLM_MAX_TOKENS,
                temperature: LLM_TEMPERATURE,
                top_p: 0.95,
                tools: AGENT_TOOLS,
                ...(CLAUDE_MODEL.includes("v4-pro") ? { reasoning_effort: LLM_REASONING } : {}),
            });
            const choice = resp.choices?.[0];
            const toolCalls = choice?.message?.tool_calls;
            if (toolCalls && toolCalls.length > 0) {
                // Execute tools and continue loop
                workingMessages.push(choice.message);
                const toolResults = await executeToolCalls(toolCalls);
                workingMessages.push(...toolResults);
                log(`🔧 工具调用 (第 ${round + 1} 轮): ${toolCalls.map((tc) => tc.function?.name).join(", ")}`);
                continue; // loop to next round with tool results
            }
            // No tools — collect reply and break
            replyText = choice?.message?.content || "";
            break;
        }
        // If reply is empty after tool loop, do a final streaming call
        if (!replyText.trim()) {
            const stream = await client.chat.completions.create({
                model: CLAUDE_MODEL,
                messages: workingMessages,
                max_tokens: LLM_MAX_TOKENS,
                temperature: LLM_TEMPERATURE,
                top_p: 0.95,
                stream: true,
                ...(CLAUDE_MODEL.includes("v4-pro") ? { reasoning_effort: LLM_REASONING } : {}),
            });
            for await (const chunk of stream) {
                const delta = chunk.choices?.[0]?.delta?.content;
                if (delta)
                    replyText += delta;
            }
        }
        // Stop typing
        if (config.typing_ticket) {
            sendTyping({ baseUrl: account.baseUrl, token: account.botToken, ilinkUserId: userId, typingTicket: config.typing_ticket, status: 2 }).catch(() => { });
        }
        // Store conversation (original message, not the search-augmented one)
        convo.push({ role: "user", content: userMessage });
        convo.push({ role: "assistant", content: replyText });
        trimConversation(convo);
        // Background: extract user facts from this exchange (non-blocking)
        extractFactsInBackground(userId, userMessage, replyText);
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
// Daily Push (weather + news, scheduled)
// ---------------------------------------------------------------------------
const DAILY_PUSH_TIME = process.env.DAILY_PUSH_TIME || ""; // "08:00" format
let pushTimer = null;
async function runDailyPush(account) {
    const userId = account.userId;
    if (!userId) {
        log("⏰ 推送跳过：未找到用户 ID");
        return;
    }
    log(`⏰ 执行每日推送...`);
    const dateStr = new Date().toLocaleDateString("zh-CN", { weekday: "long", month: "long", day: "numeric" });
    // 1. Search weather
    let weatherText = "";
    try {
        const weatherResults = await performSearch(`weather forecast today`);
        if (weatherResults.length > 0) {
            weatherText = weatherResults.slice(0, 3).map(r => `${r.title}${r.snippet ? `: ${r.snippet}` : ""}`).join("\n");
        }
    }
    catch {
        weatherText = "天气数据暂不可用";
    }
    // 2. Search news
    let newsText = "";
    try {
        const newsResults = await performSearch(`latest technology news ${new Date().toISOString().slice(0, 10)}`);
        if (newsResults.length > 0) {
            newsText = newsResults.slice(0, 5).map(r => `• ${r.title}${r.snippet ? ` — ${r.snippet.slice(0, 100)}` : ""}`).join("\n");
        }
    }
    catch {
        newsText = "新闻数据暂不可用";
    }
    // 3. Compose and send
    const summary = `☀️ ${dateStr} 早间简报

🌤️ 天气
${weatherText || "暂无天气数据"}

📰 科技早报
${newsText || "暂无新闻数据"}

✨ 祝你今天愉快！`;
    try {
        await sendMessage({
            baseUrl: account.baseUrl,
            token: account.botToken,
            toUserId: userId,
            text: summary,
            contextToken: getContextToken(userId),
        });
        log(`✅ 每日推送完成 → ${userId}`);
    }
    catch (err) {
        log(`❌ 每日推送失败: ${String(err)}`);
    }
}
function scheduleDailyPush(account) {
    if (!DAILY_PUSH_TIME)
        return;
    const [h, m] = DAILY_PUSH_TIME.split(":").map(Number);
    if (isNaN(h) || isNaN(m)) {
        log(`⚠️  DAILY_PUSH_TIME 格式错误: ${DAILY_PUSH_TIME}`);
        return;
    }
    // Calculate ms until next occurrence
    const now = new Date();
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    if (target <= now)
        target.setDate(target.getDate() + 1);
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
                    const diag = `🤖 Claude-Weixin-Bot v1.1.0
📡 模型: ${CLAUDE_MODEL}
🧠 推理: ${LLM_REASONING} | 温度: ${LLM_TEMPERATURE} | tokens: ${LLM_MAX_TOKENS}
🔗 API: ${LLM_BASE_URL}
🖼️  图片: ${NL_API_KEY ? "✅ nonelinear Gemini" : "❌ 未配置"}
🔍 搜索: ${searchEngineStatus}
🧠 记忆: ${loadMemories(fromUser).length} 条
⏰ 推送: ${DAILY_PUSH_TIME || "关闭"}
🛠️ Agent: 计算/翻译/代码
⚠️ 错误: ${lastSearchError || "无"}
💾 状态: ${isSessionPaused() ? "暂停中" : "运行中"}
🗣️  上下文: ${getConversation(fromUser).length} 条`;
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
                // --- Handle media types ---
                let prompt = text;
                // Image recognition
                if (mediaType === "image") {
                    log(`🖼️  图片消息 — 下载解密识别...`);
                    let recognition = "";
                    try {
                        recognition = await handleImageMessage(msg, fromUser, account) || "";
                        if (recognition) {
                            await sendMessage({
                                baseUrl: account.baseUrl, token: account.botToken, toUserId: fromUser,
                                text: recognition, contextToken: getContextToken(fromUser),
                            });
                            log(`📤 图片识别回复: ${recognition.slice(0, 80)}...`);
                        }
                    }
                    catch (err) {
                        log(`❌ 图片识别失败: ${String(err)}`);
                        recognition = "抱歉，图片识别失败，请稍后再试。";
                        await sendMessage({
                            baseUrl: account.baseUrl, token: account.botToken, toUserId: fromUser,
                            text: recognition, contextToken: getContextToken(fromUser),
                        });
                    }
                    // 存入对话上下文，避免说完就忘
                    if (recognition) {
                        const picConvo = getConversation(fromUser);
                        picConvo.push({ role: "user", content: text ? `[图片] ${text}` : "[发送了一张图片]" });
                        picConvo.push({ role: "assistant", content: recognition });
                        trimConversation(picConvo);
                    }
                    continue; // handled, skip LLM call
                }
                if (mediaType && !text) {
                    prompt = `[用户发送了一个${mediaType === "voice" ? "语音" : mediaType === "file" ? "文件" : "视频"}，但我暂不支持直接查看]`;
                }
                else if (mediaType && text) {
                    prompt = `[用户发送了一段消息并附带了一个${mediaType === "voice" ? "语音" : mediaType === "file" ? "文件" : "视频"}]\n${text}`;
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
    log(`🧠 推理深度: ${LLM_REASONING} | 温度: ${LLM_TEMPERATURE} | max_tokens: ${LLM_MAX_TOKENS}`);
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
    // Start daily push scheduler
    scheduleDailyPush(account);
    // Handle graceful shutdown
    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        if (pushTimer)
            clearInterval(pushTimer);
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