"use strict";
// 牌数守恒探针：真人座位随机应声、随机做决定，只要某一步之后
// 「墙上+死牌+手牌+牌河+副露」不再等于 108（+虚牌），就把那一步和前后事件打出来。
// 只 require 玩法层，绝不 require app.js。
//
// 跑法：node scripts/probe-mahjong-census.js [sichuan|gd|riichi] [轮数]

const Rules = require("../command/mahjong/rules");
const T = require("../command/mahjong/tiles");
const { MahjongGame } = require("../command/mahjong/game");

function lcg(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function count(game) {
    let total = game.wall.length + game.dead.length;
    for (const s of game.seats) {
        total += s.hand.length + s.river.length;
        for (const m of s.melds) total += m.tiles.length;
    }
    return total;
}

const modeId = process.argv[2] || "sichuan";
const rounds = Number(process.argv[3] || 200);

for (let seed = 1; seed <= rounds; seed++) {
    const rnd = lcg(seed);
    const game = new MahjongGame({ modeId, allowBotsOnly: true, rng: rnd, shuffleSeats: true });
    game.addPlayer("u1", "小明");
    let ev = game.start();
    const want = Rules.buildWall(game.mode).length;
    let step = 0;
    let history = [];

    while (game.phase !== "round-over" && step < 400) {
        step++;
        const got = count(game);
        if (got !== want + (game.phantomTiles || 0)) {
            console.log("seed " + seed + " 第 " + step + " 步后牌数 " + got + " ≠ " + want +
                "（虚牌 " + (game.phantomTiles || 0) + "）  phase=" + game.phase + " turn=" + game.turn);
            console.log("  最近三步：" + JSON.stringify(history.slice(-3)));
            console.log("  本步事件：" + JSON.stringify(ev).slice(0, 600));
            for (let s = 0; s < 4; s++) {
                console.log("   " + s + " 手" + game.seats[s].hand.length + " 河" + game.seats[s].river.length +
                    " 副露" + JSON.stringify(game.seats[s].melds.map((m) => [m.type, m.tiles.length])) +
                    (game.seats[s].out ? " [已和]" : ""));
            }
            process.exit(0);
        }
        history.push({ phase: game.phase, turn: game.turn, ev: ev.map((e) => e.type) });

        const me = game.players.u1;
        let before = game.phase;
        if (game.phase === "que" && !game.seats[me].queSuit) {
            game.setQueBy("u1", ["m", "p", "s"][Math.floor(rnd() * 3)]);
            ev = [{ type: "que-human" }];
        } else if (game.phase === "claim" && game.claim && game.claim.offers[me] && !game.claim.answers[me]) {
            const o = game.claim.offers[me];
            const choices = [];
            if (o.ron) choices.push({ claim: "ron" });
            if (o.pon) choices.push({ claim: "pon" });
            if (o.kan) choices.push({ claim: "kan" });
            if (o.chi && o.chi.length) {
                choices.push({ claim: "chi", ranks: o.chi[0].map((x) => T.rankOf(x)) });
                choices.push({ claim: "chi" });                     // 有时故意不给点数
            }
            choices.push({ claim: "pass" });
            const r = game.claimBy("u1", choices[Math.floor(rnd() * choices.length)]);
            ev = (r.events || []).concat(r.ok ? [] : [{ type: "reject", text: r.hint }]);
        } else if (game.phase === "discard" && game.turn === me) {
            const ids = game.seats[me].hand.map((t) => game.idOf(t));
            const r = game.discardBy("u1", ids[Math.floor(rnd() * ids.length)]);
            ev = (r.events || []).concat(r.ok ? [] : [{ type: "reject", text: r.hint }]);
        } else {
            ev = [{ type: "wait" }];
        }
        if (game.phase === before && ev[0] && ev[0].type === "wait") break;   // 卡住就别死循环
    }
}
console.log("跑完 " + rounds + " 局（" + modeId + "），牌数一直守恒");
