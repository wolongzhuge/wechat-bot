"use strict";
// 军棋（陆战棋）两人暗棋引擎。机器人当裁判：每人只知道自己子力的大小和位置，
// 群里只贴「暗子盘面 + 阵亡亮子」，谁吃了谁由这里判定。
//
// 棋盘：5 列（A~E，左→右）× 12 行（1~12，上→下），交叉点连线分铁路（粗，直行不限步）和公路（细，一步）。
// 蓝方占 1~6 行（锋线=第 6 行，端线=第 1 行），红方占 7~12 行（锋线=第 7 行，端线=第 12 行）。
// 每方半区是 6 行×5 列 = 30 个点：5 个行营 + 23 个兵站 + 2 个大本营，25 枚棋子铺满兵站和大本营。
// 局部行号 1~6 依次是锋线、二线、三线、四线、底线、端线；行营在 (2,2)(2,4)(3,3)(4,2)(4,4)，大本营在 (6,2)(6,4)。
// 连线表按标准陆战棋盘手工整理，要改铁路走向只动 HALF_EDGES / CROSS_EDGES。

const COL_LETTER = ["A", "B", "C", "D", "E"];
const BLUE = "b", RED = "r";
const SIDE_NAME = { [RED]: "红方", [BLUE]: "蓝方" };

// 单字记子，群里/私聊都用全称；司令>军长>师长>旅长>团长>营长>连长>排长>工兵
const FULL_NAME = {
    司: "司令", 军: "军长", 师: "师长", 旅: "旅长", 团: "团长", 营: "营长",
    连: "连长", 排: "排长", 工: "工兵", 炸: "炸弹", 雷: "地雷", 旗: "军旗",
};
const RANK = { 司: 9, 军: 8, 师: 7, 旅: 6, 团: 5, 营: 4, 连: 3, 排: 2, 工: 1 };
const COUNT = { 旗: 1, 司: 1, 军: 1, 师: 2, 旅: 2, 团: 2, 营: 2, 炸: 2, 连: 3, 排: 3, 工: 3, 雷: 3 };
const CANNOT_MOVE = { 雷: "地雷不能动", 旗: "军旗不能动" };

// 半区内连线：[局部行1, 局部列1, 局部行2, 局部列2, 线型]，R=铁路 P=公路
const HALF_EDGES = [
    // 锋线横向（铁路）
    [1, 1, 1, 2, "R"], [1, 2, 1, 3, "R"], [1, 3, 1, 4, "R"], [1, 4, 1, 5, "R"],
    // 二线横向（铁路）
    [2, 1, 2, 2, "R"], [2, 2, 2, 3, "R"], [2, 3, 2, 4, "R"], [2, 4, 2, 5, "R"],
    // 左右边路纵向（铁路，锋线到底线）
    [1, 1, 2, 1, "R"], [2, 1, 3, 1, "R"], [3, 1, 4, 1, "R"], [4, 1, 5, 1, "R"],
    [1, 5, 2, 5, "R"], [2, 5, 3, 5, "R"], [3, 5, 4, 5, "R"], [4, 5, 5, 5, "R"],
    // 底线横向（铁路）
    [5, 1, 5, 2, "R"], [5, 2, 5, 3, "R"], [5, 3, 5, 4, "R"], [5, 4, 5, 5, "R"],
    // 三线、四线横向（公路）
    [3, 1, 3, 2, "P"], [3, 2, 3, 3, "P"], [3, 3, 3, 4, "P"], [3, 4, 3, 5, "P"],
    [4, 1, 4, 2, "P"], [4, 2, 4, 3, "P"], [4, 3, 4, 4, "P"], [4, 4, 4, 5, "P"],
    // 中路纵向：咽部-中营-脐部（公路）
    [2, 3, 3, 3, "P"], [3, 3, 4, 3, "P"],
    // 前营到左腹右腹、左腹右腹到底营（公路）
    [2, 2, 3, 2, "P"], [2, 4, 3, 4, "P"],
    [3, 2, 4, 2, "P"], [3, 4, 4, 4, "P"],
    // 中营到四个行营的斜线（公路）
    [3, 3, 2, 2, "P"], [3, 3, 2, 4, "P"], [3, 3, 4, 2, "P"], [3, 3, 4, 4, "P"],
    // 锋线棋眉到前营（公路）
    [1, 2, 2, 2, "P"], [1, 4, 2, 4, "P"],
    // 底线到端线（大本营那一行，公路）
    [5, 1, 6, 1, "P"], [5, 2, 6, 2, "P"], [5, 3, 6, 3, "P"], [5, 4, 6, 4, "P"], [5, 5, 6, 5, "P"],
];
// 山界：两半区锋线对接。边路两条延续成铁路，中间三条是公路
const CROSS_EDGES = [[1, "R"], [2, "P"], [3, "P"], [4, "P"], [5, "R"]];

