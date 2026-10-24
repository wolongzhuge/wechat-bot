"use strict";
// UNO 引擎：108 张牌、2-4 人、颜色/数字匹配出牌、跳过/反转/+2/万能/+4、摸牌、胜负。
// 玩家数组顺序即顺时针，direction=1 顺 / -1 逆；两人局反转等于跳过。

const COLORS = ["红", "黄", "蓝", "绿"];
const NUMBER_VALUES = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
const ACTION_VALUES = ["跳过", "反转", "+2"];

function makeDeck() {
    const deck = [];
    for (const color of COLORS) {
        deck.push({ color, value: "0" });
        for (const v of NUMBER_VALUES.slice(1).concat(ACTION_VALUES)) {
            deck.push({ color, value: v }, { color, value: v });
        }
    }
    for (let i = 0; i < 4; i++) deck.push({ color: null, value: "万能" });
    for (let i = 0; i < 4; i++) deck.push({ color: null, value: "+4" });
    return deck;
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function cardText(card) {
    return card.color ? card.color + card.value : card.value;
}

// "出红5" / "红5" / "5" / "跳过" / "万能 蓝" / "蓝万能" / "+4 红" / "加2" → {color?, value, chosenColor?}
function parseCard(text) {
    let t = String(text || "").trim().replace(/^出/, "").replace(/\s+/g, "");
    t = t.replace(/加2/g, "+2").replace(/加4/g, "+4");
    let m = t.match(/^(万能|\+4)(红|黄|蓝|绿)$/);
    if (m) return { color: null, value: m[1], chosenColor: m[2] };
    m = t.match(/^(红|黄|蓝|绿)(万能|\+4)$/);
    if (m) return { color: null, value: m[2], chosenColor: m[1] };
    m = t.match(/^(红|黄|蓝|绿)?(0|[1-9]|跳过|反转|\+2)$/);
    if (m) return { color: m[1] || null, value: m[2], chosenColor: null };
    return null;
}

class UnoGame {
    constructor() {
        this.players = [];        // {id, name, hand: []}
        this.host = null;         // 房主，开局前只有房主能 cc开始
        this.started = false;
        this.gameOver = false;
        this.winner = null;
        this.deck = [];
        this.discard = [];
        this.currentColor = null;
        this.direction = 1;
        this.currentIndex = 0;
        this.pendingDraw = null;  // 当前玩家摸到且能出的那张牌
        this.turns = 0;           // 有效手数（出牌/过/摸都算）
    }

    addPlayer(id, name) {
        if (this.started) return { ok: false, reason: "已经开局了，不能再上桌" };
        if (this.players.length >= 4) return { ok: false, reason: "4 个人已经满了" };
        if (this.players.some((p) => p.id === id)) return { ok: false, reason: "你已经在桌上了" };
        this.players.push({ id, name, hand: [] });
        if (!this.host) this.host = id;
        return { ok: true };
    }

    removePlayer(id) {
        if (this.started) return { ok: false, reason: "开局了不能退桌，认负请 cc投降" };
        const i = this.players.findIndex((p) => p.id === id);
        if (i < 0) return { ok: false, reason: "你不在桌上" };
        this.players.splice(i, 1);
        if (this.host === id) this.host = this.players.length ? this.players[0].id : null;
        return { ok: true };
    }

    top() { return this.discard[this.discard.length - 1]; }

    boardText() {
        const top = this.top();
        return cardText(top) + (top.color ? "" : "（当前颜色：" + this.currentColor + "）");
    }

    countsText() {
        return this.players.map((p) => p.name + " " + p.hand.length + "张").join(" / ");
    }

    start(hostId) {
        if (this.started) return { ok: false, reason: "已经开局了" };
        if (hostId !== this.host) return { ok: false, reason: "只有房主能说开始（房主：" + this._hostName() + "）" };
        if (this.players.length < 2) return { ok: false, reason: "至少 2 个人才能开（最多 4 人），再拉人发 ccuno 上桌" };
        this.deck = shuffle(makeDeck());
        for (const p of this.players) p.hand = this.deck.splice(0, 7);
        while (true) {
            const c = this.deck.pop();
            if (c.color && NUMBER_VALUES.includes(c.value)) { this.discard.push(c); break; }
            this.deck.unshift(c); // 功能牌埋回牌堆底（pop 从尾部取，unshift 塞到头部=底部），第一张必须亮数字牌
        }
        this.currentColor = this.top().color;
        this.direction = 1;
        this.currentIndex = this.players.findIndex((p) => p.id === hostId);
        this.turns = 0;
        this.started = true;
        return { ok: true };
    }

    _hostName() {
        const h = this.players.find((p) => p.id === this.host);
        return h ? h.name : "?";
    }

    _advance(n) {
        const len = this.players.length;
        this.currentIndex = (((this.currentIndex + this.direction * n) % len) + len) % len;
    }

    _nextPlayer(n) {
        const len = this.players.length;
        const idx = (((this.currentIndex + this.direction * n) % len) + len) % len;
        return this.players[idx];
    }

    _drawN(player, n) {
        const drawn = [];
        for (let i = 0; i < n; i++) {
            if (!this.deck.length) {
                if (this.discard.length <= 1) break; // 只剩牌面那张，无牌可补
                const top = this.discard.pop();
                this.deck = shuffle(this.discard);
                this.discard = [top];
            }
            const c = this.deck.pop();
            player.hand.push(c);
            drawn.push(c);
        }
        return drawn;
    }

    _canPlay(card) {
        const top = this.top();
        if (!card.color) return true; // 万能 / +4 随时能出
        return card.color === this.currentColor || card.value === top.value;
    }

    _findCard(player, parsed) {
        for (let i = 0; i < player.hand.length; i++) {
            const c = player.hand[i];
            if (c.value !== parsed.value) continue;
            if (!c.color) return i;
            if (c.color === (parsed.color || this.currentColor)) return i;
        }
        return -1;
    }

    // 出牌：text 如 "红5" / "跳过" / "万能 蓝" / "+4 红"（不带颜色 = 当前牌面颜色）
    tryPlay(playerId, text) {
        if (!this.started) return { ok: false, hint: "还没开局，房主发 cc开始 才开打" };
        if (this.gameOver) return { ok: false, hint: "已经打完了，cc结束 清桌再开" };
        const player = this.players.find((p) => p.id === playerId);
        if (!player) return { ok: false, hint: "你不在桌上" };
        if (this.players[this.currentIndex].id !== playerId) {
            return { ok: false, hint: "还没轮到你，现在是 " + this.players[this.currentIndex].name + " 出牌" };
        }
        const parsed = parseCard(text);
        if (!parsed) {
            return { ok: false, hint: "没看懂「" + String(text).slice(0, 20) + "」。格式：cc出红5 / cc出跳过 / cc出+2 / cc万能 蓝 / cc出+4 红" };
        }
        const idx = this._findCard(player, parsed);
        if (idx < 0) return { ok: false, hint: "你手里没有这张牌（不带颜色就是当前牌面颜色）" };
        if (this.pendingDraw) {
            const pd = this.pendingDraw;
            const same = pd.value === parsed.value &&
                (!pd.color || pd.color === (parsed.color || this.currentColor));
            if (!same) return { ok: false, hint: "你刚摸到 " + cardText(pd) + "，这回合只能出它，不想出就 cc过" };
        }
        const card = player.hand[idx];
        if (!this._canPlay(card)) {
            return { ok: false, hint: "对不上牌面：" + this.boardText() + "，要同色或同数字" };
        }
        if (!card.color && !parsed.chosenColor) {
            return { ok: false, hint: "万能要选个颜色，如 cc万能 蓝 / cc出+4 红" };
        }

        player.hand.splice(idx, 1);
        this.discard.push(card);
        this.currentColor = card.color ? card.color : parsed.chosenColor;
        this.pendingDraw = null;
        this.turns++;

        const effects = [];
        if (card.value === "万能") {
            effects.push("颜色变" + parsed.chosenColor);
            this._advance(1);
        } else if (card.value === "+4") {
            const next = this._nextPlayer(1);
            this._drawN(next, 4);
            effects.push(next.name + " 摸 4 张并被跳过，颜色变" + parsed.chosenColor);
            this._advance(2);
        } else if (card.value === "跳过") {
            const next = this._nextPlayer(1);
            effects.push("跳过 " + next.name);
            this._advance(2);
        } else if (card.value === "反转") {
            this.direction = -this.direction;
            effects.push("出牌方向反转（" + (this.direction === 1 ? "顺时针" : "逆时针") + "）");
            this._advance(this.players.length === 2 ? 2 : 1); // 两人局反转 = 跳过
        } else if (card.value === "+2") {
            const next = this._nextPlayer(1);
            this._drawN(next, 2);
            effects.push(next.name + " 摸 2 张并被跳过");
            this._advance(2);
        } else {
            this._advance(1);
        }

        if (!player.hand.length) {
            this.gameOver = true;
            this.winner = player;
        }
        return {
            ok: true,
            player: player.name,
            played: cardText(card),
            chosen: parsed.chosenColor,
            board: this.boardText(),
            effects: effects.join("；"),
            uno: player.hand.length === 1,
            next: this.players[this.currentIndex].name,
            counts: this.countsText(),
            over: this.gameOver,
            winner: this.winner,
        };
    }

    // 过：摸到待定的牌就留着过，没摸也直接过
    tryPass(playerId) {
        if (!this.started) return { ok: false, hint: "还没开局" };
        if (this.gameOver) return { ok: false, hint: "已经打完了" };
        if (this.players[this.currentIndex].id !== playerId) {
            return { ok: false, hint: "还没轮到你" };
        }
        this.pendingDraw = null;
        this.turns++;
        this._advance(1);
        return {
            ok: true,
            next: this.players[this.currentIndex].name,
            counts: this.countsText(),
        };
    }

    // 摸一张：能出就 pendingDraw 等你决定出不出，不能出自动过
    tryDraw(playerId) {
        if (!this.started) return { ok: false, hint: "还没开局" };
        if (this.gameOver) return { ok: false, hint: "已经打完了" };
        const player = this.players.find((p) => p.id === playerId);
        if (!player) return { ok: false, hint: "你不在桌上" };
        if (this.players[this.currentIndex].id !== playerId) {
            return { ok: false, hint: "还没轮到你" };
        }
        if (this.pendingDraw) {
            return { ok: false, hint: "你已经摸过 " + cardText(this.pendingDraw) + " 了，能出就 cc出" +
                cardText(this.pendingDraw) + (this.pendingDraw.color ? "" : " 颜色") + "，不想出就 cc过" };
        }
        const card = this._drawN(player, 1)[0];
        if (!card) return { ok: false, hint: "没牌可摸了" };
        if (this._canPlay(card)) {
            this.pendingDraw = card;
            return {
                ok: true,
                player: player.name,
                drew: cardText(card),
                playable: true,
                hint: "要打就 cc出" + cardText(card) + (card.color ? "" : " 颜色") + "，留着就 cc过",
            };
        }
        this.turns++;
        this._advance(1);
        return {
            ok: true,
            player: player.name,
            drew: cardText(card),
            playable: false,
            autoPass: true,
            next: this.players[this.currentIndex].name,
            counts: this.countsText(),
        };
    }

    // 认负离场：手牌塞回牌堆底，牌局继续；只剩一个人就算赢
    surrender(playerId) {
        if (!this.started) return { ok: false, reason: "还没开局，不想玩直接 cc退出 下桌" };
        if (this.gameOver) return { ok: false, reason: "已经打完了" };
        const i = this.players.findIndex((p) => p.id === playerId);
        if (i < 0) return { ok: false, reason: "你不在桌上" };
        const p = this.players[i];
        const wasCurrent = i === this.currentIndex;
        this.deck.push(...p.hand);
        this.pendingDraw = null;
        this.players.splice(i, 1);
        if (this.players.length <= 1) {
            this.gameOver = true;
            this.winner = this.players[0];
            return { ok: true, dropped: p.name, over: true, winner: this.winner };
        }
        if (this.currentIndex > i) this.currentIndex--;
        else if (wasCurrent) {
            // 轮到的人走了：按当前方向把出牌权交给他的下一位
            const len = this.players.length;
            this.currentIndex = (((i + (this.direction === 1 ? 0 : -1)) % len) + len) % len;
        }
        return {
            ok: true,
            dropped: p.name,
            over: false,
            next: this.players[this.currentIndex].name,
            counts: this.countsText(),
        };
    }

    statusText(userId) {
        if (!this.started) {
            const host = this.players.find((p) => p.id === this.host);
            return "【UNO】等人上桌（" + this.players.length + "/4）\n" +
                "房主：" + (host ? host.name : "无") + "（房主发 cc开始 开局，2-4 人都能开）\n" +
                "桌上：" + (this.players.map((p) => p.name).join("、") || "没人") + "\n" +
                "ccuno 上桌 / cc退出 下桌 / cc结束 散桌";
        }
        if (this.gameOver) {
            const w = this.winner;
            return "【UNO】" + (w ? w.name : "?") + " 获胜！\n各家剩余：" + this.countsText() +
                "\ncc结束 清桌，或 ccuno 再开新桌";
        }
        const cur = this.players[this.currentIndex];
        const dir = this.direction === 1 ? "顺时针" : "逆时针";
        return "【UNO】第 " + (this.turns + 1) + " 手\n" +
            "轮到 " + cur.name + "（" + cur.hand.length + "张）出牌\n" +
            "牌面：" + this.boardText() + "，方向：" + dir + "\n" +
            "各家：" + this.countsText() + "\n" +
            "您在局中：" + (this.players.some((p) => p.id === userId) ? "是" : "不是");
    }
}

module.exports = { UnoGame, makeDeck, parseCard, cardText, COLORS, NUMBER_VALUES };
