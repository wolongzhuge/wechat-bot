"use strict";
// UNO 引擎 + 命令层断言：牌堆构成、出牌规则、跳过/反转/+2/万能/+4、摸牌、投降、房主开始流程。
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { client } = require("../app");
const { UnoGame, makeDeck, parseCard, cardText } = require("../command/uno/game");
const { getUnoCommand, games } = require("../command/uno/unoIndex");

let failed = 0;
function check(label, cond, extra) {
    if (!cond) failed++;
    console.log((cond ? "  ok   " : "  FAIL ") + label + (cond ? "" : "  → " + extra));
}
// 测试里造牌：万能/+4 单独写没有颜色也能造，其余走 parseCard
function HC(text) {
    if (text === "万能" || text === "+4") return { color: null, value: text };
    const p = parseCard(text);
    return { color: p.color, value: p.value };
}
// 直接摆好牌局（跳过 shuffle/发牌），引擎规则原样跑
function setup(players, hands, top, deckCards, opts) {
    const g = new UnoGame();
    for (const [id, name] of players) g.addPlayer(id, name);
    g.started = true;
    g.players.forEach((p, i) => { p.hand = (hands[i] || []).slice(); });
    g.discard = [HC(top)];
    g.currentColor = HC(top).color || "红";
    g.direction = (opts && opts.direction) || 1;
    g.currentIndex = opts && opts.currentIndex !== undefined ? opts.currentIndex : 0;
    g.deck = (deckCards || []).map(HC);
    return g;
}

// ---------- 牌堆构成 ----------
const deck = makeDeck();
check("牌堆 108 张", deck.length === 108, deck.length);
const count = (color, value) => deck.filter((c) => c.color === color && c.value === value).length;
check("每色 0 各一张", ["红", "黄", "蓝", "绿"].every((c) => count(c, "0") === 1), "0");
check("每色 1-9 各两张", ["1", "5", "9"].every((v) => count("红", v) === 2 && count("蓝", v) === 2), "num");
check("每色 跳过/反转/+2 各两张", ["跳过", "反转", "+2"].every((v) => count("红", v) === 2 && count("绿", v) === 2), "act");
check("万能/+4 各四张", count(null, "万能") === 4 && count(null, "+4") === 4, "wild");

// ---------- 记谱解析 ----------
const p1 = parseCard("出红5");
check("解析 出红5", p1 && p1.color === "红" && p1.value === "5", JSON.stringify(p1));
const p2 = parseCard("万能 蓝");
check("解析 万能 蓝", p2 && p2.value === "万能" && p2.chosenColor === "蓝", JSON.stringify(p2));
const p3 = parseCard("蓝万能");
check("解析 蓝万能", p3 && p3.value === "万能" && p3.chosenColor === "蓝", JSON.stringify(p3));
const p4 = parseCard("+4 红");
check("解析 +4 红", p4 && p4.value === "+4" && p4.chosenColor === "红", JSON.stringify(p4));
const p5 = parseCard("加2");
check("解析 加2 → +2", p5 && p5.value === "+2", JSON.stringify(p5));
const p6 = parseCard("5");
check("解析不带颜色 5", p6 && p6.value === "5" && p6.color === null, JSON.stringify(p6));
check("乱写解析为 null", parseCard("炸他") === null, "garbage");

// ---------- 开局门槛 ----------
const t1 = new UnoGame();
t1.addPlayer("A", "甲");
check("只有 1 人不能开", !t1.start("A").ok, "1p");
const s = new UnoGame();
s.addPlayer("A", "甲"); s.addPlayer("B", "乙");
check("非房主说开始被拒", !s.start("B").ok, "host");
const sr = s.start("A");
check("房主开始成功", sr.ok, JSON.stringify(sr));
check("每家 7 张，牌堆剩 93", s.players.every((p) => p.hand.length === 7) && s.deck.length === 93, s.deck.length);
check("亮出的第一张是数字牌", s.top().color && /^[0-9]$/.test(s.top().value), cardText(s.top()));
check("房主先出", s.players[s.currentIndex].id === "A", "idx=" + s.currentIndex);

const m4 = new UnoGame();
m4.addPlayer("A", "甲"); m4.addPlayer("B", "乙"); m4.addPlayer("C", "丙"); m4.addPlayer("D", "丁");
check("第 5 人上不了桌", !m4.addPlayer("E", "戊").ok, "5th");
check("重复上桌被拒", !m4.addPlayer("A", "甲").ok, "dup");

