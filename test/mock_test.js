"use strict";

// node test/mock_test.js
// iwechat 是闭源二进制，这个测试用一个假的服务端钉住 wechat/client.js 的行为：
// 群/私聊分流、@ 检测、去重、自发消息过滤、回复路由、超长分段。

const http = require("http");
const assert = require("assert");
const { WeChatClient } = require("../wechat/client");

const ME = "wxid_bot";
const sent = [];
let active = 0;
let maxActive = 0;

const BASE = [
    { FromUser: "wxid_alice", ToUserName: ME, MsgType: 1, Content: "私聊你好", CreateTime: 1, NewMsgId: "a1" },
    { FromUser: "12345@chatroom", ToUserName: ME, ActualSender: "wxid_bob", MsgType: 1, Content: "@测试机器人 群里有我", CreateTime: 2, NewMsgId: "g1", Source: "<msgsource><atuserlist>" + ME + "</atuserlist></msgsource>" },
    { FromUser: "12345@chatroom", ToUserName: ME, ActualSender: "wxid_carol", MsgType: 1, Content: "没 at 我", CreateTime: 3, NewMsgId: "g2", Source: "<msgsource></msgsource>" },
    { FromUser: ME, ToUserName: "wxid_alice", MsgType: 1, Content: "我自己发的", CreateTime: 4, NewMsgId: "s1" },
];

const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
        const url = req.url.split("?")[0];
        const isSend = url.startsWith("/message/Send");
        if (isSend) { active++; if (active > maxActive) maxActive = active; }
        res.on("finish", () => { if (isSend) active--; });
        const json = (obj) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(obj));
        };
        if (url === "/login/GetLoginStatus") return json({ success: true, data: { wxid: ME, online: true } });
        if (url === "/message/HttpSyncMsg") return json({ success: true, data: { list: BASE.map((m) => Object.assign({}, m)) } });
        if (url === "/message/SendTextMessage") {
            (JSON.parse(body || "{}").MsgItem || []).forEach((i) => sent.push({ to: i.ToUserName, text: i.TextContent, at: Date.now() }));
            return json({ success: true, data: {} });
        }
        if (url === "/message/SendImageMessage") {
            sent.push({ to: JSON.parse(body).MsgItem[0].ToUserName, image: true });
            return json({ success: true });
        }
        json({ success: false, message: "not mocked: " + url });
    });
});

function dispatch(client, json) {
    for (const raw of client.extractMessages(json)) {
        const ev = client.toEvent(raw);
        if (ev) client.emit(ev.type === "group" ? "message.group" : "message.private", ev);
    }
}

