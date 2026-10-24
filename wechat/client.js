"use strict";

const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const axios = require("axios");

const RAW_DIR = path.join(__dirname, "..", "data", "raw");

// These protocol builds are closed-source and differ slightly in casing and
// wrapper depth, so every field lookup goes through these tolerant helpers.
// Some builds serialize the WeChat protobuf SKBuiltinStringT wrapper, so a text
// field arrives as {"string": "..."} instead of a plain string.
function unwrap(v) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const k of Object.keys(v)) {
            if (/^(string|strcontent|content|value)$/i.test(k)) {
                const inner = v[k];
                if (typeof inner === "string" && inner !== "") return inner;
            }
        }
    }
    return v;
}

function find(obj, candidates) {
    if (!obj || typeof obj !== "object") return undefined;
    for (const c of candidates) {
        for (const k of Object.keys(obj)) {
            if (k.toLowerCase() === c.toLowerCase()) {
                const v = unwrap(obj[k]);
                if (v !== undefined && v !== null && v !== "") return v;
            }
        }
    }
    return undefined;
}

function findDeep(obj, candidates, depth) {
    depth = depth === undefined ? 3 : depth;
    if (!obj || typeof obj !== "object" || depth < 0) return undefined;
    const direct = find(obj, candidates);
    if (direct !== undefined) return direct;
    for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (v && typeof v === "object") {
            const r = findDeep(v, candidates, depth - 1);
            if (r !== undefined) return r;
        }
    }
    return undefined;
}

const MESSAGE_ARRAY_KEYS = ["addmsgs", "list", "messages", "msglist", "mesglist"];

function findArray(obj, depth) {
    depth = depth === undefined ? 3 : depth;
    if (!obj || typeof obj !== "object" || depth < 0) return undefined;
    // WeChat sync payloads call it AddMsgs; prefer the known names over "first array found".
    for (const wanted of MESSAGE_ARRAY_KEYS) {
        for (const k of Object.keys(obj)) {
            const v = obj[k];
            if (k.toLowerCase() === wanted && Array.isArray(v)) return v;
        }
    }
    for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (Array.isArray(v) && (v.length === 0 || (v[0] && typeof v[0] === "object"))) return v;
    }
    for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (v && typeof v === "object" && !Array.isArray(v)) {
            const r = findArray(v, depth - 1);
            if (r !== undefined) return r;
        }
    }
    return undefined;
}

const MSG_TYPE = {
    TEXT: 1,
    IMAGE: 3,
    VOICE: 34,
    VIDEO: 43,
    EMOJI: 47,
    APP: 49,
    // 51 是账号自身的服务号/同步通知（朋友圈、lastMessage 之类），不是聊天消息
    SYNC_NOTICE: 51,
    FRIEND_REQUEST: 37,
    SYSTEM: 10000,
    SYSTEM_2: 10002,
    // 实测线上会出现 9999：微信团队一类服务号推送，不是人能发的消息
    SERVICE: 9999,
};

const IGNORED_INcoming_TYPES = [MSG_TYPE.SYNC_NOTICE, MSG_TYPE.SYSTEM, MSG_TYPE.SYSTEM_2, MSG_TYPE.FRIEND_REQUEST, MSG_TYPE.SERVICE];

// 微信协议里 <atuserlist> 用 ^ 连接 wxid，不是逗号
const AT_SEPARATOR = "^";

// 全局按「平均 40 条/分钟」放行并允许 4 条小突发，同一私聊对象间隔 >=1.2s、
// 同一群 >=2.2s，且严禁并发调用发送接口。
// 之前用固定 1.5s 全局间隔，三个群各回一条就要 4.5 秒才发完 —— 突发被平均速率限制
// 卡成串行等待，其实平均下来根本没超。
const DEFAULT_RATE = { perMinute: 40, burst: 4, privateMs: 1200, groupMs: 2200 };

// Msg/Sync 单独给短超时：它要等微信 mmtls 回包，上游一抽就是十几秒，
// 跟着全局 60s 走的话整个收消息循环会停一分钟
const SYNC_TIMEOUT = 15000;

// 发送也要单独给短超时：所有发送排成一条串行队列，接口默认 60s 意味着服务端一抽风，
// 队列里排在后面的每一条回复都跟着等一分钟 —— 群里看到的就是「发了 cc 半天没反应」。
// 文本 8s、图片 20s（要传 base64，本来就慢），超时报错让队列继续走。
const SEND_TIMEOUT = 8000;
const SEND_IMAGE_TIMEOUT = 20000;

// 会话静默多久算「可能卡住了」。群里隔几分钟没消息太正常，所以第一次 3 分钟试一次，
// 之后每次翻倍、最多 10 分钟一次——newinit 的频率要像个正常客户端，小号经不起封。
const STALL_FIRST_MS = 180000;
const STALL_MAX_MS = 600000;

// 一批消息里最老的那条滞后超过这个秒数，就判定为「会话卡死后的积压回放」
// （实测一唤醒就回放 3900+ 条、横跨 2.8 小时），回放期间一条都不回，
// 等回放结束只回最新那一句
const BACKLOG_SECONDS = 20;

// 攒下的「冲机器人说的」那句如果本身都过时 15 分钟了，就别再回——
// 机器人停摆几小时后再冒一句，等于对着早就散了的牌局喊人，比不回更糟
const REPLY_FRESH_SECONDS = 900;

// 只有 Msg/Sync 这一个拉取通道（服务端没有推送端点），所以延迟下限就是轮询间隔。
// 有人在说话时压到 400ms 一问，闲下来再退回 2s —— 空转的开销不涨，命令的响应快 5 倍
const HOT_INTERVAL_MS = 400;
const HOT_WINDOW_MS = 8000;

// 去重表落盘的间隔：重启时靠它挡住 newinit 重发出来的旧命令
const SEEN_FLUSH_MS = 20000;