// ---------- 基本出牌 ----------
const g1 = setup([["A", "甲"], ["B", "乙"], ["C", "丙"]], [[HC("红5"), HC("蓝3")], [HC("黄2")], [HC("绿8")]], "红7");
const r1 = g1.tryPlay("A", "出红5");
check("同色能出", r1.ok, JSON.stringify(r1));
check("出完轮到下一个", g1.players[g1.currentIndex].id === "B", g1.players[g1.currentIndex].id);
check("手牌减一张", g1.players[0].hand.length === 1, g1.players[0].hand.length);

const g2 = setup([["A", "甲"], ["B", "乙"]], [[HC("蓝7")], [HC("黄2")]], "红7");
check("同数字不同色能出", g2.tryPlay("A", "蓝7").ok, "7");

const g3 = setup([["A", "甲"], ["B", "乙"], ["C", "丙"]], [[HC("蓝3")], [HC("黄2")], [HC("绿8")]], "红7");
const r3 = g3.tryPlay("A", "蓝3");
check("对不上牌面被拒", !r3.ok && r3.hint.includes("对不上"), r3.hint);
check("被拒后还是 A 出", g3.players[g3.currentIndex].id === "A", "turn");
check("没轮到你被拒", !g3.tryPlay("B", "黄2").ok, "B");

// ---------- 跳过 / 反转 ----------
const g4 = setup([["A", "甲"], ["B", "乙"], ["C", "丙"]], [[HC("红跳过"), HC("蓝1")], [HC("黄2")], [HC("绿8")]], "红7");
const r4 = g4.tryPlay("A", "红跳过");
check("跳过下家", r4.ok && r4.effects.includes("跳过 乙"), r4.effects);
check("跳过生效轮到 C", g4.players[g4.currentIndex].id === "C", g4.players[g4.currentIndex].id);

const g5 = setup([["A", "甲"], ["B", "乙"], ["C", "丙"]], [[HC("红反转"), HC("红1")], [HC("黄2")], [HC("红8"), HC("黄8")]], "红7");
const r5 = g5.tryPlay("A", "红反转");
check("反转后轮到 C（逆时针）", r5.ok && g5.direction === -1 && g5.players[g5.currentIndex].id === "C",
    "dir=" + g5.direction + " cur=" + g5.players[g5.currentIndex].id);
const r5b = g5.tryPlay("C", "红8");
check("C 出完轮到 B（逆时针走）", r5b.ok && g5.players[g5.currentIndex].id === "B", g5.players[g5.currentIndex].id);

const g6 = setup([["A", "甲"], ["B", "乙"]], [[HC("红反转"), HC("红3")], [HC("黄2")]], "红7");
const r6 = g6.tryPlay("A", "红反转");
check("两人局反转 = 跳过，A 接着出", r6.ok && g6.players[g6.currentIndex].id === "A", g6.players[g6.currentIndex].id);

// ---------- +2 / +4 / 万能 ----------
const g7 = setup([["A", "甲"], ["B", "乙"], ["C", "丙"]], [[HC("红+2"), HC("红1")], [HC("黄2")], [HC("绿8")]], "红7", ["蓝1", "蓝2"]);
const r7 = g7.tryPlay("A", "红+2");
check("+2 下家摸 2 张被跳过", r7.ok && g7.players[1].hand.length === 3 && g7.players[g7.currentIndex].id === "C",
    "hand=" + g7.players[1].hand.length + " cur=" + g7.players[g7.currentIndex].id);

const g8 = setup([["A", "甲"], ["B", "乙"], ["C", "丙"]], [[HC("+4"), HC("红1")], [HC("黄2")], [HC("绿8")]], "红7", ["蓝1", "蓝2", "蓝3", "蓝4"]);
const r8 = g8.tryPlay("A", "出+4 红");
check("+4 摸 4 张被跳过并变色", r8.ok && g8.players[1].hand.length === 5 && g8.currentColor === "红" && g8.players[g8.currentIndex].id === "C",
    JSON.stringify({ h: g8.players[1].hand.length, c: g8.currentColor, cur: g8.players[g8.currentIndex].id }));

const g9 = setup([["A", "甲"], ["B", "乙"]], [[HC("万能"), HC("红1")], [HC("黄2")]], "红7");
const r9 = g9.tryPlay("A", "万能 蓝");
check("万能选色后牌面变蓝", r9.ok && g9.currentColor === "蓝" && g9.players[g9.currentIndex].id === "B",
    JSON.stringify({ ok: r9.ok, color: g9.currentColor }));
const g9b = setup([["A", "甲"], ["B", "乙"]], [[HC("万能")], [HC("黄2")]], "红7");
check("万能不选颜色被拒", !g9b.tryPlay("A", "万能").ok, "wild color");

