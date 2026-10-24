"use strict";
// 查「机器人通讯录里那个没名字的群」到底是谁：拿 GetContractDetail 的群名 + 成员。
// 只读接口，不碰 Msg/Sync，可以和轮询并存。
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { client } = require("../app");

(async () => {
    const rooms = await client.getGroupList();
    for (const room of rooms) {
        const name = await client.nameOf(room).catch((e) => "(取名字失败:" + e.message + ")");
        let members = [];
        try {
            members = await client.getRoomMemberList(room);
        } catch (e) {
            console.log(room + " 成员拉取失败: " + e.message);
            continue;
        }
        console.log(room + "  「" + name + "」 成员 " + members.length + " 人");
        if (members.length <= 12) {
            console.log("    " + members.map((m) => m.nick + "(" + m.wxid + ")").join(" / "));
        }
    }
    process.exit(0);
})().catch((e) => { console.error(e.stack); process.exit(1); });
