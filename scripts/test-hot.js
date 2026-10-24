"use strict";
// 热更新测试：快照往返（五种游戏 + 模式表）、热重载不重复挂监听、失败保旧处理器、引擎类 rebase、cc热更。
// 快照走独立文件 state.test.json，不碰机器人正在用的 state.json。

const fs = require("fs");
const path = require("path");
const assert = require("assert");

process.env.state_file = path.join(__dirname, "..", "data", "state.test.json");

const { client } = require("../app");
const store = require("../state/store");
const dispatch = require("../dispatch");
const { reloadAll } = require("../hot/reloader");
const { getSmallCommand } = require("../command/small/smallIndex");

let passed = 0;
let failed = 0;
function check(name, cond) {
    if (cond) passed++;
    else {
        failed++;
        console.log("FAIL: " + name);
    }
}

function snapshotOf(map, room) {
    return JSON.stringify(map.get(room));
}

// ---------- T1 快照往返 ----------
const { DouDiZhuGame } = require("../dou/game");
const { Player } = require("../dou/player");
const { GomokuGame } = require("../command/gomoku/game");
const { XiangqiGame } = require("../command/xiangqi/game");
const { UnoGame } = require("../command/uno/game");
const { JunqiGame, RED: JUNQI_RED, BLUE: JUNQI_BLUE } = require("../command/junqi/game");

const dou = new DouDiZhuGame();
dou.addPlayer("a", "甲");
dou.addPlayer("b", "乙");
dou.addPlayer("c", "丙");
dou.initGame();
dou.robLandlord(dou.players[0], true);
dou.drawBottomCards(dou.players[0]);
check("T1 dou 发牌17张+底牌3张", dou.players[0].cards.length === 20);
dou.play([dou.players[0].cards[0]]); // 地主出最小的一张，出完剩 19 张
check("T1 dou 地主出牌后剩19张", dou.players[0].cards.length === 19);

const gomoku = new GomokuGame();
gomoku.addPlayer("a", "甲");
gomoku.addPlayer("b", "乙");
gomoku.start(true);
const black = gomoku.playerByColor(1);
gomoku.place(black.id, 8, 8);
const white = gomoku.playerByColor(2);
gomoku.place(white.id, 9, 9);
check("T1 gomoku 两手下完轮到黑", gomoku.turnColor === 1);

const xiangqi = new XiangqiGame();
xiangqi.addPlayer("a", "甲");
xiangqi.addPlayer("b", "乙");
xiangqi.start(false);
check("T1 xiangqi 红方炮二平五", xiangqi.tryMove("a", "炮二平五").ok);
check("T1 xiangqi 黑方马8进7", xiangqi.tryMove("b", "马8进7").ok);

const uno = new UnoGame();
uno.addPlayer("a", "甲");
uno.addPlayer("b", "乙");
uno.addPlayer("c", "丙");
check("T1 uno 开局", uno.start("a").ok);
uno.tryDraw("a"); // 打乱回合也无所谓，后面直接注入牌面重测

store.gameMaps.dou.set("room-d", dou);
store.gameMaps.gomoku.set("room-g", gomoku);
store.gameMaps.xiangqi.set("room-x", xiangqi);
store.gameMaps.uno.set("room-u", uno);
const junqi = new JunqiGame();
junqi.addPlayer("a", "甲");
junqi.addPlayer("b", "乙");
junqi.randomDeploy(JUNQI_RED);
junqi.randomDeploy(JUNQI_BLUE);
junqi.startIfReady();
store.gameMaps.junqi.set("room-j", junqi);
store.modeMap.set("room-d", "斗地主");
store.modeMap.set("room-u", "UNO");
store.modeMap.set("room-j", "军棋");