const CAMP_LOCAL = [[2, 2], [2, 4], [3, 3], [4, 2], [4, 4]];
const HQ_LOCAL = [[6, 2], [6, 4]];

function localRow(side, row) {
    return side === BLUE ? 7 - row : row - 6;
}
function globalRow(side, lr) {
    return side === BLUE ? 7 - lr : 6 + lr;
}
function label(lc, row) {
    return COL_LETTER[lc - 1] + row;
}
function sideOfRow(row) {
    return row <= 6 ? BLUE : RED;
}
// 坐标写法宽松：大小写、全角数字和字母都认
function fullWidth(text) {
    return String(text || "").replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}
function parseLabel(text) {
    const m = fullWidth(text).trim().toUpperCase().match(/^([A-E])(\d{1,2})$/);
    if (!m) return null;
    const row = Number(m[2]);
    if (row < 1 || row > 12) return null;
    return m[1] + row;
}
// 走子写法：B7-C7 / B7到C7 / b7 c7 / B7C7 连写都认
function parseMove(text) {
    const parts = fullWidth(text).trim().split(/[\s\-—~～至到、，,]+/).filter(Boolean);
    if (parts.length === 2) {
        const a = parseLabel(parts[0]), b = parseLabel(parts[1]);
        return a && b ? [a, b] : null;
    }
    if (parts.length === 1) {
        const m = parts[0].toUpperCase().match(/^([A-E]\d{1,2})([A-E]\d{1,2})$/);
        if (m) {
            const a = parseLabel(m[1]), b = parseLabel(m[2]);
            if (a && b) return [a, b];
        }
    }
    return null;
}

const ADJ = {};          // label -> [{to, rail}]
const RAIL_LABEL = {};   // label -> true（挨着铁路的点）
const CAMP_LABEL = {};   // label -> true
const HQ_LABEL = {};     // label -> true
const OWN_HALF = { [RED]: {}, [BLUE]: {} };

for (const side of [RED, BLUE]) {
    for (let lr = 1; lr <= 6; lr++) {
        for (let lc = 1; lc <= 5; lc++) {
            const g = label(lc, globalRow(side, lr));
            OWN_HALF[side][g] = true;
        }
    }
    CAMP_LOCAL.forEach(([lr, lc]) => { CAMP_LABEL[label(lc, globalRow(side, lr))] = true; });
    HQ_LOCAL.forEach(([lr, lc]) => { HQ_LABEL[label(lc, globalRow(side, lr))] = true; });
}

function addEdge(a, b, type) {
    (ADJ[a] = ADJ[a] || []).push({ to: b, rail: type === "R" });
    (ADJ[b] = ADJ[b] || []).push({ to: a, rail: type === "R" });
    if (type === "R") { RAIL_LABEL[a] = true; RAIL_LABEL[b] = true; }
}
for (const side of [RED, BLUE]) {
    for (const [r1, c1, r2, c2, type] of HALF_EDGES) {
        addEdge(label(c1, globalRow(side, r1)), label(c2, globalRow(side, r2)), type);
    }
}
for (const [lc, type] of CROSS_EDGES) {
    addEdge(label(lc, 6), label(lc, 7), type);
}
// 方向用全局行列差的符号表示，铁路直行要一直保持同一方向
function dirOf(a, b) {
    const ra = Number(a.slice(1)), rb = Number(b.slice(1));
    const ca = COL_LETTER.indexOf(a[0]), cb = COL_LETTER.indexOf(b[0]);
    return Math.sign(rb - ra) + "," + Math.sign(cb - ca);
}

