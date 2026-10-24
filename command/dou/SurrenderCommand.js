// 投降命令
const fileUtil = require("../../utils/fileUtils");
const {client} = require("../../app");
const {isPlayerInGame} = require("./utils");
const gameMap = require("./gameMap");

function surrenderCommand(event) {
    const room = event.group_id;
    const userId = event.sender.user_id;
    // 获取游戏
    const game = gameMap.get(room);
    // 如果游戏不存在
    if (!game) {
        event.reply("游戏不存在，无法投降");
        return;
    }

    // 不在游戏中
    if (!isPlayerInGame(game, userId)) {
        event.reply("您不在游戏中，无法投降");
        return;
    }

    // 游戏不处于出牌阶段
    if (game.status !== 2) {
        event.reply("游戏不处于出牌阶段，无法投降");
        return;
    }

    // 获取当前玩家
    let player = game.getCurrentPlayer();
    //修复投降bug
    for (let i = 0; i < game.players.length; i++) {
        if (game.players[i].id === userId) {
            player = game.players[i];
        }
    }

    // 投降
    let isLandlordWin = false;
    if (!player.isLandlord) {
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
    event.reply(player.name + "投降，游戏结束");
    event.reply(fileUtil.getWinRate(client.displayName.bind(client)));
    gameMap.delete(room);
}


module.exports = {surrenderCommand};
