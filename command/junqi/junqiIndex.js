"use strict";
// 军棋（两人暗棋）：机器人当裁判。布阵和子力身份私聊发给本人，群里只贴暗子盘面和阵亡亮子。
// 上桌 → 各自 cc布阵（随机一版，可 cc换位 微调）→ 两人都布好自动开打 → cc走B7-C7。
const { client } = require("../../app");
const { JunqiGame, SIDE_NAME, FULL_NAME, parseMove, RED, BLUE } = require("./game");
const { renderImage, renderText } = require("./render");

// state/store.js 是钉住模块，热重载换不掉：老进程里 gameMaps.junqi 还不存在，
// 这里补一张同名 Map，新模式才能不重启机器人直接 cc热更上线（重启后走 store 里登记的那张）。
const store = require("../../state/store");
const games = store.gameMaps.junqi || (store.gameMaps.junqi = new Map());

const FORMAT_HINT = "走法：cc走B7-C7（起点-终点，列 A~E、行 1~12）｜cc棋盘 看盘面｜cc战报 看亮子｜cc状态 看轮到谁";

function gameOf(event) { return games.get(event.group_id); }

function postBoard(event, game) {
    let b64 = null;
    try {
        b64 = renderImage(game);
    } catch (err) {
        console.error("军棋盘面渲染失败: " + err.message);
    }
    if (!b64) return event.reply(renderText(game));
    return event.reply({ image: b64 }).catch((err) => {
        console.error("军棋盘面图片发送失败，改发文本: " + err.message);
        return event.reply(renderText(game));
    });
}

// 阵图只私聊发给本人，别人看不到子力大小；sendTempMsg 自己会在发不出去时回群里点名
function sendLayout(event, player) {
    const game = gameOf(event);
    client.sendTempMsg(event.group_id, player.id, game.layoutText(player.side))
        .catch((err) => console.error("军棋阵图私聊失败: " + err.message));
}

async function joinCommand(event) {
    const room = event.group_id;
    const userId = event.sender.user_id;
    const name = client.displayName(userId);
    let game = gameOf(event);
    if (game && game.started) return event.reply("【军棋】这局已经开打了，打完发 cc结束 再开新桌。");
    // 布阵图私聊发，不是好友收不到，坐下也玩不了
    if (!(await client.isFriend(userId))) {
        return event.reply("【军棋】你还没加机器人为好友，收不到私聊的阵图，先加好友再来上桌。");
    }
    if (!game) {
        game = new JunqiGame();
        games.set(room, game);
    }
    const added = game.addPlayer(userId, name);
    if (!added.ok) return event.reply("【军棋】" + added.reason);

    const red = game.playerBySide(RED), blue = game.playerBySide(BLUE);
    if (game.players.length < 2) {
        return event.reply(
            "【军棋】" + name + " 上桌成功，你是" + SIDE_NAME[added.player.side] + "（红先走）\n" +
            "再拉一个人发 cc军棋 就能开打。\n" +
            "人齐后各自发 cc布阵（随机一版阵，可用 cc换位 B12 C12 微调），两人都布好自动开局。"
        );
    }
    return event.reply(
        "【军棋】两人就位：" + red.name + "（红，先走） 对 " + blue.name + "（蓝）\n" +
        "各自发 cc布阵 摆阵，两人都布好就自动开打。\n" +
        "布阵规矩：军旗只能放大本营（红 B12/D12，蓝 B1/D1），地雷只能放后两线，炸弹不能放锋线，行营里不能摆子。"
    );
}

function deployCommand(event) {
    const game = gameOf(event);
    if (!game) return event.reply("【军棋】这里还没有棋桌，发 cc军棋 上桌（两个人就能玩）。");
    const player = game.playerById(event.sender.user_id);
    if (!player) return event.reply("【军棋】你不在这局里，发 cc军棋 加入。");
    if (game.started) return event.reply("【军棋】已经开局了，不能再摆阵。" + FORMAT_HINT);
    game.randomDeploy(player.side);
    sendLayout(event, player);
    const ready = game.startIfReady();
    if (!ready.ok) {
        return event.reply("【军棋】" + player.name + " 已布阵（阵图已私聊发你）\n" + ready.hint);
    }
    return event.reply(
        "【军棋】" + game.players.map((p) => p.name).join("、") + " 都布好阵，开打！红先\n" +
        "盘面已发群（暗子看不出大小），阵图各自在私聊里\n" + FORMAT_HINT
    ).then(() => postBoard(event, game));
}

