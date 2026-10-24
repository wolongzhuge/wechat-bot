"use strict";
// 中国象棋引擎：9×10 棋盘、全规则。走子两套输入都认：
//   官方记谱（马五进六 / 炮二平五 / 前马进三）走 tryMove，
//   坐标（cc21 33 = 2列1行→3列3行）走 tryMoveCoord，坐标解析在 coord.js。
// 行 0 = 黑方底线（画在图上边），列 0 = 棋盘左边；红方在下（行 7~9），红先。
// 记谱里的「第 n 列」和坐标里的「第 n 列」是同一套：红方 n = 9 - col、黑方 n = col + 1，
// 都从自己右手边数；行号同理从自己底线数（红 n = 10 - r，黑 n = r + 1），盘面上两边都标了。
// 红方前进 = 内部行号减小，黑方前进 = 内部行号增大。

const ROWS = 10, COLS = 9;
const RED = "r", BLACK = "b";

const TYPE_OF_CHAR = {
    "帅": "K", "将": "K", "仕": "A", "士": "A", "相": "E", "象": "E",
    "马": "H", "车": "R", "炮": "C", "兵": "P", "卒": "P",
};
const CHAR_OF = {
    [RED]: { K: "帅", A: "仕", E: "相", H: "马", R: "车", C: "炮", P: "兵" },
    [BLACK]: { K: "将", A: "士", E: "象", H: "马", R: "车", C: "炮", P: "卒" },
};
const SIDE_NAME = { [RED]: "红方", [BLACK]: "黑方" };
const TYPE_NAME = { K: "将帅", A: "仕士", E: "相象", H: "马", R: "车", C: "炮", P: "兵卒" };
// 红方记谱的中文数字（黑方用阿拉伯），最多到 10
const CN_OF = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

// 内部坐标 ↔ 各方视角列号
function colOf(side, file) { return side === RED ? COLS - file : file - 1; }
function fileOf(side, col) { return side === RED ? COLS - col : col + 1; }
// 行号同样按各方自己数：自己底线是第 1 行，对面底线是第 10 行
function rowOf(side, r) { return side === RED ? ROWS - r : r + 1; }
function rowToR(side, n) { return side === RED ? ROWS - n : n - 1; }
// 前进方向：红 -1，黑 +1
function fwd(side) { return side === RED ? -1 : 1; }
const other = (side) => (side === RED ? BLACK : RED);

// 「第 c 列第 r 行」→ 内部格子；越界返回 null
function sqOf(side, col, row) {
    if (!(col >= 1 && col <= COLS) || !(row >= 1 && row <= ROWS)) return null;
    return { r: rowToR(side, row), c: colOf(side, col) };
}
// 提示里反复要用「2列1行」这种写法，统一一个口
const at = (n) => n.col + "列" + n.row + "行";

function inPalace(side, r, c) {
    if (c < 3 || c > 5) return false;
    return side === RED ? (r >= 7 && r <= 9) : (r >= 0 && r <= 2);
}
function inOwnHalf(side, r) {
    return side === RED ? r >= 5 : r <= 4;
}
function crossedRiver(side, r) {
    return !inOwnHalf(side, r);
}

function makeBoard() {
    const b = Array.from({ length: ROWS }, () => new Array(COLS).fill(null));
    const back = [["R", "H", "E", "A", "K", "A", "E", "H", "R"], ["R", "H", "E", "A", "K", "A", "E", "H", "R"]];
    back[0].forEach((t, c) => { b[0][c] = { side: BLACK, type: t }; });
    back[1].forEach((t, c) => { b[9][c] = { side: RED, type: t }; });
    b[2][1] = { side: BLACK, type: "C" }; b[2][7] = { side: BLACK, type: "C" };
    b[7][1] = { side: RED, type: "C" }; b[7][7] = { side: RED, type: "C" };
    for (const c of [0, 2, 4, 6, 8]) {
        b[3][c] = { side: BLACK, type: "P" };
        b[6][c] = { side: RED, type: "P" };
    }
    return b;
}

