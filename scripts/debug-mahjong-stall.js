"use strict";
// 找「纯机器人自打中途停住」的那一手：用固定种子重放，把停住时的状态和最后几个事件打出来。
// 只 require 玩法层，绝不 require app.js（会起第二个轮询抢 Sync 游标）。

const T = require("../command/mahjong/tiles");
const Rules = require("../command/mahjong/rules");
const { MahjongGame } = require("../command/mahjong/game");

function lcg(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const modeId = process.argv[2] || "riichi";
const from = Number(process.argv[3] || 0);
const to = Number(process.argv[4] || 400);

for (let seed = from; seed < to; seed++) {
    const game = new MahjongGame({ modeId, allowBotsOnly: true, rng: lcg(seed) });
    const events = game.start();
    if (game.phase === "round-over") continue;
    console.log("seed " + seed + " 停在 " + game.phase + " turn=" + game.turn +
        " 牌墙=" + game.wall.length + " drawn=" + game.idOf(game.drawn) +
        " claim=" + JSON.stringify(game.claim && { tile: game.claim.tile, from: game.claim.from, offers: Object.keys(game.claim.offers), answers: Object.keys(game.claim.answers) }));
    console.log(game.statusText());
    console.log("  最后事件：" + JSON.stringify(events.slice(-8)));
    for (let s = 0; s < 4; s++) {
        const s2 = game.seats[s];
        console.log("  " + s + " " + s2.name + " 手=" + game.handText(s) + " 河=" + game.riverText(s));
    }
    process.exit(0);
}
console.log("seed " + from + ".." + to + " 全部打完，没有卡住（" + modeId + "）");