function sleep(ms) {
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

class WeChatClient extends EventEmitter {
    constructor(options) {
        super();
        this.baseUrl = String(options.baseUrl).replace(/\/+$/, "");
        this.timeout = options.timeout || 60000;
        this.dumpRaw = !!options.dumpRaw;
        this.ourWxid = String(options.wxid || "");
        this.ourName = "";
        this.http = axios.create({ baseURL: this.baseUrl, timeout: this.timeout });
        this._seen = new Set();
        this._seenQueue = [];
        this._seenFile = options.seenFile || "";
        this._seenDirty = false;
        if (this._seenFile) this._loadSeen();
        this._pollTimer = null;
        this.rate = Object.assign({}, DEFAULT_RATE, options.rateLimit || {});
        this._sendQueue = [];
        this._draining = false;
        this._tokens = this.rate.burst;
        this._tokenAt = Date.now();
        this._lastSendAtByTarget = new Map();
        this._nameCache = new Map();
        this._roomFetches = new Map();
        this._replayPending = new Map();
        this._friendIds = null;
        // 「最近有没有往来」决定轮询压不压到热间隔。收消息和发消息都算：
        // 刚回完一句说明这个人在连着说话，下一句几秒内就到
        this._lastBusyAt = Date.now();
        if (this.dumpRaw) fs.mkdirSync(RAW_DIR, { recursive: true });
        if (this._seenFile) {
            // 去重表只在内存里的话，每次重启都会把几小时前已经答过的命令再答一遍（newinit 会重发积压）
            const t = setInterval(() => this._saveSeen(), SEEN_FLUSH_MS);
            if (t.unref) t.unref();
        }
    }

    _loadSeen() {
        try {
            const ids = JSON.parse(fs.readFileSync(this._seenFile, "utf8"));
            if (!Array.isArray(ids)) return;
            this._seenQueue = ids.map(String);
            this._seen = new Set(this._seenQueue);
            console.log("已处理消息去重表载入：" + this._seen.size + " 条");
        } catch (err) {
            if (err.code !== "ENOENT") console.error("去重表读取失败（不影响收消息）: " + err.message);
        }
    }

    _saveSeen() {
        if (!this._seenDirty) return;
        this._seenDirty = false;
        try {
            fs.writeFileSync(this._seenFile, JSON.stringify(this._seenQueue), "utf8");
        } catch (err) {
            console.error("去重表写入失败: " + err.message);
        }
    }

    // 所有发送都排成一条队，逐条等间隔，绝不并发
    _enqueueSend(target, isGroup, run) {
        return new Promise((resolve, reject) => {
            this._sendQueue.push({ target, isGroup, run, resolve, reject });
            if (!this._draining) this._drainSendQueue();
        });
    }

    async _drainSendQueue() {
        this._draining = true;
        try {
            while (this._sendQueue.length) {
                const job = this._sendQueue.shift();
                const now = Date.now();
                this._tokens = Math.min(this.rate.burst, this._tokens + (now - this._tokenAt) * this.rate.perMinute / 60000);
                this._tokenAt = now;
                const sinceTarget = now - (this._lastSendAtByTarget.get(job.target) || 0);
                const tokenWait = this._tokens >= 1 ? 0 : Math.ceil((1 - this._tokens) * 60000 / this.rate.perMinute);
                const wait = Math.max(tokenWait, (job.isGroup ? this.rate.groupMs : this.rate.privateMs) - sinceTarget, 0);
                // 排队排到肉眼可见才算查得动「回复慢」：要么队里堆了几条，要么这一条要等三秒以上
                if (this._sendQueue.length >= 3 || wait > 3000) {
                    console.log("发送排队：前面还排 " + this._sendQueue.length + " 条，这条（" +
                        (job.isGroup ? "群" : "私聊") + "）等 " + wait + "ms，额度 " + this._tokens.toFixed(1) + " 个");
                }
                await sleep(wait);
                try {
                    this._tokens -= 1;
                    job.resolve(await job.run());
                } catch (err) {
                    job.reject(err);
                } finally {
                    // 失败的那条同样占用一次额度，不然一直报错时会瞬间把接口打满
                    const after = Date.now();
                    this._tokens = Math.min(this.rate.burst, this._tokens + (after - this._tokenAt) * this.rate.perMinute / 60000);
                    this._tokenAt = after;
                    this._lastSendAtByTarget.set(job.target, after);
                    this._lastBusyAt = after;
                }
            }
        } finally {
            this._draining = false;
        }
    }

    // 这套协议的每个接口都要带 Wxid，统一在这里注入
    async _request(method, apiPath, body, extraQuery, opts) {
        if (!this.ourWxid) throw new Error("缺少 ipad_wxid，机器人不知道自己是谁");
        const data = Object.assign({ Wxid: this.ourWxid }, body || {});
        let json;
        try {
            const res = await this.http.request({
                method,
                url: apiPath,
                data,
                params: extraQuery || {},
                timeout: (opts && opts.timeout) || this.timeout,
            });
            json = res.data;
        } catch (err) {
            const detail = err.response ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
            throw new Error(method + " " + apiPath + " failed: " + detail);
        }
        if (typeof json === "string") {
            try { json = JSON.parse(json); } catch (_) { /* keep as string */ }
        }
        if (this.dumpRaw) {
            const file = path.join(RAW_DIR, apiPath.replace(/[^a-z0-9]+/gi, "_") + ".json");
            fs.writeFileSync(file, JSON.stringify(json, null, 2), "utf8");
        }
        const ok = find(json, ["success", "ok"]);
        const code = find(json, ["code", "errcode", "error_code"]);
        const failed = ok === false || (code !== undefined && Number(code) !== 0 && Number(code) !== 200 && Number(code) !== 10000);
        // tolerate：调用方自己看 Code。有些接口把「这次没东西」也当失败返回（Newinit 就是），
        // 拿 HTTP 错误当异常抛会把正常情况搅成错误日志。
        if (failed && !(opts && opts.tolerate)) {
            const msg = find(json, ["message", "msg", "errmsg", "error"]) || "";
            throw new Error(method + " " + apiPath + " rejected: code=" + code + " " + msg);
        }
        return json;
    }

    // ---------- 身份与在线状态 ----------

    // 服务端没有「列出已登录账号」的接口，wxid 必须由 .env 给出，这里只做校验。
    // 2026-10-24：getprofile CGI 被微信对这个会话单独回 MM_ERR_SESSIONTIMEOUT（其余
    // 接口全正常），改用 GetContractDetail 查自己 —— 同样返回 wxid + 昵称，实测可用。
    async ensureOnline() {
        const json = await this._request("post", "/Friend/GetContractDetail", { Wxid: this.ourWxid, Towxids: this.ourWxid });
        const self = findDeep(json.Data, ["username", "wxid"]);
        if (!self) throw new Error("GetContractDetail 没返回自己的 wxid，登录态可能已失效");
        this.ourWxid = String(self);
        // 群里被 @ 时正文里出现的是昵称而不是 wxid，留着才能识别 atme
        this.ourName = String(findDeep(json.Data, ["nickname", "remark"]) || this.ourWxid);
        return json;
    }

    // 心跳由服务端自己维持（自动二次登录 + 长链接推送），不开的话容器一睡就掉线
    async enableAutoHeartBeat() {
        return this._request("post", "/Login/AutoHeartBeat", {}, { wxid: this.ourWxid });
    }

    // ---------- sending ----------

    sendText(toUser, text, atList) {
        const body = { ToWxid: toUser, Content: String(text), Type: MSG_TYPE.TEXT };
        if (atList && atList.length) body.At = atList.join(AT_SEPARATOR);
        return this._logged("text", toUser, String(text),
            () => this._enqueueSend(toUser, this.isGroup(toUser),
                () => this._request("post", "/Msg/SendTxt", body, null, { timeout: SEND_TIMEOUT })));
    }

    // 服务端源码里这个接口叫 UploadImg，字段叫 Base64（不是 SendImg/ImgData）
    sendImage(toUser, base64) {
        return this._logged("image", toUser, "[图片]",
            () => this._enqueueSend(toUser, this.isGroup(toUser), () =>
                this._request("post", "/Msg/UploadImg", { ToWxid: toUser, Base64: String(base64) }, null,
                    { timeout: SEND_IMAGE_TIMEOUT })));
    }

    // 「没反应」有两种：消息没进来，或者回复根本没发出去。收消息那侧已经有点了，
    // 发送这侧也必须留痕，否则查问题时只能靠猜。
    _logged(kind, toUser, preview, run) {
        const where = (this.isGroup(toUser) ? "群「" : "私聊「") + this.displayName(toUser) + "」";
        return run().then((res) => {
            console.log("已发 " + where + " " + kind + ": " + JSON.stringify(preview.slice(0, 40)));
            return res;
        }, (err) => {
            console.error("发送失败 " + where + " " + kind + ": " + err.message);
            throw err;
        });
    }

    // iPad 协议没有 QQ 的临时消息概念，退化成直接私聊对方。
    // 私聊对象必须先是好友，否则发不出去——斗地主发牌就死在这一步，
    // 所以失败时回群里点名，而不是让牌局静默卡住。
    async sendTempMsg(room, userId, text) {
        try {
            return await this.sendText(userId, text);
        } catch (err) {
            if (!room) throw err;
            return this.sendText(
                room,
                "私聊给 " + this.displayName(userId) + " 发「" + String(text).slice(0, 20) + "」失败了，TA 需要先加机器人为好友。"
            ).catch((err2) => console.error("群里兜底提示也失败: " + err2.message));
        }
    }

    // ---------- receiving ----------

    // 注意：SyncParam.Synckey 在服务端是被注释掉的，游标存在登录态里自动回写，
    // 客户端不要传 cursor，重复轮询即增量。
    // 超时给短一点：服务端这条接口要等微信 mmtls 回包，上游抽风时会挂十几秒，
    // 用默认的 60s 等于收消息整分钟停摆。
    async syncMessages() {
        return this._request("post", "/Msg/Sync", { Scene: 0 }, null, { timeout: SYNC_TIMEOUT });
    }

    // 重新初始化同步会话（/Login/Newinit）。服务端只在 CmdList 非空的分支里才把微信回的
    // 新 SyncKey 写回登录态（models/Msg/sync.go），而空轮询的回包里 KeyBuf 每次都在变
    // （实测两个相隔 6s 的空回包 key 就差一个字节段），也就是微信每次都要换 key，
    // 客户端却一直在用「最后一次有消息时」的那个旧 key 要增量。
    // 旧 key 哪天不被认账，表现就是所有群一起安静下来、过一会儿又自己活过来。
    // newinit 不带 synckey 相当于告诉微信「这个设备重新上线了」，微信会把该会话的
    // CurrentSynckey 更新并写回登录态，同时把积压的消息直接放在这次响应里给回来——
    // 这些消息之后不会再出现在 newsync 里，所以必须自己派发，不能丢。
    // 群里长时间没动静时微信回 Code:-8「失败：未知原因」，那是正常空结果，用 tolerate 拿回来自己判。
    async reinitSync() {
        const json = await this._request("post", "/Login/Newinit", {}, { wxid: this.ourWxid },
            { timeout: SYNC_TIMEOUT, tolerate: true });
        return this.extractMessages(json);
    }

    extractMessages(json) {
        // 没有新消息时服务端返回的 AddMsgs 是 nil，Go 的 omitempty 会把这个键整个省掉。
        // 所以这里不能走容错回退，否则会把 ModContacts 之类的数组当成消息。
        const data = json && json.Data;
        if (!data || !Array.isArray(data.AddMsgs)) return [];
        return data.AddMsgs;
    }

    _isNew(id) {
        if (!id) return true;
        if (this._seen.has(String(id))) return false;
        this._seen.add(String(id));
        this._seenQueue.push(String(id));
        this._seenDirty = true;
        if (this._seenQueue.length > 5000) {
            this._seen.delete(this._seenQueue.shift());
        }
        return true;
    }

    isGroup(id) {
        return /@chatroom$/i.test(String(id || ""));
    }

    parseRoomMembers(sourceXml) {
        if (!sourceXml || typeof sourceXml !== "string") return [];
        const m = sourceXml.match(/<atuserlist>([\s\S]*?)<\/atuserlist>/i);
        if (!m) return [];
        // 微信经常把列表包成 <atuserlist><![CDATA[wxid_a^wxid_b]]></atuserlist>
        const inner = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
        return inner.split(/[\^;,]/).map((x) => x.trim().replace(/^<!\[CDATA\[|\]\]>$/g, "")).filter(Boolean);
    }

    // iPad 协议群消息的正文是「发送者wxid:\n真正的内容」，协议层不拆，谁用谁自己剥。
    // 三处（成事件、回放预筛、丢弃诊断）必须用同一套判据，之前各写一份正则导致
    // 「toEvent 说没前缀、诊断日志说有前缀」，查问题全对在骗人。
    // 两种认法：① 一看就是微信 id 形态（wxid_xxx / xxx@chatroom）的，冒号后可接可不接换行；
    // ② 其它 4~64 位 token 必须「冒号紧跟换行」才算 —— 正文里 "cc:开局"、"12:30 集合"
    // 这种不能被剥，剥完就不以触发前缀开头，命令于是静静没反应。
    _splitGroupPrefix(content) {
        if (typeof content !== "string") return null;
        let m = content.match(/^(wxid_[A-Za-z0-9_@.\-]{1,48}|[A-Za-z0-9_@.\-]{4,64}@(?:chatroom|openim|im)):(?:\r?\n)?([\s\S]*)$/);
        if (m) return { sender: m[1], text: m[2] };
        m = content.match(/^([A-Za-z0-9_@.\-]{4,64}):(?:\r?\n)([\s\S]+)$/);
        return m ? { sender: m[1], text: m[2] } : null;
    }

    // explain：调用方给个空对象，这里把「为什么这条没成事件」写进去。
    // 机器人「没反应」时，日志必须直接说得出原因，不然只能靠猜。
    toEvent(raw, explain) {
        const drop = (why) => { if (explain) explain.reason = why; return null; };
        const from = find(raw, ["FromUser", "fromUser", "StrTalker", "FromUserName", "talker", "ChatRoomName", "roomName"]);
        const to = find(raw, ["ToUserName", "toUser", "ToUsername"]);
        const explicitSender = find(raw, ["ActualSender", "actualSender", "Sender", "SenderUserName", "fromUserNickname"]);
        const msgType = Number(find(raw, ["MsgType", "msgType", "Type", "type"]) || 0);
        let content = find(raw, ["Content", "content", "Msg", "TextContent", "text"]);
        const source = find(raw, ["Source", "source", "MsgSource"]);
        const id = find(raw, ["NewMsgId", "newMsgId", "MsgId", "msgId", "id"]);
        const createTime = this._msgTimeSeconds(raw);
        const nick = find(raw, ["FromNickName", "NickName", "nickName", "Remark", "remark"]);

        if (!from && !explicitSender) return drop("没有 FromUserName 也没有发送者");

        // 群 id 判定：FromUserName 本身是群，或者 ToUserName 是群
        let room = this.isGroup(from) ? from : (this.isGroup(to) ? to : undefined);

        if (from === this.ourWxid || explicitSender === this.ourWxid) return drop("机器人自己发的");

        // iPad 协议群消息的 Content 是 "发送者wxid:\n真正的内容"，协议层不拆。
        // 判据收紧成「冒号后必须紧跟换行」：正文自己就带冒号的（"cc:开局"、"12:30 集合"）
        // 老是被当发送者前缀剥掉，剥完就不以 cc 开头了，命令于是静静没反应。
        let sender = explicitSender;
        if (!sender && room) {
            const split = this._splitGroupPrefix(content);
            if (split) { sender = split.sender; content = split.text; }
        }
        if (!sender && room && typeof source === "string") {
            const um = source.match(/<username>([^<]+@chatroom)<\/username>[\s\S]*?<username>(?!([^<]+@chatroom))([^<]+)<\/username>/i);
            if (um) sender = um[2];
        }
        // 群消息有时就是裸正文，没有「发送者wxid:\n」前缀，也解析不出 <username>。
        // 老逻辑在这种时候整条丢弃，日志实证丢过真命令（"cc#帮助"、被 @ 的提问、"就切换模式了"）。
        // 现在宁可把发送者记成群本身也要让它进派发层：谁说的不知道，最多回一句
        // 「不知道这句是谁说的」，不能装聋。自问自答不会因此出现——机器人自己发的那两条路
        // （FromUserName=自己、前缀=自己）在上面已经拦掉，而它回复的正文本来也不以触发前缀开头。
        // 注意 ToUserName 是机器人自己属于「收到」的正常形态（私聊、群聊都是），不能拿来判回流。
        if (!sender) sender = room || from;
        if (sender === this.ourWxid) return drop("发送者是机器人自己");
        // 去重不能盲用 NewMsgId：接口把它当 JSON 数字返回时是 8.5e18 级的 int64，
        // 双精度在这个量级的最小间隔是上千，两条完全不同的消息会算成同一个 id，
        // 于是新命令被当成「重复消息」吞掉 —— 正是「偶尔发指令没反应」。
        // 只有字符串形式的 id 是无损的；其余情况按「对话+发送者+类型+同一秒+正文」判重复。
        const rawId = find(raw, ["NewMsgId", "newMsgId"]);
        const losslessId = typeof rawId === "string" && rawId ? rawId : null;
        const dedup = [];
        if (losslessId) {
            dedup.push("i|" + losslessId);
            // 群消息另一条通道给的是「群号:消息id」形态，同一条会各来一次，两个键都要认
            if (room) dedup.push("r|" + room + "|" + losslessId);
        } else {
            dedup.push("c|" + (room || from) + "|" + sender + "|" + msgType + "|" + createTime +
                "|" + String(content || "").slice(0, 200));
        }
        if (dedup.some((key) => this._seen.has(key))) return drop("去重表里已有这条");
        dedup.forEach((key) => this._isNew(key));
        if (IGNORED_INcoming_TYPES.includes(msgType)) return drop("类型 " + msgType + " 不生成事件");

        const atList = this.parseRoomMembers(source);
        const atMe = !!room && (!!this._isAtMeText(content) || atList.includes(this.ourWxid));

        const event = {
            type: room ? "group" : "private",
            // 私聊时 room 为空，这里不能落到 to（那是机器人自己），必须落到对话方
            group_id: room || sender,
            sender: { user_id: sender, nick: nick || sender },
            // 群消息查不到发送者时 sender 就是群本身，命令层据此知道「这句话没法算到某个人头上」
            sender_unknown: !!room && sender === room,
            message: this._toSegments(msgType, content),
            atme: atMe,
            msgType: msgType,
            createTime: createTime,
            raw: raw,
            client: this,
        };
        event.reply = (content) => this.reply(event, content);
        return event;
    }

    _isAtMeText(content) {
        if (typeof content !== "string") return false;
        const names = [this.ourWxid, this.ourName].filter(Boolean);
        return names.some((n) => content.indexOf("@" + n) === 0);
    }

    _mask(id) {
        const s = String(id || "");
        return s.length <= 12 ? s : s.slice(0, 8) + "…" + s.slice(this.isGroup(s) ? -9 : -4);
    }

    // 一条原始 AddMsg 为什么没成事件，全压成一行打在控制台，出问题时不用猜
    _describeRaw(raw) {
        const from = find(raw, ["FromUserName"]);
        const to = find(raw, ["ToUserName"]);
        const sender = find(raw, ["ActualSender", "Sender"]);
        const type = Number(find(raw, ["MsgType", "Type"]) || 0);
        const content = String(find(raw, ["Content"]) || "");
        const source = String(find(raw, ["Source", "source", "MsgSource"]) || "");
        const room = this.isGroup(from) ? from : (this.isGroup(to) ? to : null);
        const prefix = this._splitGroupPrefix(content);
        return "MsgType=" + type +
            " talker=" + this._mask(room || from) +
            (sender ? " ActualSender=" + this._mask(sender) : "") +
            (room ? (prefix ? " 前缀发送者=" + this._mask(prefix.sender) : " 没有wxid前缀") : "") +
            " atuserlist=" + (this.parseRoomMembers(source).length) +
            " id=" + (find(raw, ["NewMsgId", "MsgId"]) || "无") +
            " 时间=" + (this._msgTimeSeconds(raw) || "无") +
            " 正文=" + JSON.stringify(content.slice(0, 40));
    }

    // 没成事件的原样落一行到 data/raw/dropped.jsonl（只留最近 300 行）。
    // 光靠上面那行摘要看不出「协议到底在这条消息里给了哪些字段」，
    // 而下一次「指令没反应」要查的就是这个。
    _noteDropped(raw, reason) {
        try {
            const file = path.join(RAW_DIR, "dropped.jsonl");
            let lines = [];
            try { lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean); } catch (_) { /* 第一次没有这个文件 */ }
            lines.push(JSON.stringify({ at: new Date().toISOString(), reason: reason, raw: raw }));
            fs.writeFileSync(file, lines.slice(-300).join("\n") + "\n", "utf8");
        } catch (err) {
            console.error("丢弃消息落盘失败: " + err.message);
        }
    }

    _toSegments(msgType, content) {
        if (typeof content !== "string" || content.length === 0) return [];
        if (msgType === MSG_TYPE.TEXT) return [{ type: "text", text: content }];
        if (msgType === MSG_TYPE.IMAGE) return [{ type: "image", text: content }];
        if (msgType === MSG_TYPE.VOICE) return [{ type: "record", text: content }];
        return [{ type: "other", text: content }];
    }

    reply(event, content) {
        const target = event.type === "group" ? event.group_id : event.sender.user_id;
        if (content && typeof content === "object" && !Array.isArray(content)) {
            if (content.image) return this.sendImage(target, content.image);
            content = content.text || JSON.stringify(content);
        }
        const chunks = this._split(String(content));
        return chunks.reduce((p, c) => p.then(() => this.sendText(target, c)), Promise.resolve());
    }

    // 微信单条文本有长度上限，按 1000 字切开发
    _split(text) {
        const size = 1000;
        const out = [];
        for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
        return out.length ? out : [""];
    }

    startPolling(options) {
        const interval = (options && options.interval) || 2000;
        const hotInterval = Math.min((options && options.hotInterval) || HOT_INTERVAL_MS, interval);
        const stallBase = (options && options.stallFirstMs) || STALL_FIRST_MS;
        let failing = 0;
        this._lastMsgAt = Date.now();
        this._stallAfter = stallBase;
        // hotInterval 是「一轮的周期」而不是「一轮之后的等待」：
        // Msg/Sync 单次往返实测就要 0.35~0.6s（那是微信那边的时间，压不掉），
        // 再固定等 400ms 等于把延迟翻倍，所以热态把已经花掉的时间扣掉、必要时立刻续上
        const busyAgo = () => Date.now() - Math.max(this._lastMsgAt || 0, this._lastBusyAt || 0);
        const nextDelay = (startedAt) => (busyAgo() < HOT_WINDOW_MS
            ? Math.max(0, hotInterval - (Date.now() - startedAt))
            : interval);
        const tick = async () => {
            const startedAt = Date.now();
            let next = nextDelay(startedAt);
            try {
                const json = await this.syncMessages();
                if (this.dumpRaw) {
                    fs.writeFileSync(path.join(RAW_DIR, "Msg_Sync.latest.json"), JSON.stringify(json, null, 2), "utf8");
                }
                const batch = this.extractMessages(json);
                const delivered = this._dispatchBatch(batch);
                // 回放期间一条都不处理，但流量确实在进来，不能把它当成静默
                if (delivered || batch.length) {
                    this._lastMsgAt = Date.now();
                    this._stallAfter = stallBase;
                }
                failing = 0;
                // ContinueFlag=1 是微信明说「还有货没取完」，这时等 2s 就是把命令压在队列里，
                // 群里刷屏时表现为「连着发 cc 都没反应，过一会儿突然全来了」
                const more = Number(findDeep(json, ["continueflag"]) || 0);
                const lag = this._batchLagSeconds(batch);
                if (more === 1 || lag > 3) {
                    next = 0;
                    console.log("消息积压：本批 " + batch.length + " 条，滞后 " + lag + "s，立刻续拉");
                } else {
                    // 一条消息都没了、同步却没报错，就是上面说的「旧 SyncKey 不被认账」那种卡死，
                    // 靠 newsync 自己等不回来，必须重新 newinit
                    const silence = Date.now() - this._lastMsgAt;
                    if (silence > this._stallAfter) {
                        this._stallAfter = Math.min(this._stallAfter * 2, STALL_MAX_MS);
                        this._lastMsgAt = Date.now();
                        console.log("会话已静默 " + Math.round(silence / 1000) + "s，尝试 newinit 重新初始化同步");
                        await this._wakeSession().catch((err) => console.error("newinit 唤醒失败: " + err.message));
                    }
                    next = nextDelay(startedAt);
                }
            } catch (err) {
                failing++;
                console.error("拉取消息失败(" + failing + "): " + err.message);
                if (failing === 10) this.emit("error", new Error("连续 10 次拉取消息失败，可能已掉线"));
                // 实测这类失败基本都是服务端到 short.weixin.qq.com 的间歇超时，
                // 服务端那次没拿到新游标，消息还在那一批里，所以快速重试比退避 10s 好
                next = failing > 10 ? interval * 3 : 300;
            } finally {
                this._pollTimer = setTimeout(tick, next);
            }
        };
        // 先把会话唤醒再开始轮询：卡死的会话就是在这一步被微信重新认账的
        this._wakeSession().catch((err) => console.error("启动时 newinit 唤醒失败: " + err.message))
            .then(() => { this._pollTimer = setTimeout(tick, 0); });
        return this;
    }

    async _wakeSession() {
        const batch = await this.reinitSync();
        const dispatched = this._dispatchBatch(batch);
        if (batch.length) console.log("newinit 捞回 " + batch.length + " 条：派发 " + dispatched + " 条");
        return batch;
    }

    // 消息时间戳统一成「秒」。服务端 MsgType=1 的 CreateTime 给的是毫秒
    // （实测 1787…e9，和 NewRecvAppMsg 里 CommentInfo 的秒级时间戳差三个数量级），
    // 当秒用等于把刚到的新命令算成滞后五万年，整批被压成「回放不回」——
    // 这就是「偶尔 cc 发出去没反应，过一会儿才好」的根因之一。
    _msgTimeSeconds(raw) {
        const t = Number(find(raw, ["CreateTime", "createTime", "MsgCreateTime"]) || 0);
        if (!t) return 0;
        return t > 1e11 ? Math.round(t / 1000) : t;
    }

    // 一批消息里最新一条的滞后秒数，用来判断是不是被积压了
    _batchLagSeconds(batch) {
        let newest = 0;
        for (const raw of batch) {
            const t = this._msgTimeSeconds(raw);
            if (t > newest) newest = t;
        }
        if (!newest) return 0;
        return Math.max(0, Math.round(Date.now() / 1000) - newest);
    }

    // 这一条现在过时多久了
    _ageSeconds(raw, now) {
        const t = this._msgTimeSeconds(raw);
        if (!t) return 0;
        return Math.max(0, (now === undefined ? Math.round(Date.now() / 1000) : now) - t);
    }

    // 单条消息从解析到派发全在这里，任何一条崩了都不能连累同批其余消息：
    // 服务端返回这批时已经把 SyncKey 推过去了，漏掉的就是永久收不到。
    // 一批消息统一从这里进派发。
    // 会话卡死后一次性回放出来的历史消息（实测一唤醒就回 3900+ 条、横跨 2.8 小时）
    // 不能逐条回，等于机器人诈尸刷屏，用户在等的从来只有最新那一句。
    // 但判龄必须逐条：回放批次里混着几条刚到的新命令是常态（唤醒那一秒正好有人发 cc），
    // 按「整批最老那条」判定会把新命令一起压进攒句逻辑，表现就是「cc 发了没反应」。
    _dispatchBatch(batch) {
        if (!batch.length) {
            this._flushReplayPending();
            return 0;
        }
        const now = Math.round(Date.now() / 1000);
        let oldestAge = 0;
        const live = [];
        const replay = [];
        for (const raw of batch) {
            const age = this._ageSeconds(raw, now);
            if (age > oldestAge) oldestAge = age;
            (age > BACKLOG_SECONDS ? replay : live).push(raw);
        }
        if (replay.length) {
            // 回放会横跨几十上百批，每一批都回一条就是刷屏；每个对话只攒「确实是冲机器人
            // 说的」最新那一句（用户连着发的 cc 命令往往不是整批里最新的，全局只留一条会把它吞掉），
            // 等这批里有新鲜消息进来时各回一句
            this._collectAddressed(replay).forEach((cand, key) => {
                const prev = this._replayPending.get(key);
                if (!prev || cand.age <= prev.age) this._replayPending.set(key, cand);
            });
        }
        if (!live.length) {
            console.log("积压回放：" + replay.length + " 条（最老滞后 " + oldestAge + "s），先不回" +
                (this._replayPending.size ? "，攒着 " + this._replayPending.size + " 句冲机器人说的" : ""));
            return 0;
        }
        // 回放攒下的那句和直播消息一起处理，谁先说谁先答
        const flushed = this._flushReplayPending();
        for (const raw of live) this._handleRaw(raw);
        if (replay.length) {
            console.log("积压回放 " + replay.length + " 条不回，同批 " + live.length + " 条新消息照常处理（最老滞后 " + oldestAge + "s）");
        }
        return flushed + live.length;
    }

    // 触发前缀本来只有命令层用；回放预筛在这里也要认，否则「cc#帮助」这种命令
    // 会被当成普通闲聊压掉。判定故意宽松，真正的触发规则还是 message/group.js 说了算
    _isAddressed(raw) {
        const source = String(find(raw, ["Source", "source", "MsgSource"]) || "");
        if (this.parseRoomMembers(source).includes(this.ourWxid)) return true;
        let text = find(raw, ["Content", "content", "Msg", "TextContent", "text"]);
        if (typeof text !== "string") return false;
        // 群消息正文前缀是 "发送者wxid:\n"，被 @ 时开头是 "@昵称 \u2005"，都要剥掉才好比对。
        // 剥前缀的判据与 toEvent 共用 _splitGroupPrefix，两处各写一套正则时
        // 「能不能成事件」和「回放里攒不攒这句」会互相打架，丢了命令也查不出来。
        const split = this._splitGroupPrefix(text);
        if (split) text = split.text;
        text = text.replace(/^@[\s\S]{1,40}?[\s\u2005\u00a0]/, "").trim();
        if (text.startsWith("#")) return true;
        return String(process.env.trigger_prefix || "").split(",")
            .map((s) => s.trim()).filter(Boolean).some((p) => text.startsWith(p));
    }

    _conversationKey(raw) {
        const from = String(find(raw, ["FromUserName", "FromUser", "StrTalker", "talker"]) || "");
        const to = String(find(raw, ["ToUserName", "toUser", "ToUsername"]) || "");
        if (this.isGroup(from) || this.isGroup(to)) return this.isGroup(from) ? from : to;
        // 私聊：机器人自己发出去的那份不算
        if (from === this.ourWxid) return "";
        return from || to;
    }

    _collectAddressed(batch) {
        const picked = new Map();
        const now = Math.round(Date.now() / 1000);
        for (const raw of batch) {
            const key = this._conversationKey(raw);
            if (!key || !this._isAddressed(raw)) continue;
            const t = this._ageSeconds(raw, now);
            const prev = picked.get(key);
            const cand = { raw: raw, age: t };
            if (!prev || cand.age <= prev.age) picked.set(key, cand);
        }
        return picked;
    }

    _flushReplayPending() {
        if (!this._replayPending.size) return 0;
        const pending = [...this._replayPending.values()];
        this._replayPending.clear();
        // 攒下的句子按现在这一刻重新算年龄：排空几千条积压要一两分钟，
        // 采集时还算新鲜的，现在可能早就过了
        pending.forEach((p) => { p.age = this._ageSeconds(p.raw); });
        const fresh = pending.filter((p) => p.age <= REPLY_FRESH_SECONDS);
        const stale = pending.length - fresh.length;
        console.log("回放结束：补回 " + fresh.length + " 句冲机器人说的" +
            (fresh.length ? "（最老滞后 " + Math.max(...fresh.map((p) => p.age)) + "s）" : "") +
            "，其余 " + (pending.length - fresh.length) + " 句旧消息不回" +
            (stale ? "（其中 " + stale + " 句超过 " + Math.round(REPLY_FRESH_SECONDS / 60) + " 分钟，回了就是诈尸）" : ""));
        for (const p of fresh) this._handleRaw(p.raw);
        return fresh.length;
    }

    _handleRaw(raw) {
        let event = null;
        const explain = {};
        try {
            event = this.toEvent(raw, explain);
        } catch (err) {
            console.error("消息解析失败: " + err.message + "\n" + (err.stack || ""));
            return;
        }
        if (!event) {
            const type = Number(find(raw, ["MsgType", "Type"]) || 0);
            // 10000/10002 不是聊天消息，但「被移出群聊」「群改名」「有人退群」恰好是
            // 「这个群突然再也没有消息进来」的原因，这种时候不能一声不吭地丢掉
            if (type === MSG_TYPE.SYSTEM || type === MSG_TYPE.SYSTEM_2) {
                console.log("系统通知: " + this._describeRaw(raw));
            } else if (!IGNORED_INcoming_TYPES.includes(type)) {
                // 机器人「没反应」九成是消息进来了却没成事件，这里必须看得见为什么丢的
                const why = explain.reason || "原因不明";
                console.log("丢弃消息（" + why + "）: " + this._describeRaw(raw));
                this._noteDropped(raw, why);
            }
            return;
        }
        const text = String((event.message.find((m) => m.type === "text") || {}).text || "[" + event.msgType + "]");
        const lag = Math.max(0, Math.round(Date.now() / 1000) - (event.createTime || 0));
        if (event.type === "group") this._rememberRoom(event.group_id);
        // 机器人同时在好几个群里，不写「哪个群」根本查不出是消息没来还是没触发
        const where = event.type === "group" ? "群「" + this.displayName(event.group_id) + "」" : "私聊";
        console.log("收到 " + where + " [" + this.displayName(event.sender.user_id) + "] " +
            JSON.stringify(text.slice(0, 40)) +
            (event.atme ? "  (@我)" : "") +
            "  收信" + lag + "s");
        try {
            this.emit(event.type === "group" ? "message.group" : "message.private", event);
        } catch (err) {
            console.error("消息处理异常(已跳过这一条): " + err.message + "\n" + (err.stack || ""));
        }
    }

    stopPolling() {
        clearTimeout(this._pollTimer);
        this._pollTimer = null;
        return this;
    }

    // ---------- 身份表：群、好友、群成员 ----------

    // 通讯录是分页的：CountinueFlag=1 表示还有下一页，靠两个 seq 游标往前推
    async getContractUserNames(limit) {
        const out = [];
        let seq = 0, roomSeq = 0, guard = 0;
        while (guard++ < 50) {
            const json = await this._request("post", "/Friend/GetContractList", {
                CurrentWxcontactSeq: seq,
                CurrentChatRoomContactSeq: roomSeq,
            });
            const data = json.Data || {};
            const list = data.ContactUsernameList;
            if (Array.isArray(list)) out.push(...list.map(String));
            if (Number(find(data, ["countinueflag", "continueflag"]) || 0) !== 1) break;
            seq = Number(find(data, ["currentwxcontactseq"]) || 0) || seq;
            roomSeq = Number(find(data, ["currentchatroomcontactseq"]) || 0) || roomSeq;
            if (limit && out.length >= limit) break;
        }
        return out;
    }

    async getGroupList() {
        const names = await this.getContractUserNames();
        return names.filter((n) => this.isGroup(n));
    }

    async getFriendList() {
        const names = await this.getContractUserNames();
        return names.filter((n) => !this.isGroup(n) && !/^(medianote|floatbottle|filehelper|newsapp|mmbusiness|weixin|gh_)/i.test(n));
    }

    // 上桌资格：牌只能私聊发，不是好友就收不到。GetContractList 的
    // ContactUsernameList 就是好友+群的合集——群那部分会漏，好友这部分是准的。
    // 名单查出来先缓存；查不到的人要再拉一次：好友是随时会加的，
    // 缓存不刷新的话新加的人永远被判成「不是好友」，上不了桌。
    async isFriend(wxid) {
        const id = String(wxid);
        if (!this._friendIds) {
            await this._refreshFriends();
            return this._friendIds.has(id);
        }
        if (this._friendIds.has(id)) return true;
        // 冷却 3 秒：真不是好友的人反复上桌时，别把通讯录接口打爆
        if (!this._friendFetchedAt || Date.now() - this._friendFetchedAt > 3000) {
            await this._refreshFriends();
        }
        return this._friendIds.has(id);
    }

    async _refreshFriends() {
        this._friendFetchedAt = Date.now();
        try {
            const friends = await this.getFriendList();
            this._friendIds = new Set(friends.map(String));
            console.log("好友名单就绪：" + this._friendIds.size + " 个");
        } catch (err) {
            console.error("拉好友名单失败: " + err.message);
            if (!this._friendIds) this._friendIds = new Set();
        }
    }

    // 群里发言只有 wxid，播报要写名字，所以按需批量取昵称并缓存
    async namesOf(wxids) {
        const missing = [...new Set(wxids)].filter((w) => w && !this._nameCache.has(w));
        if (missing.length) {
            // 只有「请求成功但这个 id 确实不在返回里」才配当成没昵称。
            // 服务端忙的时候这条接口经常 socket hang up，把失败也缓存成 id 本身，
            // 结果群里从此永远显示裸 wxid，再也翻不了身。
            let requestOk = false;
            try {
                const json = await this._request("post", "/Friend/GetContractDetail", { Towxids: missing.join(",") });
                for (const c of findArray(json.Data) || []) {
                    const id = find(c, ["username", "wxid"]);
                    const nick = find(c, ["nickname", "remark", "nick"]) || findDeep(c, ["nickname", "remark"]);
                    if (id) this._nameCache.set(String(id), nick ? String(nick) : String(id));
                }
                requestOk = true;
            } catch (err) {
                console.error("取昵称失败: " + err.message);
            }
            if (requestOk) for (const w of missing) if (!this._nameCache.has(w)) this._nameCache.set(w, w);
        }
        return new Map(wxids.map((w) => [w, this._nameCache.get(w) || w]));
    }

    async nameOf(wxid) {
        const m = await this.namesOf([wxid]);
        return m.get(wxid) || wxid;
    }

    // 群里播报要写名字，但 dou 的命令是同步流程，所以启动时把名字灌进缓存，
    // 之后 displayName() 纯同步查表，查不到就退回 wxid。
    // 首选只灌「自己所在群的成员」：打牌的人必然在群里，四次请求就够，
    // 不必把整个通讯录（几百个 id）都打一遍，服务端被占满会拖挂轮询。
    async preloadRoomNames() {
        const rooms = await this.getGroupList();
        await this.namesOf(rooms);
        for (const room of rooms) {
            try {
                await this.getRoomMemberList(room);
            } catch (err) {
                console.error("拉群成员失败 " + room + ": " + err.message);
            }
        }
        return this._nameCache.size;
    }

    // 通讯录全量预取：只有胜率榜这类历史 id 需要，慢且吃接口，放后台跑
    async preloadNames(onProgress) {
        const names = await this.getContractUserNames();
        const BATCH = 5;
        for (let i = 0; i < names.length; i += BATCH) {
            await this.namesOf(names.slice(i, i + BATCH));
            if (onProgress) onProgress(i + BATCH, names.length);
            await sleep(300);
        }
        return this._nameCache.size;
    }

    displayName(wxid) {
        return this._nameCache.get(String(wxid)) || String(wxid);
    }

    // 通讯录快照里没有的群（刚建的测试群、机器人被拉进去时服务端没同步到联系人），
    // 消息照样收得到，但群名和成员名查不到，播报会退回裸 wxid，
    // 所以见到没处理过的群 id 就后台补一次，一个群只补一次，失败才重试。
    _rememberRoom(room) {
        if (this._roomFetches.get(room)) return;
        this._roomFetches.set(room, true);
        this.namesOf([room]).catch(() => {});
        this.getRoomMemberList(room).then(null, (err) => {
            this._roomFetches.set(room, false);
            console.error("补群成员昵称失败 " + room + ": " + err.message);
        });
    }

    async getRoomMemberList(room) {
        const json = await this._request("post", "/Group/GetChatRoomMemberDetail", { QID: room });
        const arr = findArray(json.Data) || [];
        const members = [];
        for (const c of arr) {
            const id = find(c, ["wxid", "username", "toutusername"]);
            const nick = find(c, ["nickname", "nick", "remark", "name"]);
            if (id) {
                const wxid = String(id);
                this._nameCache.set(wxid, nick ? String(nick) : wxid);
                members.push({ wxid, nick: nick ? String(nick) : wxid });
            }
        }
        return members;
    }
}

module.exports = { WeChatClient, MSG_TYPE, find, findDeep, findArray };
