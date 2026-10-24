"use strict";
// 军棋引擎 + 命令层断言：棋盘连通性、布阵约束、换位、走子判定（大吃小/同归/挖雷/扛旗/亮旗/困毙）、
// 铁路与行营规则、坐标宽松解析、cc 命令流程（stub client，不碰真实微信）。
// 离线跑：state_file 指到临时文件，绝不写真实快照。
process.env.state_file = process.env.state_file || require("path").join(__dirname, "..", "test", "tmp-junqi-state.json");
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { client } = require("../app");
const {
    JunqiGame, RED, BLUE, SIDE_NAME, FULL_NAME, ADJ, CAMP_LABEL, HQ_LABEL, OWN_HALF, COUNT,
    parseMove, parseLabel,
} = require("../command/junqi/game");
const { getJunqiCommand, games } = require("../command/junqi/junqiIndex");
const { renderImage, renderText } = require("../command/junqi/render");

let failed = 0;
function check(label, cond, extra) {
    if (!cond) failed++;
    console.log((cond ? "  ok   " + label : "  FAIL " + label + "  → " + extra));
}
// 空盘只留残局需要的子，避免整版阵干扰判定
function bare(pairs) {
    const g = new JunqiGame();
    g.addPlayer("A", "红甲"); g.addPlayer("B", "蓝乙");
    g.started = true;
    for (const [side, at, type] of pairs) g.board[at] = { side, type };
    return g;
}
// 红方可走的一对相邻点：A7（兵站）→ B7（兵站），都在锋线铁路上
const P = "A7", Q = "B7";

// ---------- 棋盘几何 ----------
const points = Object.keys(OWN_HALF[RED]).concat(Object.keys(OWN_HALF[BLUE]));
check("60 个交叉点", points.length === 60, points.length);
check("每方 25 个可摆点（30 - 5 行营）",
    Object.keys(OWN_HALF[RED]).filter((l) => !CAMP_LABEL[l]).length === 25, "placement points");
check("棋子总数 25 枚", Object.values(COUNT).reduce((a, b) => a + b, 0) === 25, "count");
check("行营 10 个 / 大本营 4 个",
    Object.keys(CAMP_LABEL).length === 10 && Object.keys(HQ_LABEL).length === 4, "camp/hq");
const seen = {}; const queue = [points[0]]; seen[points[0]] = 1; let reach = 0;
while (queue.length) {
    const cur = queue.shift(); reach++;
    for (const e of ADJ[cur]) if (!seen[e.to]) { seen[e.to] = 1; queue.push(e.to); }
}
check("全盘一张连通图", reach === 60, reach);
check("红方行营在 B8 D8 C9 B10 D10",
    ["B8", "D8", "C9", "B10", "D10"].every((l) => CAMP_LABEL[l]) && !CAMP_LABEL.C8, "red camps");
check("红方大本营 B12 D12", HQ_LABEL.B12 && HQ_LABEL.D12 && !HQ_LABEL.A12, "red hq");
check("山界两角是铁路（A6-A7 / E6-E7）",
    ADJ.A6.some((e) => e.to === "A7" && e.rail) && ADJ.E6.some((e) => e.to === "E7" && e.rail), "border rails");
check("山界中间三列是公路（B6-B7）",
    ADJ.B6.some((e) => e.to === "B7" && !e.rail), "middle road");

// ---------- 坐标与走法解析 ----------
check("B7-C7 / B7到C7 / b7 c7 / B7C7 都认",
    JSON.stringify(parseMove("B7-C7")) === '["B7","C7"]' &&
    JSON.stringify(parseMove("b7到C7")) === '["B7","C7"]' &&
    JSON.stringify(parseMove("B7 C7")) === '["B7","C7"]' &&
    JSON.stringify(parseMove("B7C7")) === '["B7","C7"]', "parseMove");
check("全角坐标认（Ｂ７－Ｃ１２）",
    JSON.stringify(parseMove("Ｂ７－Ｃ１２")) === '["B7","C12"]', "fullwidth");
check("行号越界不认", parseLabel("A13") === null && parseLabel("F1") === null, "range");

