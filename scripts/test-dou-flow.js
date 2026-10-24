"use strict";
// 斗地主离线全流程：把发送层换成记账，验证「唤起方式 + 牌局逻辑」没被改动搞坏，
// 并且群里播报的是昵称、私聊发牌用的是 wxid。
// 牌局逻辑对齐 qiubinyong/doudizhu：满三人立刻发牌 → 轮流 抢/不抢 →
// 谁先抢谁立刻当地主并拿三张底牌 → 地主先出。没有反抢、没有倍数。
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { client } = require("../app");
const { getDouCommand } = require("../command/dou/douIndex");
const gameMap = require("../command/dou/gameMap");

const ROOM = "25984985555986107@chatroom";
const A = "wxid_player_aaa";
const B = "wxid_player_bbb";
const C = "wxid_player_ccc";
const NAMES = { [A]: "张三", [B]: "李四", [C]: "王五" };

// 只替换发送、查名与好友判定，命令本身照常跑
const sent = [];
client.sendText = async (to, text) => { sent.push({ to, text }); return { Code: 0 }; };
client.displayName = (wxid) => NAMES[wxid] || String(wxid);
client.isFriend = async () => true;

function ev(userId) {
    const out = [];
    return {
        group_id: ROOM,
        sender: { user_id: userId },
        reply: (c) => out.push(typeof c === "string" ? c : (c && c.text) || ""),
        out,
    };
}

let failed = 0;
function check(label, cond, extra) {
    if (!cond) failed++;
    console.log((cond ? "  ok   " : "  FAIL ") + label + (cond || extra === undefined ? "" : "  → " + extra));
}

async function newTable() {
    gameMap.delete(ROOM);
    await getDouCommand(ev(A), "斗地主");
    await getDouCommand(ev(B), "上桌");
    await getDouCommand(ev(C), "上桌");
    return gameMap.get(ROOM);
}

(async () => {
    // 跑完会写胜率榜，测试数据不能留在 data 里
    const fs = require("fs");
    const recordFile = path.join(__dirname, "..", "data", "userRecords.json");
    fs.rmSync(recordFile, { force: true });

    gameMap.delete(ROOM);

    const e1 = ev(A);
    await getDouCommand(e1, "斗地主");
    check("cc斗地主 → 建局并拉创建者上桌", e1.out.some((t) => t.includes("欢迎来到")), e1.out.join("|"));

    const e2 = ev(B);
    await getDouCommand(e2, "上桌");
    check("上桌 → 第二人", e2.out.some((t) => t.includes("当前游戏人数：2")), e2.out.join("|"));

    // 非好友上桌：牌是私聊发的，非好友直接拒掉，别让牌局开成死局
    client.isFriend = async (id) => id !== C;
    const eReject = ev(C);
    await getDouCommand(eReject, "上桌");
    check("非好友上桌被拒并说明原因",
        eReject.out.some((t) => t.includes("好友") && t.includes("私聊")),
        eReject.out.join("|"));
    check("被拒的人没坐上桌", gameMap.get(ROOM).players.length === 2,
        gameMap.get(ROOM).players.length + " 人在桌上");
    client.isFriend = async () => true;

    const e3 = ev(C);
    await getDouCommand(e3, "上桌");
    const game = gameMap.get(ROOM);
    check("第三人上桌即开局", !!game && game.players.length === 3 && game.status === 1);

    // 满三人这一刻就要发牌：三人各自拿到私聊牌，且发给的是 wxid 不是昵称
    const deals = sent.filter((s) => s.text.startsWith("您的牌是："));
    check("满三人立刻私聊发牌 3 份，目标是 wxid",
        deals.length === 3 && deals.every((d) => NAMES[d.to] && d.text.length > 20),
        JSON.stringify(deals.map((d) => d.to)));
    check("发完牌群里宣布抢地主并点名先表态的人",
        e3.out.some((t) => t.includes("发牌完毕") && t.includes("抢地主")),
        e3.out.join("|"));
    check("播报里出现的是昵称不是 wxid",
        [...e1.out, ...e2.out, ...e3.out].every((t) => !t.includes("wxid_player")),
        [...e3.out].join("|"));

    // 抢地主：谁先抢谁立刻当地主，当场拿三张底牌，直接进入出牌阶段
    const first = game.getCurrentPlayer();
    const e = ev(first.id);
    getDouCommand(e, "y");
    check("第一个抢 → 立刻定地主，没有候选、没有反抢",
        game.landlord === first && game.status === 2 && game.isRobLandlord === false,
        "landlord=" + (game.landlord && game.landlord.name) + " status=" + game.status);
    check("抢到的那一刻三张底牌就并进手牌", first.cards.length === 20, "cards=" + first.cards.length);
    check("地主手牌私聊发出", sent.some((s) => s.to === first.id && s.text.startsWith("您是地主")),
        JSON.stringify(sent.slice(-3).map((s) => s.to)));
    check("群里公示地主和底牌", e.out.some((t) => t.includes("底牌是：") && t.includes(first.name)), e.out.join("|"));
    check("地主先出", game.getCurrentPlayer().id === first.id);

    // 出牌阶段：乱出必须被规则挡住，跳过要播报昵称
    const wrong = ev(game.getCurrentPlayer().id);
    getDouCommand(wrong, "zzz");
    check("乱出牌被拒", wrong.out.some((t) => t.includes("不符合规则")), wrong.out.join("|"));

    const pass = ev(game.getCurrentPlayer().id);
    getDouCommand(pass, "过");
    check("跳过播报用昵称，没有裸 wxid",
        pass.out.every((t) => !t.includes("wxid_player")) && pass.out.some((t) => /张三|李四|王五/.test(t)),
        pass.out.join("|"));

    // 非当前玩家出牌必须挡在门外（这是牌局逻辑，不能因为改昵称而松动）
    const outsider = game.players.find((p) => p.id !== game.getCurrentPlayer().id);
    const early = ev(outsider.id);
    getDouCommand(early, "过");
    check("未到出手的玩家被拒", early.out.some((t) => t.includes("未到您")), early.out.join("|"));

    // 投降路径
    const sur = ev(game.getCurrentPlayer().id);
    getDouCommand(sur, "投降");
    check("投降播报用昵称且牌局已清理",
        sur.out.every((t) => !t.includes("wxid_player")) && !gameMap.get(ROOM),
        sur.out.join("|"));

    // 三个人都不抢 → 重新发牌
    const g2 = await newTable();
    const handBefore = g2.players.map((p) => p.cards.join("")).join("|");
    for (let i = 0; i < 3; i++) getDouCommand(ev(g2.getCurrentPlayer().id), "n");
    check("三人都不抢 → 回到抢地主阶段且没定地主",
        g2.status === 1 && !g2.landlord && g2.isRobLandlord === true,
        "status=" + g2.status);
    check("重发后手牌变了", g2.players.map((p) => p.cards.join("")).join("|") !== handBefore);
    check("重发后每人还是 17 张", g2.players.every((p) => p.cards.length === 17),
        g2.players.map((p) => p.cards.length).join(","));

    const st = ev(g2.getCurrentPlayer().id);
    getDouCommand(st, "状态");
    check("cc状态 说清阶段和轮到谁",
        st.out.some((t) => t.includes("抢地主阶段") && t.includes("轮到")), st.out.join("|"));
    gameMap.delete(ROOM);

    fs.rmSync(recordFile, { force: true });
    console.log(failed ? "\n" + failed + " 条失败" : "\n全部通过（共发出 " + sent.length + " 条消息）");
    process.exit(failed ? 1 : 0);
})().catch((err) => { console.error("崩了: " + err.stack); process.exit(1); });