function showLayoutCommand(event) {
    const game = gameOf(event);
    if (!game) return event.reply("【军棋】这里还没有棋桌，发 cc军棋 上桌。");
    const player = game.playerById(event.sender.user_id);
    if (!player) return event.reply("【军棋】你不在这局里，发 cc军棋 加入。");
    if (!Object.values(game.board).some((p) => p && p.side === player.side)) {
        return event.reply("【军棋】你还没布阵，发 cc布阵 摆一版（摆完阵图也会私聊发你）。");
    }
    sendLayout(event, player);
    return event.reply("【军棋】阵图已私聊发给 " + player.name + "。");
}

function swapCommand(event, text) {
    const game = gameOf(event);
    if (!game) return event.reply("【军棋】这里还没有棋桌，发 cc军棋 上桌。");
    if (game.started) return event.reply("【军棋】已经开局了，不能换位，只能走子。" + FORMAT_HINT);
    const player = game.playerById(event.sender.user_id);
    if (!player) return event.reply("【军棋】你不在这局里，发 cc军棋 加入。");
    const parts = parseMove(text);
    if (!parts) return event.reply("【军棋】换位写法：cc换位 B12 C12（两枚自己的子交换位置）");
    const r = game.swapOwn(player.side, parts[0], parts[1]);
    if (!r.ok) return event.reply("【军棋】" + r.hint);
    sendLayout(event, player);
    return event.reply("【军棋】" + player.name + " 换好了 " + parts[0] + " ↔ " + parts[1] + "，新阵图已私聊发你。");
}

function moveCommand(event, text) {
    const game = gameOf(event);
    if (!game) return event.reply("【军棋】这里还没有棋桌，发 cc军棋 上桌（两个人就能玩）。");
    const res = game.tryMove(event.sender.user_id, text);
    if (!res.ok) return event.reply("【军棋】" + res.hint + "\n" + game.statusText());

    const mover = game.playerById(event.sender.user_id);
    const lines = ["【军棋】" + SIDE_NAME[mover.side] + " " + mover.name + " " + res.notation + "：" + res.note];
    for (const s of res.shown || []) lines.push(s);
    if (res.over) {
        lines.push("【军棋】" + mover.name + "（" + SIDE_NAME[mover.side] + "）获胜，" + res.winBy +
            "，共 " + game.moves.length + " 手\n发 cc军棋 立刻再来一局，或 cc结束 清盘。");
        return event.reply(lines.join("\n")).then(() => postBoard(event, game));
    }
    lines.push(game.statusText());
    return event.reply(lines.join("\n")).then(() => postBoard(event, game));
}

function boardCommand(event) {
    const game = gameOf(event);
    if (!game) return event.reply("【军棋】这里没有棋桌，发 cc军棋 开一局。");
    return event.reply(game.statusText()).then(() => postBoard(event, game));
}

function reportCommand(event) {
    const game = gameOf(event);
    if (!game) return event.reply("【军棋】这里没有棋桌，发 cc军棋 开一局。");
    const bySide = { [RED]: [], [BLUE]: [] };
    for (const d of game.dead) bySide[d.side].push(FULL_NAME[d.type] + "(" + d.at + ")");
    const lines = ["【军棋】亮出的阵亡子：" +
        "\n红方 " + (bySide.r.length ? bySide.r.join("、") : "无") +
        "\n蓝方 " + (bySide.b.length ? bySide.b.join("、") : "无")];
    const recent = game.log.slice(-6).map((x) => x.text);
    if (recent.length) lines.push("最近战况：\n" + recent.join("\n"));
    else lines.push("还没有战斗记录。");
    lines.push(game.statusText());
    return event.reply(lines.join("\n"));
}