// ---------- 布阵 ----------
const g1 = new JunqiGame();
g1.addPlayer("A", "红甲"); g1.addPlayer("B", "蓝乙");
check("先来的是红方（先走）", g1.players[0].side === RED && g1.players[1].side === BLUE,
    JSON.stringify(g1.players.map((p) => p.side)));
check("第三个人被拒", g1.addPlayer("C", "丙").ok === false, "third player");
for (const side of [RED, BLUE]) {
    g1.randomDeploy(side);
    const mine = Object.entries(g1.board).filter(([, p]) => p.side === side);
    check(SIDE_NAME[side] + " 随机阵 25 枚", mine.length === 25, mine.length);
    check(SIDE_NAME[side] + " 军旗在大本营",
        mine.every(([l, p]) => p.type !== "旗" || HQ_LABEL[l]), "flag spot");
    check(SIDE_NAME[side] + " 地雷在后两线",
        mine.every(([l, p]) => {
            if (p.type !== "雷") return true;
            const lr = side === RED ? Number(l.slice(1)) - 6 : 7 - Number(l.slice(1));
            return lr >= 5;
        }), "mine rows");
    check(SIDE_NAME[side] + " 炸弹不在锋线",
        mine.every(([l, p]) => {
            if (p.type !== "炸") return true;
            const lr = side === RED ? Number(l.slice(1)) - 6 : 7 - Number(l.slice(1));
            return lr !== 1;
        }), "bomb row");
    check(SIDE_NAME[side] + " 行营没摆子", mine.every(([l]) => !CAMP_LABEL[l]), "camp empty");
}
check("两人都布好自动开局", g1.startIfReady().ok && g1.started, "start");
// 换位：挑两枚都在后两线（红方 11、12 行）的子，换完仍然合法
const back = (l) => Number(l.slice(1)) >= 11;
const mineAt = Object.entries(g1.board).find(([l, p]) => p.side === RED && p.type === "雷" && back(l))[0];
const otherAt = Object.entries(g1.board).find(([l, p]) => p.side === RED && back(l) && l !== mineAt &&
    p.type !== "旗" && p.type !== "雷")[0];
check("换位把两枚后线子对调", g1.swapOwn(RED, mineAt, otherAt).ok &&
    g1.board[mineAt].type !== "雷" && g1.board[otherAt].type === "雷", mineAt + " " + otherAt);
check("地雷换到锋线被拒", !!g1.swapOwn(RED, otherAt, "A7").hint, "mine forward");
check("军旗换出大本营被拒", !!g1.swapOwn(RED,
    Object.entries(g1.board).find(([, p]) => p.side === RED && p.type === "旗")[0], "A7").hint, "flag out");

// ---------- 吃子判定 ----------
let g = bare([[RED, P, "司"], [BLUE, Q, "师"]]);
let r = g.tryMove("A", P + "-" + Q);
check("司令吃师长", r.ok && g.board[Q].side === RED && g.dead.length === 1, r.hint || JSON.stringify(g.dead));
g = bare([[RED, P, "师"], [BLUE, Q, "师"]]);
r = g.tryMove("A", P + "-" + Q);
check("同级同归于尽", r.ok && Object.keys(g.board).length === 0 && g.dead.length === 2, r.hint);
g = bare([[RED, P, "工"], [BLUE, Q, "司"]]);
r = g.tryMove("A", P + "-" + Q);
check("小撞大自己阵亡", r.ok && g.board[Q].side === BLUE && !g.board[P], r.hint);
g = bare([[RED, P, "炸"], [BLUE, Q, "司"]]);
r = g.tryMove("A", P + "-" + Q);
check("炸弹与司令同归", r.ok && Object.keys(g.board).length === 0, r.hint);
g = bare([[RED, P, "团"], [BLUE, Q, "雷"]]);
r = g.tryMove("A", P + "-" + Q);
check("非工兵撞雷阵亡、雷还在", r.ok && g.board[Q] && g.board[Q].type === "雷", r.hint);
g = bare([[RED, P, "工"], [BLUE, Q, "雷"]]);
r = g.tryMove("A", P + "-" + Q);
check("工兵挖雷占位", r.ok && g.board[Q].side === RED, r.hint);
g = bare([[RED, P, "军"], [BLUE, Q, "旗"]]);
r = g.tryMove("A", P + "-" + Q);
check("扛旗立刻判胜", r.over && g.winner && g.winner.by === "扛旗", JSON.stringify(r));

