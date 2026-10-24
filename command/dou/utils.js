const { client } = require("../../app");

// 判断是否是正在游戏中的玩家
function isPlayerInGame(game, contact) {
    if (!game) return false;
    return game.players.some((player) => player.id === contact);
}

// 出牌阶段解析牌
function getCards(content) {
    let uppercaseContent = content.toUpperCase();
    uppercaseContent = uppercaseContent.replace(/c/gi, '').replace(/\s+/g, '');
    uppercaseContent = uppercaseContent.replace(/10/g, "X");
    if (uppercaseContent.length === 0) {
        return ("陈帅").split("");
    }
    if (uppercaseContent.includes("出")) {
        return uppercaseContent.split("出")[1].split("");
    } else {
        return uppercaseContent.split("");
    }
}

// 公布每个人剩余牌数
function showCards(game) {
    const players = game.players;
    let result = "";
    for (let i = 0; i < players.length; i++) {
        const player = players[i];
        if (player === game.landlord) {
            result += player.name + "(地主)剩余牌数：" + player.cards.length + "\n";
        } else {
            result += player.name + "剩余牌数：" + player.cards.length + "\n";
        }
    }
    return result;
}

// 三个人手牌私聊发出（iPad 协议没有临时会话，上桌前已验过好友）
function sendHands(game, room) {
    for (const player of game.players) {
        client.sendTempMsg(room, player.id, "您的牌是：" + player.cards.join(",")).then();
    }
}

// 满三人发完牌后的群公告：谁先抢谁当地主
function startRobText(game) {
    const cur = game.getCurrentPlayer();
    return "发牌完毕，" + cur.name + " 先表态抢地主。\n" +
        "cc抢 抢地主 / cc不 不抢（谁先抢谁当地主，三张底牌归地主）";
}

module.exports = {
    isPlayerInGame,
    getCards,
    showCards,
    sendHands,
    startRobText,
};
