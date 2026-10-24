"use strict";
// 象棋：两个人、群里 cc 走子，每手把盘面画成图片发群。
// 两套写法都认：坐标（cc21 33 = 2列1行→3列3行，解析在 coord.js）和官方记谱（cc马五进六）。
const { client } = require("../../app");
const { XiangqiGame, SIDE_NAME } = require("./game");
const { parseCoordMove, fmt, EXAMPLE } = require("./coord");
const { renderImage, renderText } = require("./render");

// room -> XiangqiGame（牌桌钉在 state/store.js，热重载不丢局）
const games = require("../../state/store").gameMaps.xiangqi;

// 带 进/退/平 又有棋子名 —— 官方记谱；否则按坐标解析
const isNotation = (text) => /[进退平]/.test(text) && /[车马炮兵卒相象仕士帅将]/.test(text);

// 图片发不出去就退回文本盘面，别让人对着空气下棋
function postBoard(event, game) {
    let b64 = null;
    try {
        b64 = renderImage(game);
    } catch (err) {
        console.error("象棋盘面渲染失败: " + err.message);
    }
    if (!b64) return event.reply(renderText(game));
    return event.reply({ image: b64 }).catch((err) => {
        console.error("象棋盘面图片发送失败，改发文本: " + err.message);
        return event.reply(renderText(game));
    });
}

function startCommand(event) {
    const room = event.group_id;
    const userId = event.sender.user_id;
    const name = client.displayName(userId);

    let game = games.get(room);
    if (game && game.winner) game = null;
    if (!game) {
        game = new XiangqiGame();
        games.set(room, game);
    }
    const added = game.addPlayer(userId, name);
    if (!added.ok) return event.reply("【象棋】" + added.reason);

    if (game.players.length < 2) {
        return event.reply(
            game.statusText() +
            "\n规则：9×10 棋盘，吃掉对方帅/将或将其将死为胜。\n" +
            "等人时可以先发 cc规则 看玩法。"
        );
    }
    game.start(true);
    const red = game.playerBySide("r"), black = game.playerBySide("b");
    return event.reply(
        "【象棋】开局！随机定红黑：" + red.name + "（红） 对 " + black.name + "（黑）\n" +
        "红先走。走子写坐标就行：" + EXAMPLE + "\n" +
        "官方记谱照样能用：cc马五进六 / cc炮二平五 / cc前马进三\n" +
        "随时 cc棋盘 看盘面，撑不住就 cc认输。"
    ).then(() => postBoard(event, game));
}

function moveCommand(event, raw) {
    const room = event.group_id;
    const game = games.get(room);
    if (!game) return event.reply("【象棋】这里还没有棋局，发 cc象棋 开一局（两个人就能玩）。");

    const userId = event.sender.user_id;
    let res;
    if (isNotation(raw)) {
        res = game.tryMove(userId, raw);
    } else {
        const got = parseCoordMove(raw);
        res = got.bad
            ? { ok: false, hint: got.bad + "\n官方记谱也认：cc马五进六 / cc炮二平五 / cc前马进三" }
            : game.tryMoveCoord(userId, got.from, got.to, got.piece);
    }
    if (!res.ok) return event.reply("【象棋】这步不走：" + res.hint + "\n" + game.statusText());

    const last = game.moves[game.moves.length - 1];
    const mover = game.playerById(userId);
    const sideName = SIDE_NAME[last.side];
    // 记谱和坐标同时念出来：用坐标的人顺便学会记谱，反过来也一样
    let text = "【象棋】" + sideName + " " + res.notation + "（" + fmt(res.from) + "→" + fmt(res.to) + "）" +
        (res.captured ? "，吃了" + res.captured : "");
    if (res.over) {
        const winName = { 将死: "将死（绝杀）", 困毙: "无子可动（困毙）", 吃将: "吃掉对方的帅/将" }[res.winBy] || res.winBy;
        text += "\n" + winName + "！" + mover.name + "（" + sideName + "）获胜，共 " + game.moves.length + " 手\n" +
            "发 cc象棋 立刻再来一局，或 cc结束 清盘。";
        return event.reply(text).then(() => postBoard(event, game));
    }
    if (res.check) text += " —— 将军！";
    text += "\n" + game.statusText();
    return event.reply(text).then(() => postBoard(event, game));
}