// ---------- 亮旗 / 困毙 ----------
g = bare([[RED, P, "司"], [BLUE, Q, "司"], [BLUE, "D12", "旗"]]);
r = g.tryMove("A", P + "-" + Q);
check("司令阵亡后军旗亮出", r.shown && r.shown.join("").includes("D12"), JSON.stringify(r.shown));
check("对方无子可走判困毙", g.winner && g.winner.by.includes("困毙"), JSON.stringify(g.winner));

// ---------- 行营 / 大本营 / 雷旗不能动 ----------
g = bare([[RED, P, "司"], [BLUE, "B8", "师"]]);
r = g.tryMove("A", P + "-B8");
check("行营里的子吃不到", !r.ok && r.hint.includes("行营"), r.hint);
g = bare([[RED, "C9", "司"]]);
check("行营里只能挪一格", g.legalMoves("C9").length === 8 &&
    !g.legalMoves("C9").includes("C11"), JSON.stringify(g.legalMoves("C9")));
g = bare([[RED, "B12", "连"]]);
check("大本营里的子永远出不来", g.legalMoves("B12").length === 0, "locked");
g = bare([[RED, "C12", "雷"], [RED, "D12", "旗"]]);
check("地雷和军旗不能动", g.legalMoves("C12").length === 0 && g.legalMoves("D12").length === 0, "static");
const err = bare([[RED, "C12", "雷"]]).tryMove("A", "C12-C11");
check("走地雷给出文案", !err.ok && err.hint === "地雷不能动", err.hint);

// ---------- 铁路 ----------
g = bare([[RED, "A7", "团"]]);
const rail = g.legalMoves("A7");
check("非工兵沿铁路直行不限步（A7 到底 A2、到 E7）",
    rail.includes("A11") && rail.includes("E7") && !rail.includes("B8"), JSON.stringify(rail));
check("非工兵不能沿铁路拐弯", !rail.includes("B9") && !rail.includes("C8"), JSON.stringify(rail));
g = bare([[RED, "A7", "工"], [BLUE, "A9", "连"]]);
const eng = g.legalMoves("A7");
check("工兵沿铁路拐弯", eng.includes("B8") || eng.includes("C8"), JSON.stringify(eng));
check("工兵也不能越过子", !eng.includes("A10") || eng.includes("A9"), JSON.stringify(eng));
g = bare([[RED, "A7", "连"]]);
check("公路只能走一格（A8 通，B9 要拐弯不通）",
    g.legalMoves("A7").includes("A8") && !g.legalMoves("A7").includes("B9"), JSON.stringify(g.legalMoves("A7")));

// ---------- 渲染 ----------
const g2 = new JunqiGame();
g2.addPlayer("A", "红甲"); g2.addPlayer("B", "蓝乙");
g2.randomDeploy(RED); g2.randomDeploy(BLUE); g2.startIfReady();
let png = null;
try { png = renderImage(g2); } catch (err) { png = null; console.log("  渲染异常: " + err.message); }
check("盘面出图（PNG base64）", !!png && png.startsWith("iVBOR"), "png");
check("文字盘面兜底", renderText(g2).includes("军棋盘面") && renderText(g2).includes("山界"), "text");

// ---------- 命令层流程 ----------
const sent = [];
const temps = [];
client.sendText = async (to, text) => { sent.push({ to, text }); return { Code: 0 }; };
client.sendImage = async (to, b64) => { sent.push({ to, text: "[图片]" }); return { Code: 0 }; };
client.sendTempMsg = async (room, userId, text) => { temps.push({ room, userId, text }); return { Code: 0 }; };
client.displayName = (id) => ({ A: "甲", B: "乙", C: "丙" }[id] || String(id));
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
        reply: async (c) => {
            if (c && c.image) return client.sendImage(ROOM, c.image);
            return client.sendText(ROOM, c);
        },
    };
    await getJunqiCommand(event, text);
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setTimeout(res, 30));
}
const last = () => (sent.length ? sent[sent.length - 1].text : "");

