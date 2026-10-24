"use strict";
// 诊断：每条 AddMsg 到底为什么没变成事件
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { WeChatClient, MSG_TYPE, find } = require("../wechat/client");

const client = new WeChatClient({
    baseUrl: process.env.ipad_base_url || "http://127.0.0.1:8058/api",
    wxid: process.env.ipad_wxid,
    timeout: 60000,
});

function mask(s) {
    s = String(s || "");
    if (!s) return "(空)";
    return s.length <= 8 ? s : s.slice(0, 6) + "****" + (s.includes("@chatroom") ? s.slice(-9) : s.slice(-3));
}

(async () => {
    await client.ensureOnline();
    const json = await client.syncMessages();
    console.log("Message:", json.Message);
    const raws = client.extractMessages(json);
    console.log("AddMsgs:", raws.length);
    const why = {};
    const types = {};
    for (const raw of raws) {
        const msgType = Number(find(raw, ["MsgType", "Type"]) || 0);
        types[msgType] = (types[msgType] || 0) + 1;
        const from = find(raw, ["FromUserName"]);
        const to = find(raw, ["ToUserName"]);
        const ev = client.toEvent(raw);
        if (ev) { why["→ 事件"] = (why["→ 事件"] || 0) + 1; continue; }
        let reason;
        if (from === client.ourWxid || to === client.ourWxid) reason = "自己发的/发给自己的";
        else if ([MSG_TYPE.SYNC_NOTICE, MSG_TYPE.SYSTEM, MSG_TYPE.FRIEND_REQUEST].includes(msgType)) reason = "类型 " + msgType + " 被过滤";
        else if (client.isGroup(from) || client.isGroup(to)) {
            const c = find(raw, ["Content"]);
            reason = "群消息但没提取到发送者（Content 开头: " + JSON.stringify(String(c || "").slice(0, 24)) + "）";
        } else reason = "其它";
        why[reason] = (why[reason] || 0) + 1;
        if (reason.startsWith("群消息") && (why[reason] === 1)) {
            console.log("  样本 MsgSource:", JSON.stringify(String(find(raw, ["MsgSource"]) || "").slice(0, 160)));
        }
    }
    console.log("MsgType 分布:", JSON.stringify(types));
    console.log("被丢弃原因:");
    for (const [k, v] of Object.entries(why)) console.log("   " + v + " × " + k);

    console.log("\n重发一次 SendTxt（看刚才的 RST 是不是偶发）…");
    try {
        const r = await client.sendText("filehelper", "传输层诊断 " + new Date().toLocaleTimeString());
        console.log("   ok Code=" + r.Code + " " + r.Message);
    } catch (err) {
        console.log("   仍然失败: " + err.message);
    }
    process.exit(0);
})().catch((e) => { console.error("失败:", e.message); process.exit(1); });
