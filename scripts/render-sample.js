"use strict";
// 把盘面渲染成 PNG 落到本地，用眼睛确认图形没问题
const fs = require("fs");
const path = require("path");
const { GomokuGame } = require("../command/gomoku/game");
const { renderImage } = require("../command/gomoku/render");

const g = new GomokuGame();
g.addPlayer("wxid_1", "甲");
g.addPlayer("wxid_2", "乙");
g.start(false);
for (const [id, r, c] of [
    ["wxid_1", 8, 8], ["wxid_2", 7, 9], ["wxid_1", 9, 7], ["wxid_2", 6, 10],
    ["wxid_1", 10, 6], ["wxid_2", 5, 11], ["wxid_1", 11, 5], ["wxid_2", 1, 1],
    ["wxid_1", 12, 4], ["wxid_2", 15, 15], ["wxid_1", 13, 3],
]) g.place(id, r, c);

const out = path.join(__dirname, "out-gomoku.png");
fs.writeFileSync(out, renderImageToBuffer());
function renderImageToBuffer() {
    return Buffer.from(renderImage(g), "base64");
}
console.log("写出 " + out + " (" + fs.statSync(out).size + " 字节)");