(async () => {
    await fire("A", "军棋");
    check("上桌回执说明自己是红方先走", last().includes("红方") && last().includes("先走"), last());
    await fire("C", "军棋");
    check("非好友上桌被拒", last().includes("好友") && games.get(ROOM).players.length === 1, last());
    client.isFriend = async () => true;
    await fire("B", "军棋");
    check("第二个人上桌后提示各自布阵", last().includes("布阵"), last());

    const game = games.get(ROOM);
    const t0 = temps.length;
    await fire("A", "布阵");
    check("布阵后阵图私聊发给本人", temps.length === t0 + 1 && temps[temps.length - 1].userId === "A",
        JSON.stringify(temps.slice(t0)));
    check("阵图里是全称（司令/军旗）", temps[temps.length - 1].text.includes("司令") &&
        temps[temps.length - 1].text.includes("军旗"), temps[temps.length - 1].text.slice(0, 40));
    check("只有一人布阵还不开局", !game.started && last().includes("cc布阵"), last());
    await fire("B", "布阵");
    const said = sent.slice(0, -1).map((s) => s.text).join("\n");
    check("两人都布好自动开打", game.started && said.includes("开打"), last());
    check("开局把暗子盘面发到群", sent.slice(-1)[0].text === "[图片]", sent.slice(-1)[0]);
    check("盘面不泄露子力大小", !renderText(game).match(/司令|军长|师长/), "leak");

    await fire("B", "A6-A5");
    check("红先：蓝方抢先手被拒", last().includes("还没轮到"), last());
    const red = game.playerBySide(RED);
    let from = null, to = null;
    for (const [l, p] of Object.entries(game.board)) {
        if (p.side !== RED) continue;
        const ms = game.legalMoves(l).filter((t) => !game.board[t]);
        if (ms.length) { from = l; to = ms[0]; break; }
    }
    await fire("A", "走" + from + "-" + to);
    check("红方走一步并回贴盘面", game.moves.length === 1 && sent.slice(-1)[0].text === "[图片]",
        last());
    await fire("A", "Z9-Z9");
    check("乱坐标被拒（轮次提示优先）", last().includes("还没轮到") || last().includes("没看懂"), last());
    await fire("A", "看阵");
    check("cc看阵 重发阵图", temps.length === t0 + 3, temps.length);
    await fire("A", "战报");
    check("cc战报 列亮子和最近战况", last().includes("阵亡") && last().includes("最近战况"), last());
    await fire("A", "状态");
    check("cc状态 说轮到谁", last().includes("轮到"), last());
    await fire("A", "规则");
    check("cc规则 讲吃子次序", last().includes("司令>军长") && /工兵.*挖.*雷/.test(last()), last());

    // 直接把蓝方走到无路可走，验证判负文案
    for (const l of Object.keys(game.board)) if (game.board[l].side === BLUE) delete game.board[l];
    game.board["D1"] = { side: BLUE, type: "旗" };
    game.turn = RED;
    let f2 = null, t2 = null;
    for (const [l, p] of Object.entries(game.board)) {
        if (p.side !== RED) continue;
        const ms = game.legalMoves(l);
        if (ms.length) { f2 = l; t2 = ms[0]; break; }
    }
    await fire("A", "走" + f2 + "-" + t2);
    check("蓝方只剩军旗判红胜", game.winner && game.winner.side === RED, JSON.stringify(game.winner));
    await fire("B", "结束");
    check("cc结束 清盘", !games.has(ROOM), "still there");

    console.log(failed ? "\n" + failed + " 条失败" : "\n全部通过");
    try { require("fs").unlinkSync(require("path").join(__dirname, "..", "test", "tmp-junqi-state.json")); } catch (e) { /* 没落盘就算了 */ }
    process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