function makeDeck() {
    const out = [];
    for (const [type, n] of Object.entries(COUNT)) for (let i = 0; i < n; i++) out.push(type);
    return out;
}
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

class JunqiGame {
    constructor() {
        this.board = {};        // "B7" -> {side, type}
        this.players = [];      // {id, name, side, deployed}
        this.dead = [];         // 亮出来的阵亡子 [{side, type, at, how}]
        this.flagShown = {};    // 司令阵亡后亮旗：side -> "B12"
        this.log = [];          // 公开战报 [{side, text}]
        this.moves = [];        // 手数统计用
        this.turn = RED;        // 红先
        this.winner = null;     // {playerId, name, side, by}
        this.started = false;
    }

    addPlayer(id, name) {
        if (this.players.length >= 2) return { ok: false, reason: "两个人已经齐了" };
        if (this.players.some((p) => p.id === id)) return { ok: false, reason: "你已经在这局里了" };
        if (this.started) return { ok: false, reason: "已经开局，不能再加人；要重开先发 cc结束" };
        // 布阵要先知道自己是哪一方，所以入座就定色：先来的是红方先走
        const side = this.players.length === 0 ? RED : BLUE;
        this.players.push({ id, name, side, deployed: false });
        return { ok: true, player: { id, name, side } };
    }

    playerById(id) { return this.players.find((p) => p.id === id); }
    playerBySide(side) { return this.players.find((p) => p.side === side); }

    // ---- 布阵 ----

    ownPoints(side) {
        return Object.keys(OWN_HALF[side]).filter((l) => !CAMP_LABEL[l]);
    }

    // 摆位约束：军旗只在大本营，地雷只在后两线（局部 5、6 行），炸弹不在锋线，行营不许摆子
    placementOK(side, type, at) {
        if (CAMP_LABEL[at]) return "行营里不能摆子";
        if (!OWN_HALF[side][at]) return "只能摆在自己半区";
        if (type === "旗") return HQ_LABEL[at] ? null : "军旗只能摆在大本营";
        const lr = localRow(side, Number(at.slice(1)));
        if (type === "雷" && lr < 5) return "地雷只能摆在后两线";
        if (type === "炸" && lr === 1) return "炸弹不能摆在锋线";
        return null;
    }

    // 随机一版符合约束的阵：军旗随机放一个小本营，地雷铺后两线，炸弹避开锋线
    randomDeploy(side) {
        const points = this.ownPoints(side);
        const hq = points.filter((p) => HQ_LABEL[p]);
        const back = points.filter((p) => localRow(side, Number(p.slice(1))) >= 5 && !HQ_LABEL[p]);
        const front = points.filter((p) => localRow(side, Number(p.slice(1))) === 1);
        const place = {};
        const used = {};
        const take = (list) => {
            const free = list.filter((p) => !used[p]);
            if (!free.length) return null;
            const pick = free[Math.floor(Math.random() * free.length)];
            used[pick] = true;
            return pick;
        };
        place[take(hq)] = "旗";
        for (let i = 0; i < 3; i++) place[take(back)] = "雷";
        // 炸弹要避开锋线；剩下的点里挑两个
        const noFront = points.filter((p) => !used[p] && !front.includes(p));
        for (let i = 0; i < 2; i++) place[take(noFront)] = "炸";
        const free = points.filter((p) => !used[p]);
        const others = shuffle(makeDeck().filter((t) => !["旗", "雷", "炸"].includes(t)));
        others.forEach((type, i) => { place[free[i]] = type; });
        for (const l of Object.keys(this.board)) if (this.board[l] && this.board[l].side === side) delete this.board[l];
        for (const [at, type] of Object.entries(place)) this.board[at] = { side, type };
        const player = this.playerBySide(side);
        if (player) player.deployed = true;
        return { ok: true, side };
    }

    // 交换自己两枚棋子（开局前用），换完还得满足摆位约束
    swapOwn(side, a, b) {
        const pa = this.board[a], pb = this.board[b];
        if (!pa || pa.side !== side) return { ok: false, hint: a + " 没有你的棋子" };
        if (!pb || pb.side !== side) return { ok: false, hint: b + " 没有你的棋子" };
        const errA = this.placementOK(side, pb.type, a);
        const errB = this.placementOK(side, pa.type, b);
        if (errA || errB) return { ok: false, hint: "这两枚换不了：" + (errA || errB) };
        this.board[a] = pb; this.board[b] = pa;
        return { ok: true };
    }

