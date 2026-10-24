"use strict";
// 新传输层的联调自检：不启动机器人，只验证收发与 ID 三件事是否真的通。
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { WeChatClient } = require("../wechat/client");

const client = new WeChatClient({
    baseUrl: process.env.ipad_base_url || "http://127.0.0.1:8058/api",
    wxid: process.env.ipad_wxid,
    timeout: 60000,
    dumpRaw: true,
});

function mask(s) {
    s = String(s || "");
    return s.length <= 8 ? s : s.slice(0, 6) + "****" + s.slice(s.indexOf("@chatroom") >= 0 ? -9 : -2);
}
function text(ev) {
    return (ev.message || []).filter((m) => m.type === "text").map((m) => m.text).join("").slice(0, 24);
}

(async () => {
    console.log("1) 校验登录态 …");
    await client.ensureOnline();
    console.log("   ok，wxid = " + mask(client.ourWxid));

    console.log("2) 开自动心跳 …");
    await client.enableAutoHeartBeat();
    console.log("   ok");

    console.log("3) ID 表 …");
    const friends = await client.getFriendList();
    const rooms = await client.getGroupList();
    console.log("   好友 " + friends.length + " 个，群 " + rooms.length + " 个");
    console.log("   群 id 样例: " + rooms.slice(0, 3).map(mask).join(" / "));
    if (friends.length) console.log("   昵称样例: " + (await client.nameOf(friends[0])));

    console.log("4) 拉一次 Sync，看能不能归一化成事件 …");
    const json = await client.syncMessages();
    const raws = client.extractMessages(json);
    const events = [];
    for (const raw of raws) {
        const ev = client.toEvent(raw);
        if (ev) events.push(ev);
    }
    console.log("   AddMsgs=" + raws.length + " 归一化事件=" + events.length);
    for (const ev of events.slice(0, 5)) {
        console.log("   - " + ev.type + " from=" + mask(ev.sender.user_id) + " atme=" + ev.atme + " 内容=" + JSON.stringify(text(ev)));
    }

    console.log("5) 发一条到文件传输助手 …");
    const r = await client.sendText("filehelper", "新传输层自检 " + new Date().toLocaleTimeString());
    console.log("   ok: Code=" + (r && r.Code));

    console.log("\n全部通过。");
    process.exit(0);
})().catch((err) => {
    console.error("失败: " + err.message);
    process.exit(1);
});