server.listen(18849, async () => {
    const client = new WeChatClient({ baseUrl: "http://127.0.0.1:18849", key: "test", rateLimit: { globalMs: 0, privateMs: 0, groupMs: 0 } });
    const events = [];
    client.on("message.private", (e) => events.push(e));
    client.on("message.group", (e) => events.push(e));

    const st = await client.getLoginStatus();
    assert.ok(client.isLoggedIn(st), "应识别为已登录");
    assert.strictEqual(client.ourWxid, ME, "应解析出自己的 wxid");

    dispatch(client, await client.syncMessages(10));
    assert.strictEqual(events.length, 3, "4 条里过滤掉自己发的应剩 3 条，实收 " + events.length);
    assert.strictEqual(events[0].type, "private");
    assert.strictEqual(events[0].sender.user_id, "wxid_alice");
    assert.strictEqual(events[1].type, "group");
    assert.strictEqual(events[1].group_id, "12345@chatroom");
    assert.strictEqual(events[1].sender.user_id, "wxid_bob");
    assert.strictEqual(events[1].atme, true, "群里 @ 我应被识别");
    assert.strictEqual(events[2].atme, false, "没 @ 我的群消息不该算 atme");

    const before = events.length;
    const prevSeen = client._seen.size;
    dispatch(client, await client.syncMessages(10));
    assert.strictEqual(events.length, before, "同一批消息重复拉取应被去重");
    assert.strictEqual(client._seen.size, prevSeen, "去重集合不应重复累积");
    // 下面用直接调用（非事件监听）来验证另一套协议方言，不影响 events

    await events[0].reply("回私聊");
    assert.strictEqual(sent[0].to, "wxid_alice", "私聊回复应发给发送者");
    await events[1].reply("回群里");
    assert.strictEqual(sent[1].to, "12345@chatroom", "群回复应发给群 id");

    await events[0].reply("x".repeat(2500));
    assert.deepStrictEqual([sent[2].text.length, sent[3].text.length, sent[4].text.length], [1000, 1000, 500], "超长文本按 1000 字分段");

    await events[0].reply({ image: "Zm9v" });
    assert.strictEqual(sent[5].image, true, "对象形式的回复应走图片接口");

    await client.sendTempMsg("12345@chatroom", "wxid_bob", "您的牌是：");
    assert.strictEqual(sent[6].to, "wxid_bob", "临时消息退化成私聊发送（斗地主命令依赖）");

    // 另一种 ipad 协议方言（openchat/mmtls 系）：信封是 {Success,Code:0,Data}，
    // 消息数组叫 AddMsgs，字符串字段是 SKBuiltinStringT 包装对象，群消息的发送者藏在 Content 前缀里。
    const wrapped = {
        Success: true, Code: 0, Message: "", Data: { AddMsgs: [
            { MsgId: 1, FromUserName: { string: "wxid_dave" }, ToUserName: { string: ME }, Content: { string: "包装字段私聊" }, CreateTime: 10, MsgType: 1, NewMsgId: 101 },
            { MsgId: 2, FromUserName: { string: "9999@chatroom" }, ToUserName: { string: ME }, Content: { string: "wxid_erin:\n群里前缀里的发送者" }, CreateTime: 11, MsgType: 1, NewMsgId: 102, MsgSource: "<msgsource><atuserlist>" + ME + "</atuserlist></msgsource>" },
        ] },
    };
    const wrappedMsgs = client.extractMessages(wrapped);
    assert.strictEqual(wrappedMsgs.length, 2, "应从 AddMsgs 取到 2 条消息");
    const w0 = client.toEvent(wrappedMsgs[0]);
    assert.strictEqual(w0.type, "private", "包装字段应能解析出私聊");
    assert.strictEqual(w0.sender.user_id, "wxid_dave", "应解开 {string:...} 拿到发送者");
    assert.strictEqual(w0.message[0].text, "包装字段私聊", "应解开 {string:...} 拿到正文");
    const w1 = client.toEvent(wrappedMsgs[1]);
    assert.strictEqual(w1.group_id, "9999@chatroom", "群 id 应来自 FromUserName");
    assert.strictEqual(w1.sender.user_id, "wxid_erin", "群消息发送者应从 Content 的 wxid: 前缀拆出来");
    assert.strictEqual(w1.message[0].text, "群里前缀里的发送者", "拆出的正文不应再带发送者前缀");
    assert.strictEqual(w1.atme, true, "MsgSource 里的 atuserlist 应被识别");

    // 官方硬性规范：全局约 40 条/分钟、同一私聊 >=1s、同一群 2~5s，且禁止并发调发送接口。
    // 这里用缩小的间隔验证排队逻辑本身：顺序不乱、不并发、失败不卡队。
    const rl = new WeChatClient({ baseUrl: "http://127.0.0.1:18849", key: "test", rateLimit: { globalMs: 60, privateMs: 45, groupMs: 30 } });
    const sentBefore = sent.length;
    const t0 = Date.now();
    await Promise.all([
        rl.sendText("wxid_a", "1"), rl.sendText("wxid_a", "2"),
        rl.sendText("111@chatroom", "3"), rl.sendText("wxid_a", "4"),
    ]);
    const burst = sent.slice(sentBefore);
    assert.strictEqual(burst.length, 4, "并发提交 4 条应全部发出，一条不丢");
    assert.deepStrictEqual(burst.map((s) => s.text), ["1", "2", "3", "4"], "发送顺序必须等于提交顺序");
    assert.strictEqual(maxActive, 1, "发送接口必须串行，任何时刻只允许 1 个在飞");
    for (let i = 1; i < burst.length; i++) {
        assert.ok(burst[i].at - burst[i - 1].at >= 45, "相邻两条必须留出限速间隔，实测 " + (burst[i].at - burst[i - 1].at) + "ms");
    }
    assert.ok(Date.now() - t0 >= 170, "4 条至少要占用 3 个全局间隔");

    await assert.rejects(() => rl.sendVoice("wxid_a", "Zm9v", 2), /SendVoice/, "未实现的接口应把错误抛给调用方");
    await rl.sendText("wxid_a", "失败之后还能发");
    assert.strictEqual(sent[sent.length - 1].text, "失败之后还能发", "一条发送失败不该把后续消息卡在队列里");

    server.close();
    console.log("全部通过：登录识别 / 群与私聊分流 / @检测 / 去重 / 自发消息过滤 / 回复路由 / 分段 / 图片 / 临时消息 / 串行限速");
});