    // 两人都布好阵就自动开打，红先
    startIfReady() {
        if (this.started || this.players.length < 2) return { ok: false, hint: "还差人上桌" };
        if (!this.players.every((p) => p.deployed)) {
            const wait = this.players.filter((p) => !p.deployed).map((p) => p.name);
            return { ok: false, hint: "等 " + wait.join("、") + " 发 cc布阵" };
        }
        this.started = true;
        this.turn = RED;
        return { ok: true };
    }

    // 私聊发给本人的阵图：半区六行，按本人视角从锋线往自家底线排
    layoutText(side) {
        const lines = [];
        lines.push("【军棋】" + SIDE_NAME[side] + " 你的布阵（A~E 从左到右，行号见群盘面）");
        for (let lr = 1; lr <= 6; lr++) {
            const row = globalRow(side, lr);
            const cells = [];
            for (let lc = 1; lc <= 5; lc++) {
                const l = label(lc, row);
                if (CAMP_LABEL[l]) cells.push("行营");
                else {
                    const p = this.board[l];
                    cells.push(p ? FULL_NAME[p.type] : (HQ_LABEL[l] ? "空营" : "空"));
                }
            }
            lines.push(ROW_TAG[lr] + " 第" + row + "行 " + cells.join(" "));
        }
        lines.push("改阵：cc换位 B12 C12（交换两枚）；整套重来：cc布阵");
        return lines.join("\n");
    }

    // ---- 走棋 ----

    piecesOf(side) {
        return Object.values(this.board).filter((p) => p && p.side === side);
    }

    flagOf(side) {
        for (const [l, p] of Object.entries(this.board)) if (p.side === side && p.type === "旗") return l;
        return null;
    }

    // 一枚子的合法落点（不含「走完送旗」之类的全局判断）
    legalMoves(from) {
        const piece = this.board[from];
        if (!piece) return [];
        if (CANNOT_MOVE[piece.type]) return [];
        if (HQ_LABEL[from]) return [];        // 进过大本营就再也出不来
        const out = [];
        const push = (to) => { if (!out.includes(to)) out.push(to); };
        const oneStep = !!CAMP_LABEL[from]; // 行营里的子每次只能挪一步
        const edges = ADJ[from] || [];
        for (const e of edges) {
            // 公路一步任何子都能走；行营里的敌子吃不到
            const occ = this.board[e.to];
            if (occ && occ.side === piece.side) continue;
            if (occ && CAMP_LABEL[e.to]) continue;
            push(e.to);
        }
        if (!oneStep) {
            if (RAIL_LABEL[from] && piece.type === "工") {
                // 工兵沿铁路任意拐弯（不能越子）
                const seen = { [from]: true };
                const queue = [from];
                while (queue.length) {
                    const cur = queue.shift();
                    for (const e of (ADJ[cur] || []).filter((x) => x.rail)) {
                        if (seen[e.to]) continue;
                        seen[e.to] = true;
                        const occ = this.board[e.to];
                        if (!occ) { queue.push(e.to); push(e.to); }
                        else if (occ.side !== piece.side && !CAMP_LABEL[e.to]) push(e.to);
                    }
                }
            } else if (RAIL_LABEL[from]) {
                // 其它子沿铁路直行，不限步数，不能拐弯、不能越子
                for (const e of edges.filter((x) => x.rail)) {
                    const dir = dirOf(from, e.to);
                    let cur = e.to;
                    while (true) {
                        const occ = this.board[cur];
                        if (occ) {
                            if (occ.side !== piece.side && !CAMP_LABEL[cur]) push(cur);
                            break;
                        }
                        push(cur);
                        const next = (ADJ[cur] || []).find((x) => x.rail && dirOf(cur, x.to) === dir);
                        if (!next) break;
                        cur = next.to;
                    }
                }
            }
        }
        return out;
    }

    hasLegalMove(side) {
        for (const [l, p] of Object.entries(this.board)) {
            if (p.side === side && this.legalMoves(l).length) return true;
        }
        return false;
    }

