const { sortCards } = require('./card');
// 玩家类
class Player {
    constructor(id, name) {
        this.id = id; // 玩家ID：发私信、记胜率都用它
        this.name = name || id; // 群里播报用的昵称，wxid 人类读不下去
        this.cards = []; // 玩家手中的牌
        this.isLandlord = false; // 是否是地主
    }

    // 玩家摸牌
    draw(cards) {
        this.cards.push(...cards);
        sortCards(this.cards);
    }

    // 设置为地主
    setLandlord() {
        this.isLandlord = true;
    }

    // 出牌
    play(cards) {
        // 从玩家手中移除出的牌
        for (let i = 0; i < cards.length; i++) {
            const index = this.cards.indexOf(cards[i]);
            this.cards.splice(index, 1);
        }
    }
}

module.exports = {Player};
