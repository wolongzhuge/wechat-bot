"use strict";
// 钉住的状态模块：模式表 + 各张游戏桌都在这里，热重载永远不碰这个文件。
// 快照 data/state.json：每 5 秒、进程退出、热重载前三处落盘，启动时恢复 —— 无损更新的核心。

const fs = require("fs");
const path = require("path");

const { DouDiZhuGame } = require("../dou/game");
const { Player } = require("../dou/player");
const { GomokuGame } = require("../command/gomoku/game");
const { XiangqiGame } = require("../command/xiangqi/game");
const { UnoGame } = require("../command/uno/game");
const { JunqiGame } = require("../command/junqi/game");
const { MahjongGame } = require("../command/mahjong/game");

// 引擎类注册表：热重载换了新引擎类时，rebase() 把在场牌局的实例原型切到新类
const classes = { DouDiZhuGame, Player, GomokuGame, XiangqiGame, UnoGame, JunqiGame, MahjongGame };

const modeMap = new Map(); // room -> 模式名
const gameMaps = {
    dou: new Map(),      // room -> DouDiZhuGame
    gomoku: new Map(),   // room -> GomokuGame
    xiangqi: new Map(),  // room -> XiangqiGame
    uno: new Map(),      // room -> UnoGame
    junqi: new Map(),    // room -> JunqiGame
    mahjong: new Map(),  // room -> MahjongGame
};

// env 里 state_file 可以改快照位置（测试用它指到独立文件，不碰真实状态）
const SNAPSHOT_FILE = process.env.state_file || path.join(__dirname, "..", "data", "state.json");
let lastWritten = "";

function reviveGame(kind, plain) {
    if (kind === "dou") {
        const game = Object.assign(Object.create(classes.DouDiZhuGame.prototype), plain);
        game.players = (plain.players || []).map((p) => Object.assign(Object.create(classes.Player.prototype), p));
        // landlord 快照里是玩家对象的副本，指回 hydre 后的同一个实例
        if (plain.landlord) game.landlord = game.players.find((p) => p.id === plain.landlord.id) || null;
        return game;
    }
    if (kind === "uno") {
        const game = Object.assign(Object.create(classes.UnoGame.prototype), plain);
        if (plain.winner) game.winner = game.players.find((p) => p.id === plain.winner.id) || null;
        return game;
    }
    if (kind === "mahjong") {
        const game = Object.assign(Object.create(classes.MahjongGame.prototype), plain);
        // mode 里挂着 score/gangSettle 这些函数，JSON 存不住 —— 按 modeId 重新取一份活的规则
        game.mode = require("../command/mahjong/rules").get(plain.modeId);
        // claimedObjs 是 Set，快照里变成一个 {}，恢复后 .has 会当场崩
        game.claimedObjs = new Set();
        game.rng = null;            // 随机源是函数，恢复不了；下一局重新洗牌就是
        game.phantomTiles = plain.phantomTiles || 0;
        // 声明窗口里那张牌要重新指回牌河原件，不然恢复后碰/吃会把它复制成两张
        game.relinkRefs();
        return game;
    }
    // 五子棋/象棋/军棋的局对象都是纯数据，套上对应引擎原型即可
    const cls = kind === "gomoku" ? classes.GomokuGame : kind === "junqi" ? classes.JunqiGame : classes.XiangqiGame;
    return Object.assign(Object.create(cls.prototype), plain);
}

function save() {
    try {
        const payload = JSON.stringify({
            savedAt: new Date().toISOString(),
            modeMap: [...modeMap.entries()],
            games: Object.fromEntries(
                Object.entries(gameMaps).map(([kind, map]) => [
                    kind,
                    [...map.entries()].map(([room, game]) => [room, JSON.parse(JSON.stringify(game))]),
                ])
            ),
        });
        if (payload === lastWritten) return;
        const tmp = SNAPSHOT_FILE + ".tmp";
        fs.writeFileSync(tmp, payload);
        fs.renameSync(tmp, SNAPSHOT_FILE);
        lastWritten = payload;
    } catch (err) {
        console.error("快照保存失败: " + err.message);
    }
}

function restore() {
    try {
        const data = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"));
        if (data && Array.isArray(data.modeMap)) {
            modeMap.clear();
            for (const [room, mode] of data.modeMap) modeMap.set(room, mode);
        }
        if (data && data.games) {
            for (const kind of Object.keys(gameMaps)) {
                const list = data.games[kind];
                if (!Array.isArray(list)) continue;
                const map = gameMaps[kind];
                map.clear();
                for (const [room, plain] of list) map.set(room, reviveGame(kind, plain));
            }
        }
        const tables = Object.values(gameMaps).reduce((n, m) => n + m.size, 0);
        console.log("已恢复状态快照：模式 " + modeMap.size + " 个群，" + tables + " 桌牌局");
        return true;
    } catch (err) {
        if (err.code !== "ENOENT") console.error("快照恢复失败: " + err.message);
        return false;
    }
}

// 热重载后调用：旧实例换上新引擎类原型，牌局数据原地不动
function rebase(newClasses) {
    Object.assign(classes, newClasses);
    for (const game of gameMaps.dou.values()) {
        Object.setPrototypeOf(game, classes.DouDiZhuGame.prototype);
        for (const p of game.players) Object.setPrototypeOf(p, classes.Player.prototype);
    }
    for (const game of gameMaps.gomoku.values()) Object.setPrototypeOf(game, classes.GomokuGame.prototype);
    for (const game of gameMaps.xiangqi.values()) Object.setPrototypeOf(game, classes.XiangqiGame.prototype);
    for (const game of gameMaps.uno.values()) Object.setPrototypeOf(game, classes.UnoGame.prototype);
    for (const game of gameMaps.junqi.values()) Object.setPrototypeOf(game, classes.JunqiGame.prototype);
    for (const game of gameMaps.mahjong.values()) {
        Object.setPrototypeOf(game, classes.MahjongGame.prototype);
        // 规则对象是模块里的常量表，热重载换了新版本要重新指一次（函数成员不在实例上）
        game.mode = require("../command/mahjong/rules").get(game.modeId);
    }
}

for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
        save();
        process.exit(0);
    });
}
process.on("exit", () => save());
setInterval(save, 5000);

module.exports = { modeMap, gameMaps, classes, save, restore, rebase };