// (r,c) 处 side 的帅/将是否被攻击（含对面笑：双将照面）
function kingAttacked(board, side, kr, kc) {
    const opp = side === RED ? BLACK : RED;
    // 车：直线照面且中间无子
    for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        let r = kr + dr, c = kc + dc;
        while (r >= 0 && r < ROWS && c >= 0 && c < COLS) {
            const p = board[r][c];
            if (p) {
                if (p.side === opp && (p.type === "R" || (p.type === "K" && dc === 0))) return true;
                break;
            }
            r += dr; c += dc;
        }
    }
    // 炮：中间恰一枚炮架
    for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        let r = kr + dr, c = kc + dc, between = 0;
        while (r >= 0 && r < ROWS && c >= 0 && c < COLS) {
            const p = board[r][c];
            if (p) {
                if (between === 0) { between++; }
                else if (p.side === opp && p.type === "C") return true;
                else break;
            }
            r += dr; c += dc;
        }
    }
    // 马：日字且不蹩腿（腿 = 马与将相邻的直线点）
    for (const [dr, dc] of [[1, 2], [1, -2], [-1, 2], [-1, -2], [2, 1], [2, -1], [-2, 1], [-2, -1]]) {
        const r = kr + dr, c = kc + dc;
        if (r < 0 || r >= ROWS || c < 0 || c >= COLS) continue;
        const p = board[r][c];
        if (p && p.side === opp && p.type === "H") {
            const lr = kr + (Math.abs(dr) === 2 ? dr / 2 : 0);
            const lc = kc + (Math.abs(dc) === 2 ? dc / 2 : 0);
            if (!board[lr][lc]) return true;
        }
    }
    // 兵卒：只能攻击它能走到的点
    const pf = fwd(opp);
    for (const [dc, dr] of [[0, pf], [1, 0], [-1, 0]]) {
        const r = kr + dr, c = kc + dc;
        if (r < 0 || r >= ROWS || c < 0 || c >= COLS) continue;
        const p = board[r][c];
        if (!p || p.side !== opp || p.type !== "P") continue;
        if (dc === 0) return true;
        if (crossedRiver(opp, r)) return true;
    }
    return false;
}

function attacked(board, side) {
    const king = findKing(board, side);
    if (!king) return false;
    return kingAttacked(board, side, king[0], king[1]);
}

function findKing(board, side) {
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            const p = board[r][c];
            if (p && p.side === side && p.type === "K") return [r, c];
        }
    }
    return null;
}

// 一枚棋子的全部候选落点（不含「走了之后自己被将军」的过滤）
function candidatesOf(board, side, r, c) {
    const p = board[r][c];
    const out = [];
    const inb = (rr, cc) => rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS;
    const notOwn = (rr, cc) => !board[rr][cc] || board[rr][cc].side !== side;
    if (p.type === "K") {
        for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
            const rr = r + dr, cc = c + dc;
            if (inb(rr, cc) && inPalace(side, rr, cc) && notOwn(rr, cc)) out.push([rr, cc]);
        }
    } else if (p.type === "A") {
        for (const [dr, dc] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            const rr = r + dr, cc = c + dc;
            if (inb(rr, cc) && inPalace(side, rr, cc) && notOwn(rr, cc)) out.push([rr, cc]);
        }
    } else if (p.type === "E") {
        for (const [dr, dc] of [[2, 2], [2, -2], [-2, 2], [-2, -2]]) {
            const rr = r + dr, cc = c + dc;
            if (inb(rr, cc) && inOwnHalf(side, rr) && !board[r + dr / 2][c + dc / 2] && notOwn(rr, cc)) out.push([rr, cc]);
        }
    } else if (p.type === "H") {
        for (const [dr, dc] of [[1, 2], [1, -2], [-1, 2], [-1, -2], [2, 1], [2, -1], [-2, 1], [-2, -1]]) {
            const rr = r + dr, cc = c + dc;
            if (!inb(rr, cc) || !notOwn(rr, cc)) continue;
            const lr = r + (Math.abs(dr) === 2 ? dr / 2 : 0);
            const lc = c + (Math.abs(dc) === 2 ? dc / 2 : 0);
            if (!board[lr][lc]) out.push([rr, cc]);
        }
    } else if (p.type === "R" || p.type === "C") {
        for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
            let rr = r + dr, cc = c + dc, blockers = 0;
            while (inb(rr, cc)) {
                const q = board[rr][cc];
                if (!q) {
                    if (p.type === "R" || blockers === 0) out.push([rr, cc]);
                } else {
                    if (q.side !== side) {
                        if (p.type === "R") out.push([rr, cc]);
                        else if (blockers === 1) out.push([rr, cc]);
                    }
                    blockers++;
                    if (p.type === "R" || blockers >= 2) break;
                }
                rr += dr; cc += dc;
            }
        }
    } else if (p.type === "P") {
        const pf = fwd(side);
        const rr = r + pf;
        if (inb(rr, c) && notOwn(rr, c)) out.push([rr, c]);
        if (crossedRiver(side, r)) {
            for (const dc of [1, -1]) {
                if (inb(r, c + dc) && notOwn(r, c + dc)) out.push([r, c + dc]);
            }
        }
    }
    return out;
}

