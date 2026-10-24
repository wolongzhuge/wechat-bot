"use strict";
// 机器人小号到底在哪些群里、每个群多少人——「没反应」先排这个，再排代码
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
    const rooms = await client.getGroupList();
    console.log("机器人在的群：共 " + rooms.length + " 个");
    for (const r of rooms) {
        const names = await client.namesOf([r]);
        let members = [];
        try { members = await client.getRoomMemberList(r); } catch (err) { console.log("  拉成员失败: " + err.message); }
        // 群 id 只是数字串，不是凭据，但也没必要整串打出来
        console.log("  「" + (names.get(r) || "(无名)") + "」 成员 " + members.length + " 人  id=" + r.replace(/@chatroom$/, "…@chatroom"));
    }
    process.exit(0);
})().catch((e) => { console.error("失败: " + e.message); process.exit(1); });
