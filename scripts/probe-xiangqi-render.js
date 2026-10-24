"use strict";
// 象棋盘面出图预览：把带坐标标注的棋盘写成 PNG 落到 scripts/out/，用眼睛验收。
// 只在 scripts/ 下跑，绝不放 command/（command 被 watcher 盯着，会往真实群里发东西）。
const fs = require("fs");
const path = require("path");
const { XiangqiGame } = require("../command/xiangqi/game");
const { renderImage, renderText } = require("../command/xiangqi/render");

const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });

function mk(moves) {
    const g = new XiangqiGame();
    g.addPlayer("R", "阿红");
    g.addPlayer("B", "阿黑");
    g.start(false);
    for (const [who, move] of moves || []) {
        const res = typeof move === "string"
            ? g.tryMove(who, move)
            : g.tryMoveCoord(who, { col: move[0], row: move[1] }, { col: move[2], row: move[3] });
        if (!res.ok) throw new Error("走不下去 " + who + " " + JSON.stringify(move) + "：" + res.hint);
    }
    return g;
}

function save(name, game) {
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(renderImage(game), "base64"));
    console.log(name + "  " + renderText(game).split("\n").length + " 行文本盘面");
}

// 一手记谱 + 一手坐标，看两种写法都能落、标注对不对得上
save("xiangqi-4-side-labels.png", mk([["R", "炮二平五"], ["B", [8, 1, 7, 3]]]));
save("xiangqi-mid.png", mk([
    ["R", "炮二平五"], ["B", "马8进7"], ["R", "马二进三"], ["B", "车9平8"],
    ["R", "车一平二"], ["B", [3, 4, 3, 5]],
]));
console.log("\n=== 文本兜底盘面（第 6 手后） ===");
console.log(renderText(mk([
    ["R", "炮二平五"], ["B", "马8进7"], ["R", "马二进三"], ["B", "车9平8"],
    ["R", "车一平二"], ["B", "卒7进1"],
])));