// side 还有没有合法着法（走完自己不被将军）
function hasAnyLegalMove(board, side) {
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            const p = board[r][c];
            if (!p || p.side !== side) continue;
            for (const [tr, tc] of candidatesOf(board, side, r, c)) {
                const captured = board[tr][tc];
                board[tr][tc] = p; board[r][c] = null;
                const safe = !attacked(board, side);
                board[r][c] = p; board[tr][tc] = captured;
                if (safe) return true;
            }
        }
    }
    return false;
}

// 官方记谱归一：全角数字、中文数字 → 半角阿拉伯数字
const CN_NUM = { "一": "1", "二": "2", "三": "3", "四": "4", "五": "5", "六": "6", "七": "7", "八": "8", "九": "9" };
function normalizeMoveText(text) {
    let t = String(text || "").trim();
    t = t.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
    t = t.replace(/[一二三四五六七八九]/g, (ch) => CN_NUM[ch]);
    return t;
}
// 官方记谱：前/后/中 区分同列棋子时起点列号省略（前马进三），其余必带（马五进六）
const MOVE_RE = /^(前|后|中)?(车|马|炮|兵|卒|相|象|仕|士|帅|将)([1-9]?)(进|退|平)([1-9])$/;

class XiangqiGame {
    constructor() {
        this.board = makeBoard();
        this.players = [];     // {id, name, side}
        this.moves = [];       // {side, type, fr, fc, tr, tc, captured, notation, check}
        this.turn = RED;       // 红先
        this.winner = null;    // {playerId, name, side} 或 {draw}
        this.started = false;
    }

    addPlayer(id, name) {
        if (this.players.length >= 2) return { ok: false, reason: "两个人已经齐了" };
        if (this.players.some((p) => p.id === id)) return { ok: false, reason: "你已经在这局里了" };
        this.players.push({ id, name, side: null });
        return { ok: true };
    }

    // 随机定红黑（红先），不随机就按加入顺序
    start(randomSide) {
        if (this.players.length < 2) return false;
        let order = this.players;
        if (randomSide && Math.random() < 0.5) order = [this.players[1], this.players[0]];
        order[0].side = RED;
        order[1].side = BLACK;
        this.turn = RED;
        this.started = true;
        return true;
    }

    playerById(id) { return this.players.find((p) => p.id === id); }
    playerBySide(side) { return this.players.find((p) => p.side === side); }

