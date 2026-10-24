"use strict";
// 军棋盘面渲染：5 列 × 12 行的交叉点画成 PNG 发群（暗棋，盘面上只有红蓝圆片，看不出子力大小）。
// 铁路画粗线（3 像素），公路画细线；行营画圆圈，大本营画菱形；最后一手四角画红框。
// 汉字点阵这套渲染器没有，所以图里只出现 A~E 和 1~12，子力全称走聊天文字（cc战报）。
// 出图失败时调用方退回 renderText 的文字盘面。

const { Canvas } = require("../../utils/png");
const { RED, BLUE, ADJ, CAMP_LABEL, HQ_LABEL, COL_LETTER } = require("./game");

const CELL = 44;
const MARGIN_L = 52, MARGIN_R = 52, MARGIN_T = 70;
const COLS = 5, ROWS = 12;
const PIECE_R = 15;
// 底部留给列号 + 三行图例
const FOOTER = 92;

const COLOR = {
    bg: [226, 218, 194],
    mountain: [206, 197, 168],
    rail: [58, 58, 58],
    road: [120, 112, 96],
    camp: [70, 66, 54],
    hq: [140, 60, 30],
    label: [70, 62, 40],
    mark: [214, 40, 40],
    redRing: [150, 25, 20],
    redFace: [228, 124, 112],
    blueRing: [25, 60, 150],
    blueFace: [124, 160, 226],
    text: [50, 46, 36],
};

function px(colLetter) { return MARGIN_L + COL_LETTER.indexOf(colLetter) * CELL; }
function py(row) { return MARGIN_T + (row - 1) * CELL; }
function xy(label) { return [px(label[0]), py(Number(label.slice(1)))]; }

function textCentered(cv, str, cx, cy, color, scale) {
    const w = String(str).length * (8 * scale + scale) - scale;
    cv.text(str, Math.round(cx - w / 2), cy, color, scale);
}

// 粗线：横线上下各挪一像素，竖线左右各挪一像素，斜线挪对角
function thickLine(cv, x0, y0, x1, y1, color) {
    if (y0 === y1) {
        for (const d of [-1, 0, 1]) cv.lineH(y0 + d, x0, x1, color);
    } else if (x0 === x1) {
        for (const d of [-1, 0, 1]) cv.lineV(x0 + d, y0, y1, color);
    } else {
        for (const d of [-1, 0, 1]) cv.line(x0 + d, y0 + d, x1 + d, y1 + d, color);
    }
}

function drawPiece(cv, x, y, side) {
    const red = side === RED;
    cv.circle(x, y, PIECE_R, red ? COLOR.redRing : COLOR.blueRing);
    cv.circle(x, y, PIECE_R - 3, red ? COLOR.redFace : COLOR.blueFace);
    cv.circle(x, y, 5, red ? COLOR.redRing : COLOR.blueRing);
}

function drawCamp(cv, x, y) {
    cv.circle(x, y, 12, COLOR.camp);
    cv.circle(x, y, 10, COLOR.bg);
}

function drawHQ(cv, x, y) {
    const r = 18;
    cv.line(x, y - r, x + r, y, COLOR.hq);
    cv.line(x + r, y, x, y + r, COLOR.hq);
    cv.line(x, y + r, x - r, y, COLOR.hq);
    cv.line(x - r, y, x, y - r, COLOR.hq);
}

// 最后一手：四角画向内的红括号
function markCell(cv, x, y) {
    const s = PIECE_R + 5, len = 10;
    for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
            const cx = x + sx * s, cy = y + sy * s;
            cv.lineH(cy, Math.min(cx, cx - sx * len), Math.max(cx, cx - sx * len), COLOR.mark);
            cv.lineV(cx, Math.min(cy, cy - sy * len), Math.max(cy, cy - sy * len), COLOR.mark);
        }
    }
}

