"use strict";
// 群消息路由断言：cc 前缀、@ 机器人、# 切模式，三条唤起路径都走 message/group.js 的真实监听器。
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { client } = require("../app");
const gameMap = require("../command/dou/gameMap");

const ROOM = "25984985555986107@chatroom";
const BOT = client.ourWxid || "wxid_bot";

const sent = [];
client.sendText = async (to, text) => { sent.push({ to, text }); return { Code: 0 }; };
client.displayName = (wxid) => (wxid === BOT ? "机器人" : "玩家" + String(wxid).slice(-1));
client.isFriend = async () => true;
// 麻将的手牌图走私聊：这两个不打桩就会真的往协议服务端发，测试进程绝不能碰真实会话
client.sendImage = async (to, b64) => { sent.push({ to, text: "[图片]" + String(b64).length }); return { Code: 0 }; };
client.sendTempMsg = async (room, userId, text) => { sent.push({ to: userId, text }); return { Code: 0 }; };

function makeEvent(userId, text, atme) {
    const out = [];
    return {
        type: "group",
        group_id: ROOM,
        sender: { user_id: userId, nick: userId },
        message: [{ type: "text", text }],
        atme: !!atme,
        client,
        // 军棋/麻将的盘面是 {image: base64}，不认的话群里就只剩空串，断言看不见出图。
        // 真实 client.reply 返回 Promise，这里也必须返回，否则 .catch/await 的写法测不出来
        reply: (c) => { out.push(typeof c === "string" ? c : (c && c.text) || (c && c.image ? "[图片]" + String(c.image).length : "")); return Promise.resolve(); },
        out,
    };
}

let failed = 0;
function check(label, cond, extra) {
    if (!cond) failed++;
    console.log((cond ? "  ok   " : "  FAIL ") + label + (cond ? "" : "  → " + extra));
}

async function fire(userId, text, atme) {
    const ev = makeEvent(userId, text, atme);
    client.emit("message.group", ev);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 30));
    return ev.out;
}

