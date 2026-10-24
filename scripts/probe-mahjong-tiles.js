"use strict";
// 牌面美术的放大检查图：把 34 种牌各画一遍（大尺寸），人眼确认筒/条/万/字画得对不对。
// 只 require command/mahjong/*，绝不 require app.js（会抢 Sync 游标 = 掉线）。
const fs = require("fs");
const path = require("path");
const { Canvas } = require("../utils/png");
const A = require("../command/mahjong/tileart");
const T = require("../command/mahjong/tiles");

const OUT = path.join(__dirname, "out");
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const TW = 56, TH = 76, GAP = 8, PER = 9;
const ids = [];
for (let id = 0; id < 34; id++) ids.push(id);
ids.push(4);   // 赤五万
const rows = Math.ceil(ids.length / PER);
const PITCH = TH + 50;   // 一行里要叠两张：上面放大牌，下面放牌河实际尺寸
const cv = new Canvas(PER * (TW + GAP) + GAP, rows * PITCH + GAP + 24, A.PAL.table1);
A.paintTable(cv, cv.width, cv.height);
ids.forEach((id, i) => {
    const red = i === ids.length - 1;
    const x = GAP + (i % PER) * (TW + GAP);
    const y = GAP + Math.floor(i / PER) * PITCH;
    A.drawTile(cv, x, y, { id: red ? 4 : id, red: red }, { w: TW, h: TH, mark: i % 5 === 0 ? "dora" : "" });
    A.drawTile(cv, x, y + TH + 4, { id: red ? 4 : id, red: red }, { w: 28, h: 38 });   // 同张牌的牌河尺寸
});
fs.writeFileSync(path.join(OUT, "mahjong-tile-sheet.png"), cv.toBuffer());
console.log("写出 scripts/out/mahjong-tile-sheet.png  " + cv.width + "x" + cv.height);
process.exit(0);
