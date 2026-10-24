"use strict";
// 预览用：把 15 个字形排成一张图，再画一块摆满棋子的样例棋盘，人工检查字形质量
const fs = require("fs");
const { Canvas } = require("../utils/png");
const { GLYPHS } = require("../command/xiangqi/glyphs");
fs.mkdirSync("tmp", { recursive: true });

function drawGlyph(cv, ch, x, y, color, scale) {
    const glyph = GLYPHS[ch];
    if (!glyph) return;
    for (let row = 0; row < 32; row++) {
        for (let col = 0; col < 32; col++) {
            if (glyph[row] & (0x80000000 >>> col)) {
                cv.rect(x + col * scale, y + row * scale, x + col * scale + scale - 1, y + row * scale + scale - 1, color);
            }
        }
    }
}

const chars = ["车", "马", "相", "象", "仕", "士", "帅", "将", "炮", "兵", "卒", "楚", "河", "汉", "界"];
const cv = new Canvas(5 * 34 + 20, 3 * 36 + 20, [255, 255, 255]);
chars.forEach((ch, i) => {
    const x = 10 + (i % 5) * 34;
    const y = 10 + Math.floor(i / 5) * 36;
    drawGlyph(cv, ch, x, y, [20, 20, 20], 1);
});
fs.writeFileSync("tmp/glyph-preview.png", cv.toBuffer());
console.log("preview written");

// 样例棋盘：棋盘线 + 全子 + 一枚红兵被吃掉的样子，直接看渲染效果
const MARGIN = 40, CELL = 42;
const px = (c) => MARGIN + c * CELL, py = (r) => MARGIN + r * CELL;
const W = MARGIN * 2 + 8 * CELL, H = MARGIN * 2 + 9 * CELL;
const board = new Canvas(W, H, [233, 199, 130]);
const line = [92, 62, 26];
for (let c = 0; c <= 8; c++) {
    if (c === 4) {
        board.lineV(px(c), py(0), py(4), line);
        board.lineV(px(c), py(5), py(9), line);
    } else {
        board.lineV(px(c), py(0), py(9), line);
    }
}
for (let r = 0; r <= 9; r++) board.lineH(py(r), px(0), px(8), line);
board.line(px(3), py(0), px(5), py(2), line);
board.line(px(5), py(0), px(3), py(2), line);
board.line(px(3), py(7), px(5), py(9), line);
board.line(px(5), py(7), px(3), py(9), line);
const R = 19;
function piece(cv, ch, c, r, isRed) {
    cv.circle(px(c), py(r), R, [245, 228, 180]);
    cv.circle(px(c), py(r), R, isRed ? [170, 40, 30] : [40, 40, 40]);
    cv.circle(px(c), py(r), R - 2, [245, 228, 180]);
    drawGlyph(cv, ch, px(c) - 16, py(r) - 16, isRed ? [190, 30, 20] : [20, 20, 20], 1);
}
const backRed = ["车", "马", "相", "仕", "帅", "仕", "相", "马", "车"];
const backBlack = ["车", "马", "象", "士", "将", "士", "象", "马", "车"];
backRed.forEach((ch, c) => piece(board, ch, c, 9, true));
backBlack.forEach((ch, c) => piece(board, ch, c, 0, false));
piece(board, "炮", 1, 7, true); piece(board, "炮", 7, 7, true);
piece(board, "炮", 1, 2, false); piece(board, "炮", 7, 2, false);
for (const c of [0, 2, 4, 6, 8]) { piece(board, "兵", c, 6, true); piece(board, "卒", c, 3, false); }
fs.writeFileSync("tmp/board-preview.png", board.toBuffer());
console.log("board preview written");