function boardCommand(event) {
    const room = event.group_id;
    const game = games.get(room);
    if (!game) return event.reply("【象棋】这里没有棋局，发 cc象棋 开一局。");
    return event.reply(game.statusText()).then(() => postBoard(event, game));
}

function resignCommand(event) {
    const room = event.group_id;
    const game = games.get(room);
    if (!game) return event.reply("【象棋】这里没有棋局。");
    const res = game.resign(event.sender.user_id);
    if (!res.ok) return event.reply("【象棋】" + res.hint);
    return event.reply(
        "【象棋】" + res.player.name + " 认输，" + res.other.name + " 获胜（共 " + game.moves.length + " 手）\n" +
        "发 cc象棋 再来一局。"
    ).then(() => postBoard(event, game));
}

function endCommand(event) {
    const room = event.group_id;
    if (!games.has(room)) return event.reply("【象棋】这里没有棋局。");
    const game = games.get(room);
    const summary = game.moves.length + " 手，" + game.players.map((p) => p.name).join("、");
    games.delete(room);
    return event.reply("【象棋】已清盘（" + summary + "）。开新局发 cc象棋。");
}

function rulesCommand(event) {
    return event.reply(
        "【象棋规则】红先黑后，把对方帅/将 将死 或 吃掉 为胜\n" +
        "cc象棋 开局（两人各发一次，随机定红黑，红先走）\n" +
        "\n" +
        "〔写法一 · 坐标，推荐〕前列后行，都从你自己这边数：\n" +
        "cc21 33 = 从 2 列 1 行 走到 3 列 3 行\n" +
        "　列从你右手边数第 1 列，行从你底线数第 1 行（盘面上你那一侧的同色数字）\n" +
        "　分隔符随意：cc21 33 / cc21,33 / cc21、33 都一样\n" +
        "　中文数字也认：cc二一三三；第 10 行怕撞车就全分开：cc2,10,3,3\n" +
        "　想指定棋子可以加在前面：cc马21 33（位置写错会告诉你那儿是什么）\n" +
        "〔写法二 · 官方记谱〕\n" +
        "cc马五进六 / cc炮二平五 / cc车一进一 / cc兵七进一\n" +
        "　进=向前 退=向后 平=横走；马/相/仕 后一个数字是落点列号，车/炮/兵 是步数\n" +
        "　同一列有两枚同种棋子要写 前/后：cc前马进三\n" +
        "\n" +
        "帅将不出九宫；仕士斜走九宫内；相象田字不过河；马走日（蹩腿不能走）；\n" +
        "车走直线；炮隔一个子才能吃；兵卒只进不退，过河才能横走\n" +
        "cc棋盘 看盘面 / cc认输 认负 / cc结束 清盘\n" +
        "盘面固定红下黑上：红方读下面+右边的数字，黑方读上面+左边的数字。"
    );
}

function getXiangqiCommand(event, raw_message) {
    const text = String(raw_message || "").trim();
    if (!text) return;
    if (text.includes("规则") || text === "帮助") return rulesCommand(event);
    if (text.includes("结束") || text.includes("清盘")) return endCommand(event);
    if (text.includes("认输") || text.includes("输了")) return resignCommand(event);
    if (text.includes("棋盘") || text.includes("盘面") || text.includes("看盘") || text.includes("状态")) return boardCommand(event);
    if (text.includes("象棋") || text.includes("开局") || text.includes("加入") || text.includes("上桌")) return startCommand(event);
    const game = games.get(event.group_id);
    if (!game) return event.reply("【象棋】发 cc象棋 开局，或 cc规则 看玩法。");
    return moveCommand(event, text);
}

module.exports = { getXiangqiCommand, games };
