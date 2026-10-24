"use strict";

// 盘面渲染：手机上文本棋盘必然错位，所以默认画 PNG 发群里；
// 图片发不出去时（协议/CDN 抽风）退回文本，至少能看到局面。
const { Canvas } = require("../../utils/png");
const { SIZE, BLACK, WHITE, EMPTY } = require("./game");

const MARGIN = 36;         // 留出坐标数字的位置
const CELL = 28;
const STONE_R = 12;

const COLOR = {
    wood: [232, 197, 130],
    line: [92, 62, 26],
    label: [70, 46, 18],
    black: [24, 24, 24],
    blackHi: [90, 90, 90],
    white: [246, 246, 246],
    whiteEdge: [60, 60, 60],
    mark: [214, 40, 40],
};

function px(i) {
    // 第 i 条线（0 基）的像素坐标
    return MARGIN + i * CELL;
}

function boardSize() {
    return MARGIN * 2 + (SIZE - 1) * CELL;
}

function drawStone(cv, x, y, color) {
    if (color === BLACK) {
        cv.circle(x, y, STONE_R, COLOR.black);
        cv.circle(x - 3, y - 4, 3, COLOR.blackHi);
    } else {
        cv.circle(x, y, STONE_R + 1, COLOR.whiteEdge);
        cv.circle(x, y, STONE_R, COLOR.white);
        cv.circle(x - 3, y - 4, 3, [255, 255, 255]);
    }
}

// 最后一手用红框标出，五连的每颗子中心点红点
function markLast(cv, row, col) {
    const x = px(col - 1), y = px(row - 1);
    const s = STONE_R + 4;
    const t = 5; // 角上的短边长度
    cv.rect(x - s, y - s, x - s + t, y - s, COLOR.mark);
    cv.rect(x + s - t, y - s, x + s, y - s, COLOR.mark);
    cv.rect(x - s, y + s, x - s + t, y + s, COLOR.mark);
    cv.rect(x + s - t, y + s, x + s, y + s, COLOR.mark);
    cv.rect(x - s, y - s, x - s, y - s + t, COLOR.mark);
    cv.rect(x + s, y - s, x + s, y - s + t, COLOR.mark);
    cv.rect(x - s, y + s - t, x - s, y + s, COLOR.mark);
    cv.rect(x + s, y + s - t, x + s, y + s, COLOR.mark);
}

function renderImage(game) {
    const side = boardSize();
    const cv = new Canvas(side, side, COLOR.wood);

    for (let i = 0; i < SIZE; i++) {
        cv.lineH(px(i), px(0), px(SIZE - 1), COLOR.line);
        cv.lineV(px(i), px(0), px(SIZE - 1), COLOR.line);
    }
    // 标准星位
    for (const r of [2, 6, 10]) {
        for (const c of [2, 6, 10]) cv.circle(px(c), px(r), 3, COLOR.line);
    }
    // 行列数字
    for (let i = 0; i < SIZE; i++) {
        const label = String(i + 1);
        const w = label.length * 8 + (label.length - 1) * 1;
        cv.text(label, px(i) - Math.ceil(w / 2), 8, COLOR.label, 1);           // 列号在上
        cv.text(label, 8, px(i) - 4, COLOR.label, 1);                          // 行号在左
    }

    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            const v = game.cellAt(r + 1, c + 1);
            if (v !== EMPTY) drawStone(cv, px(c), px(r), v);
        }
    }
    const last = game.moves[game.moves.length - 1];
    if (last) markLast(cv, last.row, last.col);
    for (const cell of game.winLine) {
        cv.circle(px(cell.col - 1), px(cell.row - 1), 4, COLOR.mark);
    }
    return cv.toBuffer().toString("base64");
}

function renderText(game) {
    const glyph = { [EMPTY]: "・", [BLACK]: "●", [WHITE]: "○" };
    const head = "   " + Array.from({ length: SIZE }, (_, i) => String(i + 1).padStart(2) + " ").join("");
    const rows = [];
    for (let r = 1; r <= SIZE; r++) {
        let line = String(r).padStart(2) + " ";
        for (let c = 1; c <= SIZE; c++) line += glyph[game.cellAt(r, c)] + " ";
        rows.push(line);
    }
    return head + "\n" + rows.join("\n");
}

module.exports = { renderImage, renderText, boardSize };