(async () => {
    gameMap.delete(ROOM);

    check("cc斗地主 → 建局", (await fire("wxid_p1", "cc斗地主")).some((t) => t.includes("欢迎来到")));
    check("不带前缀的普通聊天不触发", (await fire("wxid_p1", "今晚吃啥")).length === 0);
    check("@机器人 上桌 → 第二人",
        (await fire("wxid_p2", "@" + BOT + " 上桌", true)).some((t) => t.includes("当前游戏人数：2")));
    check("#帮助 不需要前缀就能问", (await fire("wxid_p3", "#帮助")).some((t) => t.includes("模式：")));
    check("#gpt 这种不存在的模式会被拒", (await fire("wxid_p3", "#gpt")).some((t) => t.includes("不存在该模式")));
    const sw = await fire("wxid_p3", "#小功能");
    check("#小功能 切模式成功", sw.some((t) => t.includes("切换到小功能模式")));
    check("切到小功能后 cc斗地主 不再建局", (await fire("wxid_p3", "cc斗地主")).every((t) => !t.includes("欢迎来到")));
    check("#斗地主 切回来", (await fire("wxid_p3", "#斗地主")).some((t) => t.includes("切换到斗地主模式")));
    check("cc上桌 恢复斗地主路由", (await fire("wxid_p4", "cc上桌")).some((t) => t.includes("人数")));

    // 用户报的两件事：cc#帮助 要出帮助，五子棋模式要能路由
    const help1 = await fire("wxid_p3", "#帮助");
    check("#帮助 给模式清单", help1.some((t) => t.includes("可切换")), JSON.stringify(help1));
    check("#帮助 提示可以看单个模式", help1.some((t) => t.includes("#帮助 五子棋")), JSON.stringify(help1));
    check("cc#帮助 和 #帮助 一样", (await fire("wxid_p3", "cc#帮助")).some((t) => t.includes("可切换")));
    check("@机器人 #帮助 也认", (await fire("wxid_p3", "@" + BOT + " #帮助", true)).some((t) => t.includes("可切换")));
    check("#帮助 五子棋 只回五子棋玩法", (await fire("wxid_p3", "#帮助 五子棋")).some((t) => t.includes("cc3,8") && !t.includes("斗地主】")));
    check("#帮助 斗地主 说清抢地主", (await fire("wxid_p3", "#帮助 斗地主")).some((t) => t.includes("谁先抢谁当地主")));
    check("#模式 查当前模式", (await fire("wxid_p3", "#模式")).some((t) => t.includes("当前模式")));
    check("#打麻将 这种不存在的模式被拒", (await fire("wxid_p3", "#打麻将")).some((t) => t.includes("不存在该模式")));
    // 用户报的「切换麻将说模式不存在」：麻将已经是合法模式，牌局进行中只会拦切换，不会说不存在
    const swM = await fire("wxid_p3", "#麻将");
    check("#麻将 是合法模式（这里只是被进行中的牌局拦下）",
        swM.length > 0 && swM.every((t) => !t.includes("不存在该模式") && t.includes("还在进行中")), JSON.stringify(swM));

    // 此刻斗地主已经满三人进入抢地主阶段（status=1），切模式必须先结束
    const blocked = await fire("wxid_p3", "#五子棋");
    check("牌局进行中拒绝切模式", blocked.some((t) => t.includes("还在进行中")), JSON.stringify(blocked));
    await fire("wxid_p1", "cc结束");
    const sw5 = await fire("wxid_p3", "#五子棋");
    check("#五子棋 切模式成功", sw5.some((t) => t.includes("切换到五子棋模式")), JSON.stringify(sw5));
    const g1 = await fire("wxid_p1", "cc五子棋");
    check("五子棋模式下 cc五子棋 开局", g1.some((t) => t.includes("五子棋")), JSON.stringify(g1));
    check("五子棋模式下 cc斗地主 不再建局", (await fire("wxid_p9", "cc斗地主")).every((t) => !t.includes("欢迎来到")));
    require("../command/gomoku/gomokuIndex").games.delete(ROOM);

    // 军棋：#军棋 能切、能路由到 junqiIndex，帮助里也列得出来
    check("#帮助 列出军棋", (await fire("wxid_p3", "#帮助")).some((t) => t.includes("#军棋")));
    check("#帮助 军棋 只回军棋玩法",
        (await fire("wxid_p3", "#帮助 军棋")).some((t) => t.includes("cc走B7-C7") && !t.includes("斗地主】")));
    const swj = await fire("wxid_p3", "#军棋");
    check("#军棋 切模式成功", swj.some((t) => t.includes("切换到军棋模式")), JSON.stringify(swj));
    const j1 = await fire("wxid_p1", "cc军棋");
    check("军棋模式下 cc军棋 上桌", j1.some((t) => t.includes("上桌") || t.includes("好友")), JSON.stringify(j1));
    check("军棋模式下 cc五子棋 不再开局",
        (await fire("wxid_p9", "cc五子棋")).every((t) => !t.includes("黑棋先手")), JSON.stringify(j1));
    require("../command/junqi/junqiIndex").games.delete(ROOM);

    // 麻将：#麻将 能切、cc麻将 能上桌、cc开局 能发牌并出图，帮助里也列得出来
    check("#帮助 列出麻将", (await fire("wxid_p3", "#帮助")).some((t) => t.includes("#麻将")));
    check("#帮助 麻将 只回麻将玩法",
        (await fire("wxid_p3", "#帮助 麻将")).some((t) => t.includes("cc5m立直") && !t.includes("斗地主】")));
    const swm = await fire("wxid_p3", "#麻将");
    check("#麻将 切模式成功", swm.some((t) => t.includes("切换到麻将模式")), JSON.stringify(swm));
    const m1 = await fire("wxid_p1", "cc麻将");
    check("麻将模式下 cc麻将 上桌", m1.some((t) => t.includes("上桌")), JSON.stringify(m1));
    const m2 = await fire("wxid_p1", "cc开局");
    check("麻将模式下 cc开局 发牌并贴盘面图",
        m2.some((t) => t.includes("开局") || t.includes("定缺")) && m2.some((t) => t.startsWith("[图片]")), JSON.stringify(m2));
    check("麻将模式下 cc军棋 不再上桌",
        (await fire("wxid_p9", "cc军棋")).every((t) => !t.includes("上桌")), JSON.stringify(m2));
    require("../command/mahjong/mahjongIndex").games.delete(ROOM);

    gameMap.delete(ROOM);
    console.log(failed ? "\n" + failed + " 条失败" : "\n全部通过");
    process.exit(failed ? 1 : 0);
})().catch((err) => { console.error("崩了: " + err.stack); process.exit(1); });
