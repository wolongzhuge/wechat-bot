"use strict";
// 玩法层热重载：只清 message/ command/ dou/ 三个目录的 require 缓存再重新加载。
// message/ 下的处理器加载时会自己向 dispatch 注册（换槽位），加载成功才生效；
// 任何文件报错，旧处理器原样继续跑，牌局状态在 state/store.js 里不受影响。
// 引擎类换了新版本时，把在场牌局的实例原型也切到新类（数据原地不动）。

const fs = require("fs");
const path = require("path");
const store = require("../state/store");

const ROOT = path.join(__dirname, "..");
// dou/ 是顶层目录（斗地主引擎），和 message/ command/ 一样属于玩法层
const RELOADABLE_DIRS = ["message", "command", "dou"];

function walk(dir) {
    const out = [];
    for (const name of fs.readdirSync(dir)) {
        const abs = path.join(dir, name);
        if (fs.statSync(abs).isDirectory()) out.push(...walk(abs));
        else if (name.endsWith(".js")) out.push(abs);
    }
    return out;
}

function reloadAll() {
    store.save(); // 热重载前先把当前状态落盘

    const files = RELOADABLE_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)));
    for (const f of files) delete require.cache[require.resolve(f)];

    const report = [];
    for (const f of walk(path.join(ROOT, "message")).sort()) {
        try {
            require(f); // 处理器加载时自己注册到 dispatch
            report.push("OK " + path.relative(ROOT, f));
        } catch (err) {
            report.push("FAIL " + path.relative(ROOT, f) + "：" + err.message);
        }
    }

    // 只有 message 层整体加载成功，才把在场牌局的原型切到新引擎类
    if (!report.some((line) => line.startsWith("FAIL"))) {
        store.rebase({
            DouDiZhuGame: require("../dou/game").DouDiZhuGame,
            Player: require("../dou/player").Player,
            GomokuGame: require("../command/gomoku/game").GomokuGame,
            XiangqiGame: require("../command/xiangqi/game").XiangqiGame,
            UnoGame: require("../command/uno/game").UnoGame,
            JunqiGame: require("../command/junqi/game").JunqiGame,
            MahjongGame: require("../command/mahjong/game").MahjongGame,
        });
    }
    return report;
}

module.exports = { reloadAll };
