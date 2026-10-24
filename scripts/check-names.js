"use strict";
// 验证：多 wxid 的昵称批量取法、启动预取、以及空消息时不再误报
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { WeChatClient } = require("../wechat/client");

const client = new WeChatClient({
    baseUrl: process.env.ipad_base_url || "http://127.0.0.1:8058/api",
    wxid: process.env.ipad_wxid,
    timeout: 60000,
});

(async () => {
    await client.ensureOnline();

    const friends = await client.getFriendList();
    console.log("好友数:", friends.length);

    const three = friends.slice(0, 3);
    const m = await client.namesOf(three);
    console.log("批量取 3 个昵称（Towxids 用逗号）:");
    for (const w of three) console.log("   " + w.slice(0, 6) + "**** -> " + JSON.stringify(m.get(w)));

    console.log("全部预取 …");
    const n = await client.preloadNames();
    console.log("   缓存 " + n + " 个名字");
    console.log("   同步查表: " + client.displayName(three[0]) + " / 未知 id 回退: " + client.displayName("wxid_notexist_zzz"));

    console.log("再拉一次 Sync（应无新增或全为 AddMsgs）…");
    const json = await client.syncMessages();
    console.log("   Message=" + json.Message + " AddMsgs=" + client.extractMessages(json).length);
    process.exit(0);
})().catch((e) => { console.error("失败:", e.message); process.exit(1); });
