// 创建游戏命令
const { DouDiZhuGame } = require("../../dou/game");
const gameMap = require("./gameMap");
const { client } = require("../../app");

async function createGameCommand(event) {
    const room = event.group_id;
    // 获取游戏
    let game = gameMap.get(room);
    // 如果游戏已经存在
    if (game) {
        event.reply("游戏已经存在，请加入游戏");
        return;
    }

    // 开局的人也要能收到私聊发牌
    if (!(await client.isFriend(event.sender.user_id))) {
        event.reply("您还不是机器人的好友，收不到私聊发的牌，先加机器人好友再来开局。");
        return;
    }

    // 创建游戏
    gameMap.set(room, new DouDiZhuGame());
    game = gameMap.get(room);
    game.addPlayer(event.sender.user_id, client.displayName(event.sender.user_id));
    event.reply(
        "欢迎来到陈帅泳斗地主，规则同普通斗地主\n" +
        "命令一律用 cc 开头（cc上桌、cc抢、cc334455），@机器人同样有效\n" +
        "第一位玩家发 cc斗地主 开桌，其余人发 cc上桌，满三人自动发牌\n" +
        "牌是私聊发的（要先加机器人为好友），注意查收\n" +
        "发完牌轮流表态：cc抢 / cc不，谁先抢谁当地主，三张底牌归地主，地主先出\n" +
        "B=大王 S=小王 X=10，出牌 cc334455 或 cc出334455，不要就 cc过\n" +
        "随时 cc状态 看轮到谁；cc投降 结束这局；cc胜率榜 看战绩"
    );
}

module.exports = { createGameCommand };