function renderImage(game) {
    const W = MARGIN_L + MARGIN_R + (COLS - 1) * CELL;
    const H = MARGIN_T + (ROWS - 1) * CELL + FOOTER;
    const cv = new Canvas(W, H, COLOR.bg);

    // 山界带：第 6 行和第 7 行之间
    cv.rect(0, py(6) + 3, W - 1, py(7) - 3, COLOR.mountain);

    // 连线：铁路压粗线，公路细线
    const drawn = {};
    for (const [from, list] of Object.entries(ADJ)) {
        for (const e of list) {
            const key = from < e.to ? from + "|" + e.to : e.to + "|" + from;
            if (drawn[key]) continue;
            drawn[key] = true;
            const [x0, y0] = xy(from), [x1, y1] = xy(e.to);
            if (e.rail) thickLine(cv, x0, y0, x1, y1, COLOR.rail);
            else cv.line(x0, y0, x1, y1, COLOR.road);
        }
    }
    for (const point of Object.keys(CAMP_LABEL)) drawCamp(cv, ...xy(point));
    for (const point of Object.keys(HQ_LABEL)) drawHQ(cv, ...xy(point));

    // 坐标：左右两侧行号 1~12，上下列号 A~E
    for (let r = 1; r <= ROWS; r++) {
        textCentered(cv, String(r), MARGIN_L - 28, py(r) - 8, COLOR.label, 2);
        textCentered(cv, String(r), W - MARGIN_R + 28, py(r) - 8, COLOR.label, 2);
    }
    const bottomY = py(ROWS);
    for (let c = 0; c < COLS; c++) {
        const x = MARGIN_L + c * CELL;
        textCentered(cv, COL_LETTER[c], x, MARGIN_T - 26, COLOR.label, 2);
        textCentered(cv, COL_LETTER[c], x, bottomY + 22, COLOR.label, 2);
    }

    // 暗子：只画颜色圆片，看不出大小
    for (const [l, p] of Object.entries(game.board)) {
        if (!p) continue;
        const [x, y] = xy(l);
        drawPiece(cv, x, y, p.side);
    }

    const last = game.moves[game.moves.length - 1];
    if (last) {
        markCell(cv, ...xy(last.from));
        if (game.board[last.to]) markCell(cv, ...xy(last.to));
    }

    // 底部图例：8x8 点阵只有拉丁字符，子力全称走聊天文字
    const deadBlue = game.dead.filter((d) => d.side === BLUE).length;
    const deadRed = game.dead.filter((d) => d.side === RED).length;
    cv.text("BLUE=TOP 1-6   RED=BTM 7-12", 10, bottomY + 44, COLOR.text, 1);
    cv.text("CIRCLE=CAMP  DIAMOND=HQ", 10, bottomY + 56, COLOR.text, 1);
    cv.text("THICK=RAIL  DEAD B:" + deadBlue + " R:" + deadRed, 10, bottomY + 68, COLOR.text, 1);
    return cv.toBuffer().toString("base64");
}

// 文字兜底：图上发不出去时用（行营 营 / 大本营 本 / 蓝子 ● / 红子 ○）
function renderText(game) {
    const lines = [];
    lines.push("    " + COL_LETTER.join("   "));
    for (let r = 1; r <= ROWS; r++) {
        const cells = [];
        for (const c of COL_LETTER) {
            const l = c + r;
            const p = game.board[l];
            if (p) cells.push(p.side === BLUE ? "●" : "○");
            else if (CAMP_LABEL[l]) cells.push("营");
            else if (HQ_LABEL[l]) cells.push("本");
            else cells.push("＋");
        }
        lines.push(String(r).padStart(2, " ") + "  " + cells.join("  ") + (r === 6 ? "   ~~~ 山界 ~~~" : ""));
    }
    const deadRed = game.dead.filter((d) => d.side === RED).length;
    const deadBlue = game.dead.filter((d) => d.side === BLUE).length;
    return "【军棋盘面】●=蓝方暗子 ○=红方暗子 营=行营 本=大本营\n蓝方在上（1~6 行），红方在下（7~12 行）\n" +
        "阵亡：蓝 " + deadBlue + " 枚 / 红 " + deadRed + " 枚\n" + lines.join("\n") +
        "\n坐标写法：列 A~E + 行 1~12，走子发 cc走B7-C7";
}

module.exports = { renderImage, renderText };