function statusCommand(event) {
    const game = gameOf(event);
    if (!game) return event.reply("【军棋】这里没有棋桌，发 cc军棋 开一局。");
    return event.reply(game.statusText() + "\n" + FORMAT_HINT);
}

function resignCommand(event) {
    const game = gameOf(event);
    if (!game) return event.reply("【军棋】这里没有棋桌。");
    const r = game.resign(event.sender.user_id);
    if (!r.ok) return event.reply("【军棋】" + r.hint);
    return event.reply(
        "【军棋】" + r.player.name + " 认输，" + r.other.name + "（" + SIDE_NAME[r.other.side] + "）获胜，共 " +
        game.moves.length + " 手\n发 cc军棋 再来一局。"
    ).then(() => postBoard(event, game));
}

function endCommand(event) {
    if (!gameOf(event)) return event.reply("【军棋】这里没有棋桌。");
    const game = gameOf(event);
    const summary = game.moves.length + " 手，" + game.players.map((p) => p.name).join("、");
    games.delete(event.group_id);
    return event.reply("【军棋】已清盘（" + summary + "）。开新局发 cc军棋。");
}

function rulesCommand(event) {
    return event.reply(
        "【军棋规则】两人暗棋，机器人当裁判，子力大小只有你自己知道\n" +
        "每方 25 枚：司令/军长/军旗 各 1，师长/旅长/团长/营长/炸弹 各 2，连长/排长/工兵/地雷 各 3\n" +
        "大吃小：司令>军长>师长>旅长>团长>营长>连长>排长>工兵；同级同归于尽\n" +
        "炸弹和任何子同归于尽；工兵能挖地雷，别的子撞雷就阵亡；地雷和军旗不能动\n" +
        "司令阵亡的那一方，军旗位置公开\n" +
        "走法：公路走一格；铁路不限步数但只能直行不能拐弯，只有工兵能沿铁路拐弯\n" +
        "行营里的子不能被吃，从行营出发只能走一格；走进大本营就永远出不来\n" +
        "胜负：扛走对方军旗 / 对方无子可走 / 对方认输\n" +
        "cc军棋 上桌 → cc布阵（随机一版，cc换位 B12 C12 微调）→ 两人布好自动开打\n" +
        FORMAT_HINT + "\n" +
        "另外：cc看阵 重看自己的阵图 / cc认输 / cc结束 清盘"
    );
}

function getJunqiCommand(event, raw_message) {
    const text = String(raw_message || "").trim();
    if (!text) return;
    if (text.includes("规则") || text === "帮助") return rulesCommand(event);
    if (text.includes("结束") || text.includes("清盘")) return endCommand(event);
    if (text.includes("认输") || text.includes("投降")) return resignCommand(event);
    if (text.includes("战报") || text.includes("亮子")) return reportCommand(event);
    if (text.includes("棋盘") || text.includes("盘面") || text.includes("看盘")) return boardCommand(event);
    if (text.includes("状态")) return statusCommand(event);
    if (text.includes("看阵") || text.includes("我的阵") || text.includes("阵图")) return showLayoutCommand(event);
    if (text.includes("换位")) return swapCommand(event, text.replace(/^.*?换位/, "").trim());
    if (text.includes("布阵") || text.includes("摆阵")) return deployCommand(event);
    if (text.includes("军棋") || text.includes("开局") || text.includes("上桌") || text.includes("加入")) return joinCommand(event);

    const body = text.replace(/^走/, "").trim();
    if (parseMove(body)) return moveCommand(event, body);
    const game = gameOf(event);
    if (!game) return event.reply("【军棋】发 cc军棋 上桌，或 cc规则 看玩法。");
    return event.reply("【军棋】没看懂「" + text.slice(0, 20) + "」。" + FORMAT_HINT +
        "\n要上桌发 cc军棋，要摆阵发 cc布阵。");
}

module.exports = { getJunqiCommand, games };