    // 落子前的记谱生成（前/后/中 要在旧盘面上判断）
    // 官方约定：红方的数字写中文（马二进三），黑方写阿拉伯（马8进7）
    _notation(side, type, fr, fc, tr, tc) {
        const name = CHAR_OF[side][type];
        const n = (v) => (side === RED ? CN_OF[v] || String(v) : String(v));
        let prefix = "";
        const sameCol = [];
        for (let r = 0; r < ROWS; r++) {
            const p = this.board[r][fc];
            if (p && p.side === side && p.type === type) sameCol.push(r);
        }
        if (sameCol.length >= 2) {
            sameCol.sort((a, b) => (side === RED ? a - b : b - a));
            const idx = sameCol.indexOf(fr);
            prefix = idx === 0 ? "前" : idx === sameCol.length - 1 ? "后" : "中";
        }
        const advance = (tr - fr) * fwd(side);
        const head = prefix ? prefix + name : name + n(fileOf(side, fc));
        if (fc === tc) {
            const target = (type === "H" || type === "E" || type === "A") ? fileOf(side, tc) : Math.abs(tr - fr);
            return head + (advance > 0 ? "进" : "退") + n(target);
        }
        // 马相仕 斜走改列也算进/退（按行方向），只有直线横移才是平
        if (type === "H" || type === "E" || type === "A") {
            return head + (advance > 0 ? "进" : "退") + n(fileOf(side, tc));
        }
        return head + "平" + n(fileOf(side, tc));
    }

    // 主入口 A：按官方记谱走一步（马五进六 / 炮二平五 / 前马进三）
    tryMove(playerId, text) {
        const g = this._guard(playerId);
        if (!g.ok) return g;
        const side = g.player.side;
        const got = this._parseNotation(side, text);
        if (!got.ok) return got;
        // 记谱走错了也顺便把坐标念出来，用几次就会换着写了
        const inb = got.tr >= 0 && got.tr < ROWS && got.tc >= 0 && got.tc < COLS;
        const where = inb
            ? at({ col: fileOf(side, got.fc), row: rowOf(side, got.fr) }) + "→" + at({ col: fileOf(side, got.tc), row: rowOf(side, got.tr) })
            : null;
        return this._applyMove(g.player, got.fr, got.fc, got.tr, got.tc, where);
    }

    // 主入口 B：按坐标走一步。col/row 都按走子方自己那圈数字读（前列后行，
    // 列从自己右手边数、行从自己底线数），跟盘面上同色的标注一一对应。
    tryMoveCoord(playerId, from, to, wantChar) {
        const g = this._guard(playerId);
        if (!g.ok) return g;
        const side = g.player.side;
        const a = sqOf(side, from.col, from.row);
        const b = sqOf(side, to.col, to.row);
        const out = (n) => "「" + at(n) + "」超出棋盘了：一共 9 列（1~9）、10 行（1~10）";
        if (!a) return { ok: false, hint: out(from) };
        if (!b) return { ok: false, hint: out(to) };
        const src = this.board[a.r][a.c];
        if (!src) {
            // 红黑两边列号是反的，很容易照着对面那圈数字数过去，这种情况点出来
            const m = sqOf(other(side), from.col, from.row);
            const mir = m && this.board[m.r][m.c];
            if (mir && mir.side === side) {
                return { ok: false, hint: at(from) + " 是空的。你的" + CHAR_OF[side][mir.type] + "在 " +
                    at({ col: fileOf(side, m.c), row: rowOf(side, m.r) }) + "，你是不是按对面那圈数字数的？" };
            }
            return { ok: false, hint: at(from) + " 是空的，起点要写你自己棋子的位置（列从你右手边数、行从你底线数）" };
        }
        if (src.side !== side) {
            return { ok: false, hint: at(from) + " 是" + SIDE_NAME[src.side] + "的" + CHAR_OF[src.side][src.type] + "，不能动别人的子" };
        }
        if (wantChar && TYPE_OF_CHAR[wantChar] !== src.type) {
            return { ok: false, hint: "你说要走" + wantChar + "，但 " + at(from) + " 上是你自己的" + CHAR_OF[side][src.type] +
                "：起点改成它的位子，或者把开头的" + wantChar + "去掉" };
        }
        return this._applyMove(g.player, a.r, a.c, b.r, b.c, at(from) + "→" + at(to));
    }

