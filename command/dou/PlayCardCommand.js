// 出牌or跳过命令
const {
    isPlayerInGame,
    showCards,
    getCards,
} = require("./utils");
const fileUtil = require("../../utils/fileUtils");
const gameMap = require("./gameMap");
const {client} = require("../../app");

function playCardCommand(event, raw_message) {
    const room = event.group_id;

    const userId = event.sender.user_id;
    // 获取游戏
    const game = gameMap.get(room);
    // 如果游戏不存在
    if (!game) {
        event.reply("游戏不存在，请创建游戏");
        return;
    }


    // 不在游戏中
    if (!isPlayerInGame(game, userId)) {
        event.reply("您不在游戏中，请先加入游戏");
        return;
    }

    // 游戏不处于出牌阶段
    if (game.status !== 2) {
        event.reply("游戏不处于出牌阶段，不能出牌");
        return;
    }
    const currentPlayer = game.getCurrentPlayer();

    // 未到当前玩家出牌
    if (currentPlayer.id !== userId) {
        event.reply("未到您出牌");
        return;
    }

    // 跳过
    if (
        raw_message.includes("跳过") ||
        raw_message.includes("过") ||
        raw_message.includes("p")
    ) {
        pass(game, event);
        return;
    }
    play(raw_message, game, event, currentPlayer, room, userId);
}

// 跳过逻辑

function pass(game, event) {
    // 获取当前玩家
    const player = game.getCurrentPlayer();
    // 跳过
    game.play([]);
    const showCardsResult = showCards(game);
    // 通知所有玩家
    event.reply(
        player.name +
        "跳过，" +
        game.getCurrentPlayer().name +
        "请出牌\n" +
        showCardsResult
    );
}

//出牌逻辑

function play(raw_message, game, event, player, room, userId) {
    const cards = getCards(raw_message);
    // 判断是否符合规则
    if (game.play(cards)) {
        // 通知所有玩家
        event.reply(player.name + "出牌：" + cards);
        // 判断是否出完牌
        if (game.gameOver) {
            let isLandlordWin = false;
            if (game.winner === "地主") {
                isLandlordWin = true;
            }
            for (let i = 0; i < game.players.length; i++) {
                const player = game.players[i];
                if (player.isLandlord === isLandlordWin) {
                    fileUtil.recordResult(player.id, true);
                } else {
                    fileUtil.recordResult(player.id, false);
                }
            }
            event.reply(
                game.getCurrentPlayer().name +
                "出完牌了，游戏结束，" +
                game.winner +
                "获胜"
            );
            gameMap.delete(room);
            event.reply(
                fileUtil.getWinRate(client.displayName.bind(client)) +
                "\n" +
                "本次斗地主结束" +
                "\n" +
                "请重新开始游戏"
            );
            return;
        }
        // 通知当前玩家剩余的牌
        client.sendTempMsg(room,userId, "您的牌是：" + player.cards.join(",")).then();
        const showCardsResult = showCards(game);
        // 通知下一个玩家出牌
        event.reply(
            game.getCurrentPlayer().name + "请出牌\n" + showCardsResult
        );
    } else {
        event.reply("出牌不符合规则");
    }
}


module.exports = {playCardCommand};