const before = {
    dou: snapshotOf(store.gameMaps.dou, "room-d"),
    gomoku: snapshotOf(store.gameMaps.gomoku, "room-g"),
    xiangqi: snapshotOf(store.gameMaps.xiangqi, "room-x"),
    uno: snapshotOf(store.gameMaps.uno, "room-u"),
    junqi: snapshotOf(store.gameMaps.junqi, "room-j"),
};
store.save();
check("T1 快照文件已落盘", fs.existsSync(process.env.state_file));

store.gameMaps.dou.clear();
store.gameMaps.gomoku.clear();
store.gameMaps.xiangqi.clear();
store.gameMaps.uno.clear();
store.gameMaps.junqi.clear();
store.modeMap.clear();
check("T1 restore 返回 true", store.restore() === true);

check("T1 模式表往返", store.modeMap.get("room-d") === "斗地主" && store.modeMap.get("room-u") === "UNO" &&
    store.modeMap.get("room-j") === "军棋");
check("T1 五张桌都回来了",
    store.gameMaps.dou.size === 1 && store.gameMaps.gomoku.size === 1 &&
    store.gameMaps.xiangqi.size === 1 && store.gameMaps.uno.size === 1 &&
    store.gameMaps.junqi.size === 1);

const rd = store.gameMaps.dou.get("room-d");
check("T1 dou 快照逐字段一致", snapshotOf(store.gameMaps.dou, "room-d") === before.dou);
check("T1 dou 实例带原型", rd instanceof DouDiZhuGame && rd.players[0] instanceof Player);
check("T1 dou landlord 指回同一实例", rd.landlord === rd.players.find((p) => p.id === rd.landlord.id) && rd.landlord.isLandlord === true);
check("T1 dou 恢复后方法可用", rd.getCurrentPlayer().name === "乙" && rd.players[0].cards.length === 19);

const rg = store.gameMaps.gomoku.get("room-g");
check("T1 gomoku 快照一致", snapshotOf(store.gameMaps.gomoku, "room-g") === before.gomoku);
check("T1 gomoku 恢复后能继续下", rg.place(rg.current().id, 8, 9).ok === true && rg.moves.length === 3);

const rx = store.gameMaps.xiangqi.get("room-x");
check("T1 xiangqi 快照一致", snapshotOf(store.gameMaps.xiangqi, "room-x") === before.xiangqi);
check("T1 xiangqi 恢复后能继续走", rx.tryMove("a", "马二进三").ok === true);

const ru = store.gameMaps.uno.get("room-u");
check("T1 uno 快照一致", snapshotOf(store.gameMaps.uno, "room-u") === before.uno);
check("T1 uno 恢复后状态可读", ru.boardText().length > 0 && ru.statusText("a").includes("甲"));

// 赢家引用往返：gameOver 时 winner 应指回 players 里的同一个对象
const u2 = new UnoGame();
u2.addPlayer("a", "甲");
u2.addPlayer("b", "乙");
u2.start("a");
u2.gameOver = true;
u2.winner = u2.players[1];
store.gameMaps.uno.set("room-u2", u2);
store.save();
store.gameMaps.uno.clear();
store.restore();
const rw = store.gameMaps.uno.get("room-u2");
check("T1 uno winner 指回同一实例", rw.winner === rw.players[1]);
store.gameMaps.uno.delete("room-u2");

// ---------- T2 热重载：不重复挂监听 + 槽位切换 ----------
const groupBefore = dispatch.handlers.group;
const privateBefore = dispatch.handlers.private;
const listenersBefore = client.listenerCount("message.group");
check("T2 启动时只有 1 个群监听", listenersBefore === 1);

const report2 = reloadAll();
check("T2 全部文件重载成功", report2.length >= 2 && report2.every((l) => l.startsWith("OK")));
check("T2 重载后群监听还是 1 个", client.listenerCount("message.group") === 1);
check("T2 群处理器换了新函数", dispatch.handlers.group !== groupBefore);
check("T2 私聊处理器换了新函数", dispatch.handlers.private !== privateBefore);

