"use strict";
// 临时探针：把数字 0 在常见字号下画出来，挑一个不像方框的点阵。
const fs = require("fs");
const path = require("path");
const { Canvas } = require("../utils/png");

const OUT = path.join(__dirname, "out");
const cv = new Canvas(560, 220, [18, 18, 24]);
cv.text("余 0   10000点   30 张   -5  0.5", 12, 16, [230, 200, 120], 2);
cv.text("余 0   10000点   30 张   -5  0.5", 12, 60, [230, 200, 120], 1);
cv.text("0 8 9 6 0 8 0 0", 12, 100, [230, 220, 200], 3);
cv.text("0 8 9 6 0 8 0 0", 12, 160, [230, 220, 200], 4);
fs.writeFileSync(path.join(OUT, "digits.png"), cv.toBuffer());
console.log("scripts/out/digits.png");
process.exit(0);