// ---------- 摸牌 / 过 ----------
const g10 = setup([["A", "甲"], ["B", "乙"]], [[HC("红3")], [HC("黄2")]], "红7", ["蓝7"]);
const r10 = g10.tryDraw("A");
check("摸到能出的牌待定", r10.ok && r10.playable && g10.pendingDraw && g10.players[g10.currentIndex].id === "A", JSON.stringify(r10));
check("待定时不能再摸", !g10.tryDraw("A").ok, "draw2");
check("待定时出别的牌被拒", !g10.tryPlay("A", "红3").ok, "other");
const r10b = g10.tryPlay("A", "蓝7");
check("出摸到的那张成功", r10b.ok && g10.players[g10.currentIndex].id === "B", JSON.stringify(r10b));

const g11 = setup([["A", "甲"], ["B", "乙"]], [[HC("红3")], [HC("黄2")]], "红7", ["绿4"]);
const r11 = g11.tryDraw("A");
check("摸到不能出的自动过", r11.ok && !r11.playable && r11.autoPass && g11.players[g11.currentIndex].id === "B", JSON.stringify(r11));

const g12 = setup([["A", "甲"], ["B", "乙"]], [[HC("红3")], [HC("黄2")]], "红7");
const r12 = g12.tryPass("A");
check("cc过 轮到下家", r12.ok && g12.players[g12.currentIndex].id === "B", "pass");
const g12b = setup([["A", "甲"], ["B", "乙"]], [[HC("红3")], [HC("黄2")]], "红7", ["蓝7"]);
g12b.tryDraw("A");
g12b.tryPass("A");
check("过掉摸到的牌（留着）", g12b.pendingDraw === null && g12b.players[g12b.currentIndex].id === "B" && g12b.players[0].hand.length === 2, "kept");

// ---------- UNO 提示与获胜 ----------
const g13 = setup([["A", "甲"], ["B", "乙"]], [[HC("红5"), HC("红3")], [HC("红2"), HC("红4")]], "红7");
const r13 = g13.tryPlay("A", "红5");
check("剩一张提示 UNO", r13.ok && r13.uno === true && !r13.over, JSON.stringify(r13));
check("轮到 B 出", g13.tryPlay("B", "红2").ok, "B");
const r13c = g13.tryPlay("A", "红3");
check("出完最后一张获胜", r13c.ok && r13c.over && g13.winner.id === "A", JSON.stringify(r13c));

// ---------- 投降 ----------
const g14a = setup([["A", "甲"], ["B", "乙"], ["C", "丙"]], [[HC("红5")], [HC("黄2")], [HC("绿8")]], "红7");
g14a.currentIndex = 1;
const r14a = g14a.surrender("B");
check("投降离场游戏继续", r14a.ok && !r14a.over && g14a.players.length === 2 && g14a.players[g14a.currentIndex].id === "C",
    JSON.stringify(r14a));
const g14b = setup([["A", "甲"], ["B", "乙"], ["C", "丙"]], [[HC("红5")], [HC("黄2")], [HC("绿8")]], "红7");
g14b.currentIndex = 1; g14b.direction = -1;
g14b.surrender("B");
check("逆时针时投降轮到上家", g14b.players[g14b.currentIndex].id === "A", g14b.players[g14b.currentIndex].id);
const g14c = setup([["A", "甲"], ["B", "乙"], ["C", "丙"]], [[HC("红5")], [HC("黄2")], [HC("绿8")]], "红7");
g14c.currentIndex = 2;
g14c.surrender("A");
check("前面的人走了 currentIndex 前移", g14c.players[g14c.currentIndex].id === "C", g14c.players[g14c.currentIndex].id);
const g14d = setup([["A", "甲"], ["B", "乙"]], [[HC("红5")], [HC("黄2")]], "红7");
const r14d = g14d.surrender("B");
check("只剩一人直接获胜", r14d.ok && r14d.over && g14d.winner.id === "A", JSON.stringify(r14d));

// ---------- 牌堆空了洗弃牌堆 ----------
const g15 = setup([["A", "甲"], ["B", "乙"]], [[HC("红3")], [HC("黄2")]], "红7", []);
g15.discard.push(HC("红5"), HC("红6")); // 顶牌变 红6，弃牌堆 3 张
const r15 = g15.tryDraw("A");
check("没牌摸时洗弃牌堆再摸", r15.ok && g15.players[0].hand.length === 2 && g15.discard.length === 1,
    "hand=" + g15.players[0].hand.length + " discard=" + g15.discard.length);