    // 走一步。text 形如 B7-C7 / B7到C7 / b7 c7
    tryMove(playerId, text) {
        if (!this.started) return { ok: false, hint: "还没开局：两个人各发 cc军棋 上桌，再各自发 cc布阵" };
        if (this.winner) return { ok: false, hint: "已经分出胜负，发 cc结束 清盘后重开" };
        const player = this.playerById(playerId);
        if (!player) return { ok: false, hint: "你不在这局里，发 cc军棋 加入" };
        if (player.side !== this.turn) {
            const cur = this.playerBySide(this.turn);
            return { ok: false, hint: "还没轮到你，现在轮到 " + (cur ? cur.name : "?") + "（" + SIDE_NAME[this.turn] + "）" };
        }
        const norm = String(text || "").trim();
        const parts = parseMove(norm);
        if (!parts) {
            return { ok: false, hint: "走法写成「起点-终点」，例如 cc走B7-C7 / ccB7C7 / cc走B7到C7；发 cc棋盘 看坐标" };
        }
        const [from, to] = parts;
        if (!from || !to) return { ok: false, hint: "坐标看不懂：列 A~E + 行 1~12，例如 B7、E12" };
        const piece = this.board[from];
        if (!piece) return { ok: false, hint: from + " 上没有棋子（发 cc棋盘 看盘面）" };
        if (piece.side !== player.side) return { ok: false, hint: from + " 那是 " + SIDE_NAME[piece.side] + " 的子" };
        if (CANNOT_MOVE[piece.type]) return { ok: false, hint: CANNOT_MOVE[piece.type] };
        if (HQ_LABEL[from]) return { ok: false, hint: from + " 在大本营里，进去就出不来了" };
        if (!this.legalMoves(from).includes(to)) {
            const why = this._whyBlocked(piece, from, to);
            return { ok: false, hint: from + " 走不到 " + to + "：" + why };
        }

        const def = this.board[to];
        const note = this._fight(player.side, piece, from, def, to);
        this.moves.push({ side: player.side, from, to });
        this.log.push({ side: player.side, text: SIDE_NAME[player.side] + " " + FULL_NAME[piece.type] + " " + from + "→" + to + "：" + note });
        if (this.log.length > 30) this.log = this.log.slice(-30);
        if (this.winner) return { ok: true, notation: from + "→" + to, note, over: true, winBy: this.winner.by };
        // 司令阵亡要把军旗亮出来
        const shown = this._showFlagsFor(deadSides(this.dead));
        const opp = player.side === RED ? BLUE : RED;
        if (!this.hasLegalMove(opp)) {
            const by = this.piecesOf(opp).length ? "困毙（对方无子可走）" : "全军覆没";
            this.winner = { playerId: player.id, name: player.name, side: player.side, by };
            return { ok: true, notation: from + "→" + to, note, over: true, winBy: by, shown };
        }
        this.turn = opp;
        return { ok: true, notation: from + "→" + to, note, over: false, shown, defType: def ? def.type : null };
    }

    _whyBlocked(piece, from, to) {
        const dest = this.board[to];
        if (dest && dest.side === piece.side) return "那是你自己的子";
        if (dest && CAMP_LABEL[to]) return "行营里的子受保护，吃不到";
        if (CAMP_LABEL[from]) return "行营里每次只能挪一格";
        const connected = (ADJ[from] || []).some((e) => e.to === to);
        if (connected) return "走不到";
        if (RAIL_LABEL[from]) return "两点之间没有线连着（铁路上不能拐弯，只有工兵能沿铁路绕；公路只走一格）";
        return "两个点之间没有线连着";
    }

