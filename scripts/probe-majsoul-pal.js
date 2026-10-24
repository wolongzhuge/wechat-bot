"use strict";
// 读雀魂截图，把整张图的像素按 16 格量化聚成主色表，顺便按行扫一条剖面。
const fs = require("fs");
const P = require("./pngread");
const img = P.read(process.argv[2] || "scripts/out/majsoul-live.png");
console.log("尺寸 " + img.width + "x" + img.height + " chans=" + img.chans);

const buckets = new Map();
for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
        const [r, g, b] = img.rgb(x, y);
        const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        buckets.set(key, (buckets.get(key) || 0) + 1);
    }
}
const top = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24);
console.log("--- 主色（量化到 16 格）---");
for (const [k, n] of top) {
    const r = ((k >> 8) & 15) * 16 + 8, g = ((k >> 4) & 15) * 16 + 8, b = (k & 15) * 16 + 8;
    console.log("  rgb(" + [r, g, b].join(",") + ")  #" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("") + "  x" + n);
}

// 中列剖面：从上到下每 12px 一个点，看桌布/面板/手牌的分层
const cx = Math.round(img.width * 0.5);
console.log("--- 中列剖面 x=" + cx + " ---");
for (let y = 0; y < img.height; y += 12) {
    const [r, g, b] = img.rgb(cx, y);
    console.log("  y=" + String(y).padStart(4) + "  rgb(" + r + "," + g + "," + b + ")");
}