check("牌面顶牌保留", cardText(g15.top()) === "红6", cardText(g15.top()));

// ---------- 命令层流程（stub client）----------
const sent = [];
const temps = [];
client.sendText = async (to, text) => { sent.push({ to, text }); return { Code: 0 }; };
client.sendTempMsg = async (room, userId, text) => { temps.push({ room, userId, text }); return { Code: 0 }; };
client.displayName = (id) => ({ A: "甲", B: "乙", C: "丙", D: "丁", E: "戊" }[id] || String(id));
client.isFriend = async (id) => id !== "C";
const ROOM = "44699859849@chatroom";
games.delete(ROOM);
async function fire(userId, text) {
    const event = {
        type: "group",
        group_id: ROOM,
        sender: { user_id: userId, nick: userId },
        message: [{ type: "text", text }],
        atme: true,
        client,
        reply: async (c) => { sent.push({ to: ROOM, text: typeof c === "string" ? c : (c && c.text) || "" }); },
    };
    await getUnoCommand(event, text);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 30));
}
const last = () => sent[sent.length - 1] ? sent[sent.length - 1].text : "";

(async () => {
    await fire("A", "uno");
    check("第一个 ccuno 的是房主", last().includes("你是房主"), last());
    const g0 = games.get(ROOM);
    check("牌桌建起来且房主是 A", !!g0 && g0.host === "A" && !g0.started, JSON.stringify(g0 && g0.host));

    await fire("B", "上桌");
    check("cc上桌 也能加入（2/4）", last().includes("2/4"), last());
    await fire("C", "uno");
    check("非好友上桌被拒并说明原因", last().includes("好友") && games.get(ROOM).players.length === 2, last());
    client.isFriend = async () => true;
    await fire("C", "uno");
    check("第三个人上桌（3/4）", last().includes("3/4"), last());
    await fire("D", "uno");
    check("第四个人上桌（4/4）", last().includes("4/4"), last());
    await fire("E", "uno");
    check("第五个人被拒（满了）", last().includes("满了"), last());

    await fire("B", "开始");
    check("非房主说开始被拒", last().includes("只有房主"), last());
    const tBefore = temps.length;
    await fire("A", "开始");
    check("房主说开始就开局", games.get(ROOM).started, "not started");
    check("开局手牌私聊发齐", temps.length - tBefore === 4, (temps.length - tBefore) + " 条");
    check("群里公告开局和先手", last().includes("开局") && last().includes("先出"), last());

    await fire("B", "出红5");
    check("没轮到你出牌被拒", last().includes("还没轮到"), last());

    // 摆固定手牌走完一局
    const game = games.get(ROOM);
    game.players[0].hand = [HC("红9"), HC("红8")]; // A
    game.players[1].hand = [HC("黄2")];            // B
    game.players[2].hand = [HC("绿3")];            // C
    game.players[3].hand = [HC("蓝4")];            // D
    game.discard = [HC("红7")];
    game.currentColor = "红";
    game.deck = [HC("绿4")];

    await fire("A", "出红9");
    check("出牌公告带牌面", last().includes("甲 出了 红9"), last());
    check("剩一张喊 UNO", last().includes("只剩 1 张"), last());
    check("提示轮到下一家", last().includes("轮到 乙"), last());

    await fire("A", "手牌");
    check("cc手牌 私聊重发", last().includes("已私聊") && temps.some((t) => t.userId === "A" && t.text.includes("红8")), last());

    await fire("B", "摸");
    check("摸到不能出的自动过", last().includes("自动过") && last().includes("轮到 丙"), last());

    await fire("E", "投降");
    check("不在桌上投降被拒", last().includes("不在桌上"), last());
    await fire("C", "投降");
    check("投降离场轮到丁", last().includes("认负离场") && last().includes("轮到 丁"), last());
    await fire("D", "投降");
    check("丁走了轮到甲", last().includes("轮到 甲"), last());
    await fire("B", "投降");
    check("只剩一人直接获胜", last().includes("获胜"), last());

    await fire("A", "结束");
    check("cc结束 散桌", !games.has(ROOM), "still there");
    await fire("A", "状态");
    check("散桌后状态提示开新桌", last().includes("没有 UNO 牌桌"), last());

    await fire("A", "uno");
    await fire("B", "uno");
    await fire("B", "退出");
    check("开局前可以退桌", last().includes("下桌了（1/4）"), last());
    await fire("A", "结束");

    console.log(failed ? "\n" + failed + " 条失败" : "\n全部通过");
    process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
