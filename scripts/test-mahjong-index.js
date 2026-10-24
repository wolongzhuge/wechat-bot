"use strict";
// 麻将命令层离线测试：cc 命令 → 引擎 → 群文本 + 群图 + 私聊手牌 的整条链路。
//
// 三条纪律：
// 1) 绝不碰真实微信。app.js 用 require.cache 顶成假 client，消息只进内存数组；
//    真机器人在跑的时候 require("../app") 会连协议服务端，所以这里根本不加载它。
// 2) state_file 指到临时文件，绝不写真实快照。
// 3) 本文件只放 scripts/，command/ 下不能有它（watcher 会热重载并真的发消息）。
//
// 跑法：node scripts/test-mahjong-index.js [seed]

const fs = require("fs");
const path = require("path");
const Module = require("module");

process.env.state_file = process.env.state_file || path.join(__dirname, "..", "test", "tmp-mahjong-index-state.json");
try { fs.unlinkSync(process.env.state_file); } catch (e) { /* 旧快照清了就行 */ }

// ---------- 假 client（先建，再顶掉 app.js） ----------
const ROOM = "R100@chatroom";
const sent = [];   // 群里回的文字
const pics = [];   // 群里发的图（只记长度，别把 base64 印出来）
const priv = [];   // 私聊：{to, text} 或 {to, image}
const friends = new Set(["A", "B"]);

const fakeClient = {
    ourWxid: "botwxid",
    ourName: "机器人",
    displayName: (id) => ({ A: "甲", B: "乙", C: "丙" }[id] || String(id)),
    isFriend: async (id) => friends.has(id),
    sendText: async (to, text) => { (to === ROOM ? sent : priv).push({ to, text: String(text) }); return { Code: 0 }; },
    sendImage: async (to, b64) => { priv.push({ to, image: String(b64).length }); return { Code: 0 }; },
    sendTempMsg: async (room, userId, text) => { priv.push({ to: userId, text: String(text) }); return { Code: 0 }; },
};
const appPath = require.resolve("../app");
const stub = new Module(appPath, null);
stub.filename = appPath;
stub.loaded = true;
stub.exports = { client: fakeClient };
require.cache[appPath] = stub;

const T = require("../command/mahjong/tiles");
const store = require("../state/store");
const Rules = require("../command/mahjong/rules");
const { MahjongGame } = require("../command/mahjong/game");
const { renderImage, renderText } = require("../command/mahjong/render");
const { getMahjongCommand, games } = require("../command/mahjong/mahjongIndex");