    // 开局了没、分出胜负没、是不是你的回合 —— 两个入口共用
    _guard(playerId) {
        if (!this.started) return { ok: false, hint: "这局还没开始，两个人各发一次 cc象棋 就能开局" };
        if (this.winner) return { ok: false, hint: "已经分出胜负了，发 cc结束 清盘后重开" };
        const player = this.playerById(playerId);
        if (!player) return { ok: false, hint: "你不在这局里，发 cc象棋 加入" };
        if (player.side !== this.turn) {
            const cur = this.playerBySide(this.turn);
            return { ok: false, hint: "还没轮到你，现在是 " + (cur ? cur.name : "?") + "（" + SIDE_NAME[this.turn] + "）走棋" };
        }
        return { ok: true, player };
    }

    // 两点定了之后真正走一步：规则校验 → 送将检查 → 落盘 → 生成记谱
    _applyMove(player, fr, fc, tr, tc, where) {
        const side = player.side;
        const piece = this.board[fr][fc];
        const tail = where ? "（" + where + "）" : "";
        if (!piece) return { ok: false, hint: "起点没有棋子" + tail };
        if (piece.side !== side) return { ok: false, hint: "那是" + SIDE_NAME[piece.side] + "的子，动不了" + tail };
        const err = this._legal(side, piece.type, fr, fc, tr, tc);
        if (err) return { ok: false, hint: err + tail };

        const notation = this._notation(side, piece.type, fr, fc, tr, tc);
        const captured = this.board[tr][tc];
        this.board[tr][tc] = piece;
        this.board[fr][fc] = null;

        // 走完自己不能还被将军（顺带强制了「被将军必须应将」）
        if (attacked(this.board, side)) {
            this.board[fr][fc] = piece;
            this.board[tr][tc] = captured;
            return { ok: false, hint: "这样走你自己的" + CHAR_OF[side].K + "会被将，换一步" + tail };
        }

        let check = false, over = false, winBy = null;
        const opp = other(side);
        if (captured && captured.type === "K") {
            over = true; winBy = "吃将";
        } else if (!hasAnyLegalMove(this.board, opp)) {
            over = true;
            winBy = attacked(this.board, opp) ? "将死" : "困毙";
        } else if (attacked(this.board, opp)) {
            check = true;
        }

        this.moves.push({ side, type: piece.type, fr, fc, tr, tc, captured, notation, check });
        if (over) {
            this.winner = { playerId: player.id, name: player.name, side };
        } else {
            this.turn = opp;
        }
        return {
            ok: true, notation,
            from: { col: fileOf(side, fc), row: rowOf(side, fr) },
            to: { col: fileOf(side, tc), row: rowOf(side, tr) },
            piece: CHAR_OF[side][piece.type],
            captured: captured ? CHAR_OF[captured.side][captured.type] : null,
            check, over, winBy,
        };
    }