    // 碰子判定：返回一句公开战报，并把阵亡的子亮出来
    _fight(side, att, from, def, to) {
        if (!def) {
            this.board[to] = att; delete this.board[from];
            if (HQ_LABEL[to]) return "走进大本营（从此不能再动）";
            return "走到 " + to;
        }
        const attName = FULL_NAME[att.type], defName = FULL_NAME[def.type];
        const killAtt = () => { delete this.board[from]; this.dead.push({ side, type: att.type, at: from, how: def.type }); };
        const killDef = () => { delete this.board[to]; this.dead.push({ side: def.side, type: def.type, at: to, how: att.type }); };
        if (def.type === "旗") {
            // 扛旗：军旗被吃（炸弹撞上也算），立刻判胜
            killDef();
            this.board[to] = att; delete this.board[from];
            const player = this.playerBySide(side);
            this.winner = { playerId: player.id, name: player.name, side, by: att.type === "炸" ? "炸掉军旗" : "扛旗" };
            return "扛走" + defName + "，" + SIDE_NAME[side] + "胜！";
        }
        if (att.type === "炸") {
            killAtt(); killDef();
            return "炸弹与" + defName + "同归于尽";
        }
        if (def.type === "雷") {
            if (att.type === "工") {
                killDef(); this.board[to] = att; delete this.board[from];
                return "工兵挖掉地雷，占住 " + to;
            }
            killAtt();
            return attName + "撞上地雷，阵亡";
        }
        if (RANK[att.type] > RANK[def.type]) {
            killDef(); this.board[to] = att; delete this.board[from];
            return attName + "吃掉" + defName + (HQ_LABEL[to] ? "（进了大本营，不能再动）" : "");
        }
        if (RANK[att.type] === RANK[def.type]) {
            killAtt(); killDef();
            return "两枚" + attName + "同归于尽";
        }
        killAtt();
        return attName + "撞上" + defName + "，阵亡";
    }

    // 一方司令没了就把它的军旗位置公开（标准规则：司令阵亡，军旗亮开）
    _showFlagsFor(sides) {
        const out = [];
        for (const side of sides) {
            if (this.flagShown[side]) continue;
            const at = this.flagOf(side);
            if (!at) continue;
            this.flagShown[side] = at;
            out.push(SIDE_NAME[side] + " 司令阵亡，军旗亮在 " + at);
            this.log.push({ side, text: out[out.length - 1] });
        }
        return out;
    }

    resign(playerId) {
        const player = this.playerById(playerId);
        if (!this.started) return { ok: false, hint: "还没开始，不用认输" };
        if (this.winner) return { ok: false, hint: "已经结束了" };
        if (!player) return { ok: false, hint: "你不在这局里" };
        const other = this.players.find((p) => p.id !== playerId);
        this.winner = { playerId: other.id, name: other.name, side: other.side, by: "对手认输" };
        return { ok: true, player, other };
    }

    statusText() {
        if (!this.started) {
            const need = this.players.filter((p) => !p.deployed).map((p) => p.name + " 发 cc布阵");
            if (this.players.length < 2) return "【军棋】还差 " + (2 - this.players.length) + " 个人：发 cc军棋 上桌（先来的是红方先走）";
            return "【军棋】两人已就位，等布阵：" + need.join("；");
        }
        if (this.winner) {
            return "【军棋】" + this.winner.name + "（" + SIDE_NAME[this.winner.side] + "）获胜，" + this.winner.by +
                "。共 " + this.moves.length + " 手，发 cc结束 清盘。";
        }
        const cur = this.playerBySide(this.turn);
        const last = this.log[this.log.length - 1];
        return "轮到 " + (cur ? cur.name : "?") + "（" + SIDE_NAME[this.turn] + "），第 " + (this.moves.length + 1) + " 手\n" +
            "上一手：" + (last ? last.text : "还没走子") + "\n" +
            "走法：cc走B7-C7（起点-终点）｜cc棋盘 看盘面｜cc战报 看亮子｜cc状态 看轮到你";
    }
}

// 阵亡过的_side_ 集合（用于司令阵亡亮旗）
function deadSides(deadList) {
    const out = [];
    for (const d of deadList) {
        if (d.type === "司" && !out.includes(d.side)) out.push(d.side);
    }
    return out;
}

const ROW_TAG = { 1: "锋线", 2: "二线", 3: "三线", 4: "四线", 5: "底线", 6: "端线" };

module.exports = {
    JunqiGame, RED, BLUE, SIDE_NAME, FULL_NAME, RANK, COUNT, ROW_TAG,
    ADJ, RAIL_LABEL, CAMP_LABEL, HQ_LABEL, OWN_HALF, COL_LETTER,
    label, parseLabel, parseMove, sideOfRow, localRow, globalRow,
};