const SEED = Number(process.argv[2] || 20261024);
function lcg(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

let failed = 0;
function check(label, cond, extra) {
    if (!cond) failed++;
    console.log((cond ? "  ok   " : "  FAIL ") + label + (cond ? "" : "  → " + JSON.stringify(extra === undefined ? last() : extra)));
}
function ev(user, text) {
    return {
        group_id: ROOM,
        sender: { user_id: user },
        atme: true,
        client: fakeClient,
        reply: async (content) => {
            if (content && typeof content === "object" && content.image) {
                pics.push({ to: ROOM, len: String(content.image).length });
                return { Code: 0 };
            }
            sent.push({ to: user, text: String(content) });
            return { Code: 0 };
        },
    };
}
const fire = (user, text) => getMahjongCommand(ev(user), text);
const last = () => (sent.length ? sent[sent.length - 1].text : "");
const saidSince = (n) => sent.slice(n).map((s) => s.text).join("\n");
const table = () => games.get(ROOM);

// ---------- 桌子级命令 ----------
(async () => {
    check("没牌桌时 cc状态 让人先上桌", await fire("A", "状态").then(() => /还没牌桌/.test(last())), last());
    check("没牌桌时 cc棋盘 也一样", await fire("A", "棋盘").then(() => /还没牌桌/.test(last())), last());
    check("没牌桌时 cc规则 也能看", await fire("A", "规则").then(() => /1~3 个真人上桌/.test(last())), last());
    await fire("C", "过");
    check("没牌桌时副露命令不炸", /还没上桌/.test(last()), last());

    await fire("A", "麻将");
    check("cc麻将 上桌并说明座位", /上桌/.test(last()) && /[一二三四]家/.test(last()), last());
    const seatA = table() && table().seatOf("A");
    check("桌子建起来了", !!table() && seatA >= 0 && seatA <= 3, table() && table().players);

    const before = sent.length;
    await fire("C", "麻将");
    check("非好友上桌被挡在门外", /加好友/.test(last()), last());
    check("挡人时不能把别人的牌桌删掉", games.has(ROOM) && table().seatOf("A") === seatA,
        { has: games.has(ROOM), seatA: table() && table().seatOf("A") });
    check("非好友上桌不该改动牌桌", table().humans().length === 1, table().humans().length);
    check("拒绝时没往群里乱发图", pics.length === 0, pics.length);

    await fire("B", "麻将");
    check("第二个人上桌坐到另一个空位", /上桌/.test(last()) && table().seatOf("B") !== seatA,
        { seatA: seatA, seatB: table().seatOf("B"), last: last() });
    await fire("B", "麻将");
    check("重复上桌提示已在桌上", /已经在这桌上/.test(last()), last());

    await fire("C", "开局");
    check("不是桌上的人不能开局", /你不在这桌上/.test(last()), last());

    // ---------- 日麻：开局 → 打完整局 ----------
    await fire("A", "开局");
    const g = table();
    check("开局发牌并把牌墙报出来", /开局/.test(last()) && /牌墙/.test(last()), last());
    check("开局后位子补满四家", g.seats.length === 4 && g.seats.filter((s) => s.bot).length === 2, g.seats.map((s) => !!s.bot));
    check("日麻开局直接进入出牌/声明", g.phase === "discard" || g.phase === "claim", g.phase);
    check("开局给群里发了盘面图", pics.length > 0 && pics[pics.length - 1].len > 3000, pics);
    // 座位随机以后开局第一手不一定是 A，直接把回合推到 A 再让 A 摸牌看手牌
    g.turn = g.seatOf("A");
    g.phase = "discard";
    g.drawn = null;
    await fire("A", "手牌");
    check("该动手时手牌走私聊", priv.some((p) => p.to === "A"), priv.map((p) => p.to));
    check("开局后没有第二个人的手牌泄露", priv.filter((p) => p.to === "B").length === 0, priv.filter((p) => p.to === "B").length);
    check("公开盘面看不到任何人的手牌",
        g.snapshot(null).seats.every((s) => s.hand.length === 0), g.snapshot(null).seats.map((s) => s.hand.length));
    check("问自己的那家能看见自己的手牌", g.snapshot(g.seatOf("A")).seats[g.seatOf("A")].hand.length >= 13,
        g.snapshot(g.seatOf("A")).seats[g.seatOf("A")].hand.length);
    check("公开盘面不画别人的听牌", g.snapshot(null).seats.every((s) => !s.waits.length), "waits leak");

    const total0 = g.seats.reduce((a, s) => a + s.score, 0) + 1000 * g.riichiSticks;
    const meldLog = await playRound(g, { meld: false });
    check("日麻一局能通过命令层打完", g.phase === "round-over", { phase: g.phase, tail: g.tail.length, log: meldLog });
    check("打完点数仍然守恒",
        g.seats.reduce((a, s) => a + s.score, 0) + 1000 * g.riichiSticks === total0,
        { scores: g.seats.map((s) => s.score), sticks: g.riichiSticks });
    check("日麻牌数守恒", censusOk(g), { got: countTiles(g), want: T.makeWall(g.mode.wall).length });
    check("结算后战报留了一条", g.tail.length >= 1 && g.tail[g.tail.length - 1].some((e) => e.type === "round-end"), g.tail.length);
    check("结算文本发到群里了", /本局结束|和牌|流局/.test(saidSince(before)), saidSince(before).slice(-200));
    check("结算亮牌图里没有隐藏手牌", g.snapshot(null).seats.every((s) => s.hand.length > 0 || s.out), "round-over 应该全亮");

    await fire("A", "战报");
    check("cc战报 讲得出上一局", /战报/.test(last()), last());
    await fire("A", "点数");
    check("cc点数 列出四家分数", /点数/.test(last()) && /一家[\s\S]*二家[\s\S]*三家[\s\S]*四家/.test(last()), last());
    await fire("A", "棋盘");
    check("cc棋盘 文本+图都回", pics[pics.length - 1] !== undefined, pics.length);

    // ---------- 立直命令（用户指定的写法） ----------
    await fire("A", "下一局");
    check("cc下一局 开新的一局", table().phase !== "lobby" && /开局/.test(last()), last());
    await fire("A", "立直");
    check("光发 cc立直 会提示把牌写在前面", /立直和出牌是一条命令/.test(last()), last());
    await fire("A", "立直三万");
    check("倒装 cc立直三万 也认（不会被当成看不懂）", !/没看懂/.test(last()), last());
    await fire("A", "结束");
    check("cc结束 散桌", !games.has(ROOM), games.has(ROOM));

    // ---------- 立直一体命令：把牌搭成「打掉这张就听」再验证 ----------
    const rg = new MahjongGame({ modeId: "riichi", room: ROOM });
    rg.addPlayer("A", "甲");
    rg.start();
    // 123m 456m 789m 东东东 + 五筒 = 13 张单骑听五筒，再摸一张白：打白就听
    rg.seats[0].hand = [0, 1, 2, 3, 4, 5, 6, 7, 8, 27, 27, 27, 9].map((id) => ({ id, red: false }));
    const haku = { id: 33, red: false };
    rg.seats[0].hand.push(haku);
    rg.seats[0].melds = [];
    rg.drawn = haku;
    rg.turn = 0;
    rg.phase = "discard";
    games.set(ROOM, rg);
    await fire("A", "白立直");
    check("cc白立直 一张命令打完 + 立直", /立直！/.test(last()) && rg.seats[0].riichi, last());
    check("立直扣 1000 点并立一根棒", rg.seats[0].score === 9000 && rg.riichiSticks === 1,
        { score: rg.seats[0].score, sticks: rg.riichiSticks });
    if (rg.phase === "discard" && rg.turn === 0 && rg.drawn) {
        const drawnId = rg.idOf(rg.drawn);
        const wrong = rg.concealedIds(0).find((id) => id !== drawnId);
        await fire("A", T.tileShort(wrong));
        check("立直之后只能摸切", /已经立直，只能摸切/.test(last()), last());
        check("摸切报错不把刚摸的牌写进群里", !last().includes(T.tileShort(drawnId)), last());
        await fire("A", T.tileShort(drawnId));
        check("摸到的那张能打出去", !/已经立直，只能摸切/.test(last()), last());
    }
    await fire("A", "自摸");
    check("和不了的时候引擎自己说原因", /和不了|不能自摸|没轮到你|声明/.test(last()), last());
    await fire("A", "状态");
    check("cc状态 里能看到自己立直了", /立直/.test(last()), last());
    await fire("A", "结束");
    games.delete(ROOM);

    // ---------- 听牌提示只走私聊：群里的状态/盘面一个字都不许提 ----------
    const tg = new MahjongGame({ modeId: "riichi", room: ROOM });
    tg.addPlayer("A", "甲");
    tg.start();
    // 234m 567m 234p 567p + 东 + 多摸一张五万：打五万就落单骑听东
    tg.seats[0].hand = [1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 27, 4].map((id) => ({ id, red: false }));
    tg.seats[0].melds = [];
    tg.drawn = tg.seats[0].hand[13];
    tg.turn = 0;
    tg.phase = "discard";
    games.set(ROOM, tg);
    const gBefore = sent.length;
    const pBefore = priv.length;
    await fire("A", "手牌");
    const gText = saidSince(gBefore);
    const pText = priv.slice(pBefore).filter((p) => p.text).map((p) => p.text).join("\n");
    check("私聊手牌里带听牌提示", /→听/.test(pText) && /[東东]/.test(pText), pText.slice(0, 200));
    check("群里问手牌只说到「已私聊」，不报听牌", !/→听|打这张就听牌/.test(gText), gText);
    await fire("A", "状态");
    check("群里 cc状态 也不报听牌", !/→听|打这张就听牌/.test(last()), last());
    games.delete(ROOM);

    // ---------- 群里的报错也只能报公开信息：声明选项不许跟着 reject 漏出去 ----------
    const cg = new MahjongGame({ modeId: "riichi", room: ROOM });
    cg.addPlayer("A", "甲");
    cg.start();
    // 上家（座位 3 的机器人）手里有 2 万，甲手里 3 万 4 万 → 甲能吃到这张
    cg.seats[cg.seatOf("A")].hand = [2, 3, 6, 7, 10, 11, 12, 13, 14, 15, 27, 31, 32].map((id) => ({ id, red: false }));
    cg.seats[cg.seatOf("A")].melds = [];
    // 吃只能吃上家的牌：甲的座位是 0，所以由座位 3 打这张
    cg.seats[3].hand = [1, 5, 8, 9, 16, 17, 18, 19, 20, 21, 22, 23, 24].map((id) => ({ id, red: false }));
    cg.seats[3].melds = [];
    cg.phase = "discard";
    cg._discard(3, 1);   // 上家打 2 万，甲进入声明窗口
    check("测试前提：甲能吃到这张", cg.phase === "claim" && !!cg.claim.offers[cg.seatOf("A")] &&
        cg.claim.offers[cg.seatOf("A")].chi.length > 0, { phase: cg.phase, off: cg.claim && Object.keys(cg.claim.offers) });
    games.set(ROOM, cg);
    await fire("A", "打五万");
    check("声明窗口里乱打牌会被拦下", /等你声明/.test(last()), last());
    // 只看第一行提示：末尾的 FORMAT_HINT 本来就会列 cc吃/cc碰 这些通用写法
    const hintLine = last().split("\n")[0];
    check("拦下时群里不报「能吃/能碰」", !/cc吃|cc碰|cc和|cc杠/.test(hintLine), hintLine);
    games.delete(ROOM);

    // ---------- 缺门报错也不能把手牌列进群：只报张数 ----------
    const qg = new MahjongGame({ modeId: "sichuan", room: ROOM });
    qg.addPlayer("A", "甲");
    qg.start();
    qg.seats.forEach((s) => { s.queSuit = "p"; });
    qg.phase = "discard";
    qg.turn = qg.seatOf("A");
    qg.drawn = null;
    const offQue = qg.seats[qg.seatOf("A")].hand.find((t) => T.suitOf(t.id) !== "p");
    games.set(ROOM, qg);
    await fire("A", T.tileShort(offQue.id));
    check("缺门报错只说「还缺几张」", /缺门/.test(last()) && !/手里：/.test(last()), last().split("\n")[0]);
    const aSeat = qg.seatOf("A");
    let ghost = -1;
    for (let id = 0; id < 34 && ghost < 0; id++) if (!qg.seats[aSeat].hand.some((t) => t.id === id)) ghost = id;
    await fire("A", T.tileShort(ghost));
    check("手里没这张时群里不列整副手牌",
        /手里没有/.test(last()) && !last().includes(qg.handText(aSeat)), last().split("\n")[0]);
    games.delete(ROOM);

    // ---------- 血战：定缺 + 缺门限制 + 杠有即时分 ----------
    await fire("A", "麻将");
    await fire("A", "模式 血战");
    check("cc模式 血战 换到血战", /血战/.test(last()) && table().modeId === "sichuan", last());
    await fire("A", "开局");
    const g3 = table();
    check("血战开局先进定缺阶段", g3.phase === "que", g3.phase);
    await fire("A", "缺");
    check("cc缺 不带花色会提示写法", /定缺写法/.test(last()), last());
    await fire("A", "打五万");
    check("没定缺时打不了牌", /还没定缺/.test(last()), last());
    const suit = leastSuit(g3, g3.seatOf("A"));
    await fire("A", "缺" + T.SUIT_CHAR[suit]);
    check("cc缺条 定缺成功", /定缺/.test(last()), last());
    check("其他家（机器人）自动跟着定缺", g3.seats.every((s) => s.queSuit != null) || g3.phase !== "que",
        g3.seats.map((s) => s.queSuit));

    const total3 = g3.seats.reduce((a, s) => a + s.score, 0);
    const log3 = await playRound(g3, { meld: true });
    check("血战一局能通过命令层打完", g3.phase === "round-over", { phase: g3.phase, log: log3 });
    check("血战打完点数守恒", g3.seats.reduce((a, s) => a + s.score, 0) === total3,
        { scores: g3.seats.map((s) => s.score), gangs: g3.kanCount });
    check("血战结算里有查花猪/查叫或和牌", /查|胡|点炮|自摸/.test(saidSince(sent.length - 40)), saidSince(sent.length - 40).slice(-160));
    check("副露画进了图里（有碰/杠的时候图会变长）", pics.length > 4, pics.length);

    // 牌张守恒：整局打完牌应该一张不多一张不少
    check("血战牌数守恒", censusOk(g3), { got: countTiles(g3), want: T.makeWall(g3.mode.wall).length });

    await fire("A", "模式");
    check("cc模式 不带参数列出可选玩法", /血战/.test(last()) && /广东/.test(last()), last());
    await fire("A", "结束");

    // ---------- 快照往返：机器人重启/热更后牌局要能接着打 ----------
    // 麻将局里藏着 Set 和挂在 mode 上的函数，这两样 JSON 都存不住，最容易在这一步崩。
    await fire("A", "麻将");
    await fire("A", "模式 血战");
    await fire("A", "开局");
    const gs = table();
    await playRound(gs, { meld: true, limit: 8 });
    console.log("    停在哪：phase=" + gs.phase + " turn=" + gs.turn + "(" + gs.seats[gs.turn].name +
        " bot=" + gs.seats[gs.turn].bot + ") 声明家=" + JSON.stringify(Object.keys((gs.claim && gs.claim.offers) || {})) +
        " 已答=" + JSON.stringify(Object.keys((gs.claim && gs.claim.answers) || {})));
    check("打到一半停住（不半途就没得测）", gs.phase !== "lobby" && gs.phase !== "round-over", { phase: gs.phase, discards: gs.discardsInRound });
    store.save();
    store.restore();
    const back = games.get(ROOM);
    check("快照恢复后牌桌还在", back && back !== gs && back.seats.length === 4, { back: !!back, seats: back && back.seats.length });
    check("恢复后 claimedObjs 是 Set（JSON 里会变成 {}）", back.claimedObjs instanceof Set, typeof back.claimedObjs);
    check("恢复后 mode 是活的规则对象", typeof back.mode.score === "function" && back.mode.id === "sichuan",
        { id: back.mode.id, score: typeof back.mode.score });
    check("恢复后手牌/牌河都还在原座位", back.seats.every((s) => Array.isArray(s.hand) && Array.isArray(s.river)) &&
        back.seats.reduce((a, s) => a + s.hand.length, 0) > 0, back.seats.map((s) => s.hand.length));
    check("恢复后还认得上桌的人", back.seatOf("A") === gs.seatOf("A") && back.seatOf("A") >= 0, back.players);
    const log5 = await playRound(back, { meld: true });
    check("恢复之后能接着打到结算", back.phase === "round-over", { phase: back.phase, log: log5 });
    check("恢复后牌数守恒", censusOk(back), { got: countTiles(back), want: Rules.buildWall(back.mode).length });
    await fire("A", "下一局");
    check("恢复后 cc下一局 开得了新局", table().phase !== "lobby" && /开局/.test(last()), last());
    await fire("A", "结束");

    // ---------- 广东 + 渲染降级 ----------
    await fire("B", "麻将");
    await fire("B", "模式 广东");
    await fire("B", "开局");
    const g4 = table();
    check("广东开局能吃（chi 打开）", g4.mode.chi === true && g4.phase !== "lobby", g4.phase);
    const log4 = await playRound(g4, { meld: true });
    check("广东一局打得完", g4.phase === "round-over", { phase: g4.phase, log: log4 });
    check("广东牌数守恒", censusOk(g4), { got: countTiles(g4), want: T.makeWall(g4.mode.wall).length });

    // 文本盘面（渲染失败时的兜底）必须自己也能看懂
    const text = renderText(g4.snapshot(null));
    check("文本盘面兜底可用（含四家和牌河）", /一家/.test(text) && /牌河/.test(text), text.slice(0, 120));
    check("图片渲染返回 base64 PNG", /^iVBOR/.test(String(renderImage(g4.snapshot(null)))), "png header");

    // ---------- 认不出的命令要有指引 ----------
    await fire("A", "随便说点什么");
    check("看不懂的命令回提示而不是沉默", /没看懂/.test(last()) && /cc \+/.test(last()), last());
    await fire("Z", "状态");
    check("局外人问状态也能看到局面", /麻将】/.test(last()), last());

    // 听什么是手牌信息：整场跑下来，群里一句都不许出现（立直后自有立直播报）
    const leak = sent.filter((s) => /→听|打这张就听牌/.test(s.text));
    check("群里从头到尾没播报过听牌", leak.length === 0, leak.slice(0, 3));
    check("私聊里确实给过听牌提示（提示没被误删）", priv.some((p) => p.text && /→听|打这张就听牌/.test(p.text)),
        priv.filter((p) => p.text).length);

    console.log(failed ? "\n" + failed + " 条失败（seed " + SEED + "）" : "\n全部通过（seed " + SEED + "）");
    try { fs.unlinkSync(process.env.state_file); } catch (e) { /* 没落盘就算了 */ }
    process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); try { fs.unlinkSync(process.env.state_file); } catch (e) {} process.exit(1); });