    // 官方记谱 → 两个内部坐标点
    _parseNotation(side, text) {
        const norm = normalizeMoveText(text);
        const m = norm.match(MOVE_RE);
        if (!m) {
            return { ok: false, hint: "没看懂「" + String(text).trim().slice(0, 20) + "」。记谱：马五进六 / 炮二平五 / 车一进一，同列两枚写 前/后（前马进三）；嫌麻烦就直接写坐标：cc21 33 = 2列1行→3列3行" };
        }
        const [, prefix, ch, file, action, target] = m;
        const type = TYPE_OF_CHAR[ch];
        const fileNum = file ? Number(file) : null;
        const targetNum = Number(target);
        if (!prefix && !fileNum) {
            return { ok: false, hint: "没看懂「" + String(text).trim().slice(0, 20) + "」。记谱：马五进六 / 炮二平五 / 车一进一，同列两枚写 前/后（前马进三）；嫌麻烦就直接写坐标：cc21 33 = 2列1行→3列3行" };
        }

        // 找这枚棋子
        const mine = [];
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                const p = this.board[r][c];
                if (p && p.side === side && p.type === type) mine.push([r, c]);
            }
        }
        if (!mine.length) return { ok: false, hint: "你的" + TYPE_NAME[type] + "全没了" };

        let fr, fc;
        if (prefix) {
            const byCol = new Map();
            for (const [r, c] of mine) {
                if (!byCol.has(c)) byCol.set(c, []);
                byCol.get(c).push(r);
            }
            const groups = [...byCol.entries()].filter(([, rows]) => rows.length >= 2);
            if (!groups.length) {
                return { ok: false, hint: "没有同列的两枚" + TYPE_NAME[type] + "，直接写列号就行，如 " + CHAR_OF[side][type] + "五进六" };
            }
            if (groups.length > 1) {
                return { ok: false, hint: "同列成对的" + TYPE_NAME[type] + "不止一组，请写清楚列号，如 " + CHAR_OF[side][type] + "五进六" };
            }
            const [fc2, rows] = groups[0];
            rows.sort((a, b) => (side === RED ? a - b : b - a));
            fr = prefix === "前" ? rows[0] : prefix === "后" ? rows[rows.length - 1] : rows[Math.floor(rows.length / 2)];
            fc = fc2;
        } else {
            fc = colOf(side, fileNum);
            const rows = mine.filter(([, c]) => c === fc).map(([r]) => r);
            if (!rows.length) return { ok: false, hint: "第 " + fileNum + " 列没有你的" + TYPE_NAME[type] + "（列号从你右手边数起）" };
            if (rows.length > 1) {
                const alt = rows.map((r) => fileNum + "," + rowOf(side, r) + " …").join("　");
                return { ok: false, hint: "第 " + fileNum + " 列有两枚" + TYPE_NAME[type] + "，请写 前" + TYPE_NAME[type] + " / 后" + TYPE_NAME[type] +
                    " 区分，或者用坐标写清楚动哪一枚：" + alt };
            }
            fr = rows[0];
        }

        // 算目标点
        let tr, tc;
        if (action === "平") {
            tr = fr; tc = colOf(side, targetNum);
        } else {
            const dir = action === "进" ? fwd(side) : -fwd(side);
            let step = type === "E" ? 2 : (type === "A" ? 1 : null);
            // 马的记谱只报目标列，纵着走几行由列差决定：横 1 路是「进/退二」，横 2 路是「进/退一」
            if (type === "H") {
                const dFile = Math.abs(colOf(side, targetNum) - fc);
                step = dFile === 1 ? 2 : dFile === 2 ? 1 : null;
                if (step === null) {
                    return { ok: false, hint: "马走日字：第 " + fileOf(side, fc) + " 列的马到不了第 " + targetNum +
                        " 列（横向只能差 1 路或 2 路）" };
                }
            }
            if (step !== null) {
                tr = fr + dir * step; tc = colOf(side, targetNum);
            } else {
                tr = fr + dir * targetNum; tc = fc;
            }
        }

        return { ok: true, fr, fc, tr, tc };
    }

    // 规则校验，返回错误文案或 null
    _legal(side, type, fr, fc, tr, tc) {
        if (tr < 0 || tr >= ROWS || tc < 0 || tc >= COLS) return "走出棋盘了";
        const dest = this.board[tr][tc];
        if (dest && dest.side === side) return "那个位置是你自己的棋子";
        const dr = tr - fr, dc = tc - fc;
        if (dr === 0 && dc === 0) return "要真的走一步，不能原地不动";
        if (type === "K") {
            if (Math.abs(dr) + Math.abs(dc) !== 1) return CHAR_OF[side].K + " 一次只能走一步直线";
            if (!inPalace(side, tr, tc)) return CHAR_OF[side].K + " 不能出九宫";
        } else if (type === "A") {
            if (Math.abs(dr) !== 1 || Math.abs(dc) !== 1) return "仕士只能斜走一步";
            if (!inPalace(side, tr, tc)) return "仕士不能出九宫";
        } else if (type === "E") {
            if (Math.abs(dr) !== 2 || Math.abs(dc) !== 2) return "相象走田字（斜两步）";
            if (!inOwnHalf(side, tr)) return "相象不能过河";
            if (this.board[fr + dr / 2][fc + dc / 2]) return "相眼被塞住了，过不去";
        } else if (type === "H") {
            if (!((Math.abs(dr) === 1 && Math.abs(dc) === 2) || (Math.abs(dr) === 2 && Math.abs(dc) === 1))) return "马走日字";
            const lr = fr + (Math.abs(dr) === 2 ? dr / 2 : 0);
            const lc = fc + (Math.abs(dc) === 2 ? dc / 2 : 0);
            if (this.board[lr][lc]) return "马腿被蹩住了，跳不过去";
        } else if (type === "R" || type === "C") {
            if (dr !== 0 && dc !== 0) return "车炮只能走直线";
            let between = 0;
            const rs = Math.sign(tr - fr), cs = Math.sign(tc - fc);
            for (let r = fr + rs, c = fc + cs; r !== tr || c !== tc; r += rs, c += cs) {
                if (this.board[r][c]) between++;
            }
            if (type === "R") {
                if (between > 0) return "车不能隔着棋子走";
            } else {
                if (dest && between !== 1) return "炮吃子必须隔一枚炮架，中间现在是 " + between + " 枚";
                if (!dest && between !== 0) return "炮不能隔着棋子走";
            }
        } else if (type === "P") {
            const pf = fwd(side);
            if (dr === 0) {
                if (Math.abs(dc) !== 1) return "兵卒过河前只能前进，过河后可以横走一步";
                if (!crossedRiver(side, fr)) return "兵卒没过河不能横走";
            } else if (dr !== pf || dc !== 0) {
                return "兵卒只能前进，不能后退";
            }
        }
        return null;
    }

    resign(playerId) {
        const player = this.playerById(playerId);
        if (!this.started) return { ok: false, hint: "还没开始，不用认输" };
        if (this.winner) return { ok: false, hint: "已经结束了" };
        if (!player) return { ok: false, hint: "你不在这局里" };
        const other = this.players.find((p) => p.id !== playerId);
        this.winner = { playerId: other.id, name: other.name, side: other.side };
        return { ok: true, player, other };
    }

    statusText() {
        if (!this.started) {
            const have = this.players.length;
            return "【象棋】还差 " + (2 - have) + " 个人：现在只有 " +
                (this.players.map((p) => p.name).join("、") || "没人") +
                "\n再拉一个人发 cc象棋 就能开局。";
        }
        if (this.winner) {
            const w = this.winner;
            return "【象棋】" + w.name + "（" + SIDE_NAME[w.side] + "）获胜！共 " + this.moves.length + " 手\n发 cc结束 清盘，或 cc象棋 重开。";
        }
        const red = this.playerBySide(RED), black = this.playerBySide(BLACK);
        const cur = this.playerBySide(this.turn);
        const last = this.moves[this.moves.length - 1];
        const vs = red.name + "（红）  对  " + black.name + "（黑）";
        const lastLine = last
            ? "上一手：" + SIDE_NAME[last.side] + " " + last.notation +
              "（" + at({ col: fileOf(last.side, last.fc), row: rowOf(last.side, last.fr) }) + "→" +
              at({ col: fileOf(last.side, last.tc), row: rowOf(last.side, last.tr) }) + "）" +
              (last.captured ? "，吃了" + last.captured : "") + (last.check ? "（将军！）" : "")
            : "红先，请走第一步";
        return vs + "\n第 " + (this.moves.length + 1) + " 手，轮到 " + cur.name + "（" + SIDE_NAME[this.turn] + "）\n" +
            lastLine + "\n走法：cc21 33 = 从 2 列 1 行走到 3 列 3 行（前列后行，从你自己这边数）；" +
            "官方记谱照样能用：cc马五进六。\n看盘面 cc棋盘 / 认负 cc认输。";
    }
}

module.exports = {
    XiangqiGame, ROWS, COLS, RED, BLACK,
    CHAR_OF, SIDE_NAME, TYPE_OF_CHAR, normalizeMoveText, MOVE_RE, makeBoard,
    colOf, fileOf, rowOf, rowToR, sqOf,
};
