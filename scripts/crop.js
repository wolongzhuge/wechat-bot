"use strict";
// 裁一块并放大，用来检查出图细节：node scripts/crop.js in.png x y w h [scale] out.png
const fs = require("fs");
const path = require("path");
const { read } = require("./pngread");
const { Canvas } = require("../utils/png");

const [f, x, y, w, h, s, out] = process.argv.slice(2);
const scale = Number(s || 3);
const [x0, y0, cw, ch] = [x, y, w, h].map(Number);
const img = read(f);
const cv = new Canvas(cw * scale, ch * scale, [0, 0, 0]);
for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
        const p = img.rgb(x0 + i, y0 + j);
        cv.rect(i * scale, j * scale, i * scale + scale - 1, j * scale + scale - 1, p);
    }
}
const file = out || path.join(__dirname, "out", "crop.png");
fs.writeFileSync(file, cv.toBuffer());
console.log(file);
process.exit(0);
