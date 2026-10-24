"use strict";
// 每个群到底拉到了谁——「发了没反应」先确认机器人是不是真在这个群里
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { WeChatClient } = require("../wechat/client");

const client = new WeChatClient({
    baseUrl: process.env.ipad_base_url || "http://127.0.0.1:8058/api",
    wxid: process.env.ipad_wxid,
    timeout: 30000,
});

(async () => {
    await client.ensureOnline();
    const rooms = await client.getGroupList();
    console.log("机器人在的群：" + rooms.length + " 个");
    for (const r of rooms) {
        const name = (await client.namesOf([r])).get(r);
        let members = [];
        let err = "";
        try {
            members = await client.getRoomMemberList(r);
        } catch (e) {
            err = e.message;
        }
        const who = members.slice(0, 14).map((m) => m.nick).join("、");
        console.log("「" + (name || "(无名)") + "」成员 " + members.length +
            (err ? " 拉取失败: " + err : "") + (who ? "\n    " + who : ""));
        const needle = process.argv[2];
        if (needle && members.some((m) => String(m.nick).includes(needle))) {
            console.log("    ↑ 这里有「" + needle + "」");
        }
    }
    process.exit(0);
})().catch((e) => {
    console.error("失败: " + e.message);
    process.exit(1);
});
