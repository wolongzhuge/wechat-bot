// 状态命令：群里最容易卡住的是「现在到底轮到谁、在干什么」
const gameMap = require("./gameMap");
const { isPlayerInGame } = require("./utils");

const PHASE = {
    0: "等人上桌",
    1: "抢地主阶段",
    2: "出牌阶段",
};

function statusCommand(event) {
    const game = gameMap.get(event.group_id);
    if (!game) {
        event.reply("这个群现在没有斗地主，发 cc斗地主 开一局，其他人发 cc上桌");
        return;
    }
    const userId = event.sender.user_id;
    const lines = [];
    let phase = PHASE[game.status] || "未知阶段";
    if (game.status === 0) phase += "（" + game.players.length + "/3）";
    lines.push("【斗地主】" + phase);

    if (game.status === 1) {
        lines.push("牌已发完，还没人抢地主（cc抢 / cc不）");
    }
    if (game.status === 2 && game.landlord) {
        lines.push("地主：" + game.landlord.name + "（底牌 " + game.bottomCards.join(",") + "）");
    }
    const cur = game.getCurrentPlayer();
    lines.push(cur ? "轮到 " + cur.name + (game.status === 1 ? " 表态：cc抢 / cc不" : " 出牌：cc334455 或 cc过") : "没有可轮到的人");
    lines.push(game.players.map((p) => p.name + " " + p.cards.length + "张").join(" / "));
    lines.push("您在局中：" + (isPlayerInGame(game, userId) ? "是" : "不是"));
    event.reply(lines.join("\n"));
}

module.exports = { statusCommand };