// 换过槽位的新处理器要真的能干活
let modeReply = null;
dispatch.handlers.group({
    group_id: "room-hot-test",
    message: [{ type: "text", text: "#模式" }],
    reply: (msg) => { modeReply = msg; },
    atme: false,
    client,
});
check("T2 新群处理器能应答 #模式", typeof modeReply === "string" && modeReply.includes("当前模式"));

// ---------- T3 失败保旧：坏文件不换槽 ----------
const groupPath = path.join(__dirname, "..", "message", "group.js");
const originalGroup = fs.readFileSync(groupPath, "utf8");
const keeper = dispatch.handlers.group;
try {
    fs.writeFileSync(groupPath, "syntax error {{{ not valid js");
    const report3 = reloadAll();
    check("T3 坏文件被报告为 FAIL", report3.some((l) => l.startsWith("FAIL") && l.includes("group.js")));
    check("T3 坏文件时旧处理器原样在岗", dispatch.handlers.group === keeper);
    check("T3 监听数不变", client.listenerCount("message.group") === 1);
} finally {
    fs.writeFileSync(groupPath, originalGroup);
}
const report4 = reloadAll();
check("T4 修好后重载全部 OK", report4.every((l) => l.startsWith("OK")));
check("T4 修好后换成新处理器", dispatch.handlers.group !== keeper);

// ---------- T5 引擎类 rebase：老牌局挂上新原型 ----------
// 直接取当前缓存里的类（T4 重载链刚加载的那份），不能再删缓存重 require，否则又生成新类
const FreshUno = require("../command/uno/game").UnoGame;
const FreshDou = require("../dou/game").DouDiZhuGame;
const FreshPlayer = require("../dou/player").Player;
// rebase 只作用于牌桌 Map 里的实例，这里取 Map 里的当前实例来验
const curUno = store.gameMaps.uno.get("room-u");
const curDou = store.gameMaps.dou.get("room-d");
const FreshJunqi = require("../command/junqi/game").JunqiGame;
const curJunqi = store.gameMaps.junqi.get("room-j");
check("T5 老 UNO 局 instanceof 新引擎类", curUno instanceof FreshUno);
check("T5 老斗地主局 instanceof 新引擎类", curDou instanceof FreshDou && curDou.players[0] instanceof FreshPlayer);
check("T5 老军棋局 instanceof 新引擎类", curJunqi instanceof FreshJunqi);
check("T5 军棋快照逐字段一致", snapshotOf(store.gameMaps.junqi, "room-j") === before.junqi);
let jqFrom = null, jqTo = null;
for (const [l, p] of Object.entries(curJunqi.board)) {
    if (p.side !== curJunqi.turn) continue;
    const ms = curJunqi.legalMoves(l);
    if (ms.length) { jqFrom = l; jqTo = ms[0]; break; }
}
check("T5 军棋恢复后引擎方法可用、能继续走子",
    !!jqFrom && curJunqi.tryMove(curJunqi.playerBySide(curJunqi.turn).id, jqFrom + "-" + jqTo).ok);
check("T5 rebase 后方法仍可用", curUno.countsText().includes("甲") && curDou.getCurrentPlayer().name === "乙");

// ---------- T6 cc热更 命令 ----------
let hotReply = null;
getSmallCommand({ reply: (msg) => { hotReply = msg; } }, "热更");
check("T6 cc热更 有回执", typeof hotReply === "string" && hotReply.includes("热更"));

// ---------- 收尾 ----------
store.gameMaps.dou.clear();
store.gameMaps.gomoku.clear();
store.gameMaps.xiangqi.clear();
store.gameMaps.uno.clear();
store.gameMaps.junqi.clear();
store.modeMap.clear();
store.save();
try { fs.unlinkSync(process.env.state_file); } catch (e) { /* 不存在就算了 */ }

console.log("热更新测试：" + passed + " 通过，" + failed + " 失败");
process.exit(failed ? 1 : 0);
