"use strict";
// 棋盘渲染：9×10 中国象棋盘画成 PNG 发群（手机上文本棋盘必然错位），图片发不出去退回文本。
const { Canvas } = require("../../utils/png");
const { GLYPHS } = require("./glyphs");
const { ROWS, COLS, RED, CHAR_OF } = require("./game");

// 四边都要放得下行列号：数字外沿离最近的棋子圆周再留 6px，谁也不压谁
const MARGIN_L = 64, MARGIN_R = 64, MARGIN_T = 52, MARGIN_B = 52;
const CELL = 42;
const PIECE_R = 19;
const NUM = 2;   // 行列号字号（8×8 点阵放大倍数），手机上再小就看不清了

const COLOR = {
    wood: [233, 199, 130],
    line: [92, 62, 26],
    label: [70, 46, 18],
    river: [150, 110, 60],
    redRing: [170, 40, 30],
    blackRing: [40, 40, 40],
    face: [245, 228, 180],
    redChar: [190, 30, 20],
    blackChar: [20, 20, 20],
    mark: [214, 40, 40],
};

function px(c) { return MARGIN_L + c * CELL; }
function py(r) { return MARGIN_T + r * CELL; }

function drawGlyph(cv, ch, x, y, color) {
    const glyph = GLYPHS[ch];
    if (!glyph) return;
    for (let row = 0; row < 32; row++) {
        for (let col = 0; col < 32; col++) {
            if (glyph[row] & (0x80000000 >>> col)) {
                cv.rect(x + col, y + row, x + col, y + row, color);
            }
        }
    }
}

function drawPiece(cv, ch, c, r, isRed) {
    cv.circle(px(c), py(r), PIECE_R, isRed ? COLOR.redRing : COLOR.blackRing);
    cv.circle(px(c), py(r), PIECE_R - 2, COLOR.face);
    drawGlyph(cv, ch, px(c) - 16, py(r) - 16, isRed ? COLOR.redChar : COLOR.blackChar);
}

// 最后一手：起点和落点各画红色角标
function markCell(cv, c, r) {
    const x = px(c), y = py(r);
    const s = PIECE_R + 4, t = 5;
    cv.rect(x - s, y - s, x - s + t, y - s, COLOR.mark);
    cv.rect(x + s - t, y - s, x + s, y - s, COLOR.mark);
    cv.rect(x - s, y + s, x - s + t, y + s, COLOR.mark);
    cv.rect(x + s - t, y + s, x + s, y + s, COLOR.mark);
    cv.rect(x - s, y - s, x - s, y - s + t, COLOR.mark);
    cv.rect(x + s, y - s, x + s, y - s + t, COLOR.mark);
    cv.rect(x - s, y + s - t, x - s, y + s, COLOR.mark);
    cv.rect(x + s, y + s - t, x + s, y + s, COLOR.mark);
}

// 炮位/兵位的小角标（画在棋子下面，被棋子盖住也没关系）
function positionMark(cv, c, r) {
    const x = px(c), y = py(r), d = 7, t = 5;
    for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
            cv.lineH(y + sy * d, x + sx * d, x + sx * (d + t), COLOR.line);
            cv.lineV(x + sx * d, y + sy * d, y + sy * (d + t), COLOR.line);
        }
    }
}

// 8×8 点阵字体：每格宽 8*scale，字符之间再留 scale 的空
const textWidth = (s, scale) => String(s).length * (8 * scale + scale) - scale;

function centerText(cv, s, cx, y, color, scale) {
    cv.text(s, Math.round(cx - textWidth(s, scale) / 2), y, color, scale);
}