// ---------- 驱动器：只用「群里能发的命令」把一局打完 ----------
async function playRound(game, opts) {
    const seatA = game.seatOf("A");
    const seatB = game.seatOf("B");
    const log = [];
    let guard = 0;
    let acted = 0;
    while (game.phase !== "round-over" && guard++ < 600 && (opts.limit === undefined || acted < opts.limit)) {
        acted++;
        if (game.phase === "que") {
            for (const s of [game.seats[seatA], game.seats[seatB]].filter((x) => x && x.queSuit == null)) {
                const suit = leastSuit(game, game.seats.indexOf(s));
                await fire(s.id, "缺" + T.SUIT_CHAR[suit]);
            }
            continue;
        }
        if (game.phase === "claim" && game.claim) {
            const seat = [seatA, seatB].find((x) => x != null && game.claim.offers[x] && !game.claim.answers[x]);
            if (seat == null) {
                // 没人需要答话（机器人都表态了）——引擎自己会推进，这里不能再等
                log.push("claim-stuck:" + JSON.stringify(game.claim.answers));
                break;
            }
            const offer = game.claim.offers[seat];
            const who = game.seats[seat].id;
            if (opts.meld && offer.ron) { log.push("ron"); await fire(who, "和"); }
            else if (opts.meld && offer.kan) { log.push("kan"); await fire(who, "杠"); }
            else if (opts.meld && offer.pon) { log.push("pon"); await fire(who, "碰"); }
            else if (opts.meld && offer.chi && offer.chi.length) {
                log.push("chi");
                await fire(who, "吃" + game._ranksOf(T.sortTiles([].concat(offer.chi[0]))).join(""));
            } else { log.push("pass"); await fire(who, "过"); }
            continue;
        }
        if (game.phase === "discard") {
            const seat = [seatA, seatB].find((x) => x != null && !game.seats[x].out && game.turn === x);
            if (seat == null) {
                log.push("turn-stuck:" + game.turn + ":" + game.seats[game.turn].name +
                    " bot=" + game.seats[game.turn].bot + " out=" + game.seats[game.turn].out +
                    " 各家=" + game.seats.map((s) => s.name + (s.bot ? "B" : "H") + (s.out ? "x" : "")).join(","));
                console.log("    卡住现场：" + JSON.stringify({
                    turnType: typeof game.turn, phase: game.phase,
                    drawn: game.drawn ? game.idOf(game.drawn) : null,
                    hand: game.seats.map((s) => s.hand.length), melds: game.seats.map((s) => s.melds.length),
                    river: game.seats.map((s) => s.river.length), wall: game.wall.length,
                    keys: Object.keys(game).sort().join(","),
                }));
                break;
            }
            const s = game.seats[seat];
            if (s.riichi) {
                await fire(s.id, T.tileShort(game.idOf(game.drawn)));
                continue;
            }
            const ids = game.concealedIds(seat);
            const que = game.mode.que && s.queSuit != null ? ids.filter((id) => T.suitOf(id) === s.queSuit) : [];
            const order = (que.length ? que : ids.slice().reverse()).filter((id, i, a) => a.indexOf(id) === i);
            // 成功与否看本局打牌数：手牌张数会被「碰完再摸一张」绕平，牌河会被别家碰走
            const beforeDiscards = game.discardsInRound;
            let ok = false;
            for (const id of order) {
                await fire(s.id, T.tileShort(id));
                if (game.discardsInRound > beforeDiscards) { ok = true; break; }
            }
            if (!ok) { log.push("no-discard[" + s.name + " 缺" + s.queSuit + "]:" + last().slice(0, 90)); break; }
            continue;
        }
        log.push("phase:" + game.phase);
        break;
    }
    if (guard >= 600) log.push("guard-hit");
    return log.join(",");
}

// 手里最少的那门（真玩家都会这么定缺）
function leastSuit(game, seat) {
    const counts = game.counts(seat);
    const total = ["m", "p", "s"].map((suit) => counts.reduce((a, c, id) => a + (T.suitOf(id) === suit ? c : 0), 0));
    let best = 0;
    for (let i = 1; i < 3; i++) if (total[i] < total[best]) best = i;
    return ["m", "p", "s"][best];
}

// 牌数守恒（和 test-mahjong-play.js 同一口径：牌墙 + 虚牌）
function countTiles(game) {
    let total = 0;
    for (const t of game.wall.concat(game.dead)) total++;
    for (const s of game.seats) {
        total += s.hand.length + s.river.length;
        for (const m of s.melds) total += m.tiles.length;
    }
    return total;
}
const censusOk = (game) => countTiles(game) === Rules.buildWall(game.mode).length + (game.phantomTiles || 0);
