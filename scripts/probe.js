"use strict";

// 探测真实字段名：node scripts/probe.js
// iwechat 是闭源二进制，swagger 里没写响应结构，所以第一次登录后要跑一次这个脚本，
// 把真实返回贴给我（或看 data/raw/），我再把 wechat/client.js 的字段映射钉死。
require("dotenv").config();
const { WeChatClient } = require("../wechat/client");

const client = new WeChatClient({
    baseUrl: process.env.iwechat_base_url || "http://127.0.0.1:8849",
    key: process.env.iwechat_key,
});

function show(label, obj) {
    console.log("\n===== " + label + " =====");
    console.log(JSON.stringify(obj, null, 2).slice(0, 3000));
}

(async () => {
    show("GetLoginStatus", await client.getLoginStatus().catch((e) => e.message));
    show("CheckLoginStatus", await client.checkLoginStatus().catch((e) => e.message));
    show("HttpSyncMsg", await client.syncMessages(5).catch((e) => e.message));
    const groups = await client.getGroupList().catch(() => []);
    show("GroupList (前3条)", groups.slice(0, 3));
    show("解析后的事件 (前5条)", client.extractMessages(await client.syncMessages(5).catch(() => ({}))).slice(0, 5).map((r) => client.toEvent(r)));
    console.log("\n原始响应已写到 data/raw/ 目录，逐接口一个文件。");
})();