function renderImage(game) {
    const W = MARGIN_L + MARGIN_R + (COLS - 1) * CELL;
    const H = MARGIN_T + MARGIN_B + (ROWS - 1) * CELL;
    const cv = new Canvas(W, H, COLOR.wood);

    // 竖线：九条全高，唯独中线在楚河汉界处断开
    for (let c = 0; c < COLS; c++) {
        if (c === 4) {
            cv.lineV(px(c), py(0), py(4), COLOR.line);
            cv.lineV(px(c), py(5), py(9), COLOR.line);
        } else {
            cv.lineV(px(c), py(0), py(9), COLOR.line);
        }
    }
    // 横线：上下边框和中间各行全宽
    for (let r = 0; r < ROWS; r++) cv.lineH(py(r), px(0), px(COLS - 1), COLOR.line);

    // 九宫斜线
    cv.line(px(3), py(0), px(5), py(2), COLOR.line);
    cv.line(px(5), py(0), px(3), py(2), COLOR.line);
    cv.line(px(3), py(7), px(5), py(9), COLOR.line);
    cv.line(px(5), py(7), px(3), py(9), COLOR.line);

    // 炮位 / 兵位角标
    for (const c of [1, 7]) {
        positionMark(cv, c, 2);
        positionMark(cv, c, 7);
    }
    for (const c of [0, 2, 4, 6, 8]) {
        positionMark(cv, c, 3);
        positionMark(cv, c, 6);
    }

    // 楚河 汉界
    const ry = py(4) + (CELL - 32) / 2;
    drawGlyph(cv, "楚", px(1) - 16, ry, COLOR.river);
    drawGlyph(cv, "河", px(2) - 16, ry, COLOR.river);
    drawGlyph(cv, "汉", px(5) - 16, ry, COLOR.river);
    drawGlyph(cv, "界", px(6) - 16, ry, COLOR.river);

    // 四边坐标：红方读「下面列号 + 右边行号」，黑方读「上面列号 + 左边行号」，
    // 两边数字用各自颜色，输入 cc21 33 时照着跟自己同色的那圈数就对了。
    // 数字外沿一律错开棋子半径（PIECE_R + PAD），不然「10」会被角上的子啃掉一半。
    const PAD = PIECE_R + 6, TH = 8 * NUM, half = TH / 2;
    for (let c = 0; c < COLS; c++) {
        centerText(cv, String(c + 1), px(c), py(0) - PAD - TH, COLOR.blackChar, NUM);
        centerText(cv, String(COLS - c), px(c), py(ROWS - 1) + PAD, COLOR.redChar, NUM);
    }
    for (let r = 0; r < ROWS; r++) {
        const y = py(r) - half;
        const left = String(r + 1), right = String(ROWS - r);
        cv.text(left, px(0) - PAD - textWidth(left, NUM), y, COLOR.blackChar, NUM);
        cv.text(right, px(COLS - 1) + PAD, y, COLOR.redChar, NUM);
    }

    // 棋子
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            const p = game.board[r][c];
            if (p) drawPiece(cv, CHAR_OF[p.side][p.type], c, r, p.side === RED);
        }
    }

    const last = game.moves[game.moves.length - 1];
    if (last) {
        markCell(cv, last.fc, last.fr);
        markCell(cv, last.tc, last.tr);
    }
    return cv.toBuffer().toString("base64");
}

// 文本兜底：红方裸字，黑方加括号区分（车马炮两边同字）。
// 行列号两边都给：行首是黑方行号、行尾是红方行号，顶栏黑方列号、底栏红方列号。
function renderText(game) {
    const blackFiles = Array.from({ length: COLS }, (_, i) => i + 1).join(" ");
    const redFiles = Array.from({ length: COLS }, (_, i) => COLS - i).join(" ");
    const rows = [];
    for (let r = 0; r < ROWS; r++) {
        let line = "";
        for (let c = 0; c < COLS; c++) {
            const p = game.board[r][c];
            if (!p) line += "＋ ";
            else if (p.side === RED) line += CHAR_OF[p.side][p.type] + " ";
            else line += "[" + CHAR_OF[p.side][p.type] + "]";
        }
        rows.push(String(r + 1).padStart(2, " ") + " " + line + " " + String(ROWS - r).padStart(2, " "));
    }
    return "红方在下（裸字），黑方在上（[字]）；走法 cc21 33 = 前列后行，从自己这头数\n" +
        "  黑方列号 " + blackFiles + "\n" + rows.join("\n") + "\n" +
        "  红方列号 " + redFiles + "\n" +
        "（行号：每行开头是黑方从自己底线数的行号，行尾是红方的）";
}

module.exports = { renderImage, renderText };
