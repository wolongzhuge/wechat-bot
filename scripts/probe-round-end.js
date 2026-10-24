"use strict";
// 临时探针：把一局推到结算，打印每家手牌/副露/牌河张数与牌墙余量，核对总数对不对。
const { MahjongGame } = require("../command/mahjong/game");

function lcg(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const HUMAN = "u1";
const game = new MahjongGame({ modeId: "riichi", rng: lcg(7) });
game.addPlayer(HUMAN, "小明");
game.start();

let steps = 0;
while (steps++ < 5000) {
    if (game.phase === "round-over") break;
    if (game.phase === "claim") { game.claimBy(HUMAN, { claim: "pass" }); continue; }
    if (game.turn === game.seatOf(HUMAN)) {
        const ids = game.concealedIds(game.seatOf(HUMAN));
        let r = null;
        for (const id of ids.slice().reverse()) { r = game.discardBy(HUMAN, id); if (r.ok) break; }
        if (!r || !r.ok) break;
    }
}

const snap = game.snapshot(game.seatOf(HUMAN));
let total = game.wall.length + game.dead.length;
snap.seats.forEach((s) => {
    const meldTiles = s.melds.reduce((n, m) => n + m.tiles.length, 0);
    console.log("seat " + s.seat + " " + s.name + " hand " + s.hand.length + " meldTiles " + meldTiles +
        " river " + s.river.length + " handCount " + s.handCount);
    total += s.hand.length + meldTiles + s.river.length;
});
console.log("phase " + snap.phase + " wall " + game.wall.length + " dead " + game.dead.length + " 总计 " + total);
process.exit(0);
