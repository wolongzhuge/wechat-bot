"use strict";
// 麻将状态机：4 家（真人 + 机器人补满）、摸打、副露声明、和牌结算、流局、轮庄。
//
// 关键设计：微信里人是异步的，所以引擎不靠定时器，而是「一路跑到需要人输入为止」。
// 每个对外方法都返回一组事件（events），命令层负责把事件写成群消息和盘面图。
// 机器人家在同一次调用里连续行动，人类家停下等 cc 命令；声明窗口优先于摸牌，
// 因为「能不能碰/和」必须在别人打牌的瞬间问完。
//
// 记账只有一种形状：transfers[{from,to,amount,why}]。任何会动分数的地方都走 _apply，
// 不要在某些分支里再手动给赢家加一次分（钱会凭空多出来）。

const T = require("./tiles");
const H = require("./hand");
const AI = require("./ai");
const Rules = require("./rules");

const WINDS = [27, 28, 29, 30];          // 東 南 西 北（index 即座位相对场风）
const BOT_NAMES = ["机器人甲", "机器人乙", "机器人丙", "机器人丁"];

// 和牌时判断待牌形状（日麻算符要用）：只看和牌张在门前 13 张里的位置
function guessWaitShape(counts13, winTile) {
    if (!T.isNum(winTile)) return counts13[winTile] >= 2 ? "shanpon" : "tanki";
    if (counts13[winTile] >= 2) return "shanpon";
    if (counts13[winTile] >= 1) return "tanki";
    const suit = T.suitOf(winTile);
    const base = { m: 0, p: 9, s: 18 }[suit];
    const rank = winTile - base;                       // 0..8
    const left = winTile - 1 >= base ? counts13[winTile - 1] : 0;
    const right = winTile + 1 < base + 9 ? counts13[winTile + 1] : 0;
    if (rank === 2 && left && counts13[winTile - 2]) return "penchan";   // 12 等 3
    if (rank === 6 && right && counts13[winTile + 2]) return "penchan";  // 89 等 7
    if (left && right) return "ryanmen";
    if (left || right) return "ryanmen";
    return "kanchan";
}

function newSeatPlayer(userId, name, bot) {
    return {
        id: userId, name: name, bot: !!bot,
        hand: [], melds: [], river: [],
        score: 0, riichi: false, ippatsu: false, out: false,
        queSuit: null, winInfo: null,
    };
}

class MahjongGame {
    constructor(opts) {
        const options = opts || {};
        this.modeId = options.modeId || Rules.DEFAULT_MODE;
        this.mode = Rules.get(this.modeId);
        this.room = options.room || "";
        this.rng = options.rng || null;
        this.base = options.base || this.mode.base || 1;
        this.startScore = options.startScore === undefined ? (this.mode.riichi ? 10000 : 0) : options.startScore;
        this.phantomTiles = 0;      // 一炮多响时同一张牌要出现在两家手里，牌数守恒检查用
        this.fanCap = options.fanCap === undefined ? (this.mode.fanCap === undefined ? 3 : this.mode.fanCap) : options.fanCap;
        // 离线自打测试要允许四家全是机器人，真人上桌的命令层不允许
        this.allowBotsOnly = options.allowBotsOnly === true;
        // 线上桌子要随机坐、随机坐庄；测试桌默认固定 0 号位+东家，复盘才好对
        this.shuffleSeats = options.shuffleSeats === true;

        this.seats = [];            // 长度 4 的座位数组
        this.wall = [];             // 还能摸的牌（从头摸，岭上从尾摸）
        this.dead = [];             // 牌尾：宝牌指示牌从这里翻
        this.doraIndicators = [];
        this.uraIndicators = [];
        this.flipIndex = 0;
        this.turn = 0;
        this.dealerSeat = 0;
        this.roundDealer = 0;       // 本局开打时的庄家（结算时 dealerSeat 已经轮走了）
        this.roundWind = 0;         // 0=东风场（往后再扩南场）
        this.honba = 0;
        this.riichiSticks = 0;
        this.kanCount = 0;
        this.roundNumber = 1;
        this.turnNumber = 0;        // 本局第几个「摸牌」回合（判天胡/地和）
        this.discardsInRound = 0;   // 本局已打出的牌数（判一发/人和/地和）
        this.lastGangSeat = null;   // 最近杠成的那家（杠上炮要用）
        this.phase = "lobby";       // lobby | que | discard | claim | round-over
        this.claim = null;          // 声明窗口 {tile, from, offers, answers}
        this.lastDiscard = null;    // {seat, id}
        this.drawn = null;          // 当前家刚摸的牌（tile 对象）
        this.tail = [];             // 战报（供 cc战报）
        this.players = {};          // userId -> seat
        // 一炮多响时同一枚牌对象会进两家手里，claimedObjs 用来认出「第二次」并记成虚牌。
        // 开局前也可能被直接调用（测试/复盘），所以这里也要有初值。
        this.claimedObjs = new Set();
        // 同巡振听：能荣和却放过了的那几张，自己下次摸牌才清空
        this.tempFuriten = [[], [], [], []];
    }

    // ---------- 上桌 ----------
    // 随机数：注入了 rng 就用它（离线重放可复现），没注入走 Math.random
    _randInt(n) {
        const r = this.rng ? this.rng() : Math.random();
        return Math.min(n - 1, Math.max(0, Math.floor(r * n)));
    }

    addPlayer(userId, name) {
        if (this.phase !== "lobby") return { ok: false, reason: "这局已经开始了，发 cc结束 散桌再重开" };
        if (this.players[userId] !== undefined) {
            return { ok: false, reason: "你已经在这桌上了（第 " + (this.players[userId] + 1) + " 家）" };
        }
        if (this.humans().length >= Rules.SEATS) return { ok: false, reason: "四个位子都坐满了" };
        const free = [];
        for (let i = 0; i < Rules.SEATS; i++) {
            const exist = this.seats[i];
            if (!exist || exist.bot) free.push(i);      // 机器人占的位子可以顶掉
        }
        const seat = this.shuffleSeats ? free[this._randInt(free.length)] : free[0];
        const score = this.seats[seat] ? this.seats[seat].score : 0;
        this.seats[seat] = newSeatPlayer(userId, name || "玩家", false);
        this.seats[seat].score = score;
        this.players[userId] = seat;
        return { ok: true, seat };
    }

    // 空位用机器人补满，保证一定开得了局
    fillBots() {
        while (this.seats.length < Rules.SEATS) this.seats.push(null);
        for (let i = 0; i < Rules.SEATS; i++) {
            if (this.seats[i]) continue;
            this.seats[i] = newSeatPlayer("bot" + i, BOT_NAMES[i], true);
        }
    }

    humans() {
        return this.seats.filter((s) => s && !s.bot);
    }

    seatOf(userId) {
        return this.players[userId];
    }

    // ---------- 开局 ----------
    start() {
        this.fillBots();
        if (this.humans().length === 0 && !this.allowBotsOnly) return [{ type: "info", text: "没人上桌，开不了局" }];
        if (!this._started) {
            this._started = true;
            for (const s of this.seats) s.score = this.startScore;
        }
        return this._dealRound();
    }

    // 流局/和牌之后开下一局（牌风、庄家都已经轮到位了）
    nextRound() {
        if (this.phase !== "round-over") return [{ type: "info", text: "这一局还没打完，先打完再开下一局" }];
        this.roundNumber++;
        return this._dealRound();
    }

    _dealRound() {
        this.mode = Rules.get(this.modeId);
        this.base = this.mode.base || 1;
        if (this.fanCap === undefined || this.fanCap === null) this.fanCap = this.mode.fanCap === undefined ? 3 : this.fanCap;
        const full = Rules.buildWall(this.mode, this.rng);
        const deadCount = Math.min(this.mode.deadWall || 0, full.length - 13 * Rules.SEATS - 1);
        this.dead = deadCount > 1 ? full.slice(full.length - deadCount) : [];
        this.wall = deadCount > 1 ? full.slice(0, full.length - deadCount) : full;
        // 宝牌区始终整块留着（渲染要画指示牌），翻开了几张用 flipIndex 表示
        this.flipIndex = this.dead.length >= 2 ? 2 : 0;
        this._openIndicators();
        // 本局开打时的庄家：结算那一刻 dealerSeat 已经轮给下局了，盘面上的风位得按这局的来
        this.roundDealer = this.dealerSeat;

        for (const s of this.seats) {
            s.hand = [];
            s.melds = [];
            s.river = [];
            s.riichi = false;
            s.ippatsu = false;
            s.out = false;
            s.queSuit = null;
            s.winInfo = null;
        }
        this.kanCount = 0;
        this.turnNumber = 0;
        this.discardsInRound = 0;
        this.lastGangSeat = null;
        this.phantomTiles = 0;
        this.claimedObjs = new Set();
        this.tempFuriten = [[], [], [], []];
        this.claim = null;
        this.lastDiscard = null;
        this.drawn = null;

        for (let i = 0; i < 13; i++) {
            for (let s = 0; s < Rules.SEATS; s++) this.seats[s].hand.push(this.wall.shift());
        }
        this._sortHands();

        const events = [{ type: "deal", round: this.roundNumber, dealer: this.dealerSeat, wall: this.wall.length }];
        if (this.mode.que) {
            this.phase = "que";
            for (let s = 0; s < Rules.SEATS; s++) {
                if (this.seats[s].bot) this.seats[s].queSuit = AI.chooseQue(this.concealedIds(s));
            }
            // 全是机器人时不用等命令，直接开打
            if (this.seats.every((x) => x.queSuit)) {
                events.push({ type: "que-all" });
                return events.concat(this._beginTurn(this.dealerSeat));
            }
            events.push({ type: "need-que", seats: this.seats.map((x, i) => ({ seat: i, bot: x.bot, done: !!x.queSuit })) });
            return events;
        }
        return events.concat(this._beginTurn(this.dealerSeat));
    }

    // 手牌是 {id, red} 对象，排序必须排对象本身：按 id 找回来会把同一张牌的
    // 赤牌标记弄丢（4 张同种牌 find 永远回捞到第一张）。
    _sortHands() {
        for (const s of this.seats) {
            if (!s) continue;
            s.hand = s.hand.slice().sort((a, b) => this.idOf(a) - this.idOf(b));
        }
    }

    // ---------- 牌的读写 ----------
    idOf(tile) {
        return tile == null ? null : (typeof tile === "number" ? tile : tile.id);
    }

    concealedIds(seat) {
        return this.seats[seat].hand.map((t) => this.idOf(t));
    }

    counts(seat) {
        return T.countsOf(this.concealedIds(seat));
    }

    riverIds(seat) {
        return this.seats[seat].river.map((t) => this.idOf(t));
    }

    // 牌河里 + 亮出来的副露，算余量和危险度用（暗杠扣着不算看见）
    visibleCounts(seat) {
        const c = T.emptyCounts();
        for (let s = 0; s < Rules.SEATS; s++) {
            if (s === seat) continue;
            for (const id of this.riverIds(s)) c[id]++;
            for (const m of this.seats[s].melds) {
                if (m.concealed) continue;
                for (const t of m.tiles) c[this.idOf(t)]++;
            }
        }
        return c;
    }

    liveSeats() {
        const out = [];
        for (let i = 0; i < this.seats.length; i++) if (!this.seats[i].out) out.push(i);
        return out;
    }

    // 下一家：跳过已经和牌离桌的（血战打完的人不再摸打）
    nextSeat(from) {
        for (let step = 1; step <= Rules.SEATS; step++) {
            const s = (from + step) % Rules.SEATS;
            if (!this.seats[s].out) return s;
        }
        return null;
    }

    // ---------- 回合 ----------
    _beginTurn(seat) {
        if (this.wall.length === 0) return this._endRound("draw");
        if (this.kanCount >= 4 && this.mode.abortive) {
            const abort = this.mode.abortive({ fourKansNoWall: this.wall.length <= 4 });
            if (abort.yes) return this._endRound("abortive", abort.by);
        }
        this.turn = seat;
        this.turnNumber++;
        // 一发只到自己下一次摸牌为止
        this.seats[seat].ippatsu = false;
        this.tempFuriten[seat] = [];
        const tile = this.wall.shift();
        this.drawn = tile;
        this.seats[seat].hand.push(tile);
        const events = [{ type: "draw", seat, tile: this.idOf(tile), red: !!tile.red }];

        if (this.seats[seat].bot) return events.concat(this._botAfterDraw(seat));
        this.phase = "discard";
        events.push({ type: "need-discard", seat, options: this.optionsFor(seat) });
        return events;
    }

    // 摸完牌后这家能不能直接和（自摸）
    canTsumo(seat) {
        const s = this.seats[seat];
        if (s.out || !this.drawn) return null;
        if (this.mode.que && !this.queCleared(seat)) return null;
        const res = this.mode.score(this._winCtx(seat, { tile: this.idOf(this.drawn), selfDrawn: true }));
        return res.ok ? res : null;
    }

    queCleared(seat) {
        const suit = this.seats[seat].queSuit;
        if (!suit) return true;
        return this.concealedIds(seat).every((id) => T.suitOf(id) !== suit);
    }

    // 手里能暗杠的牌（4 张同种；立直后不能杠，会破坏待牌）
    ankanTiles(seat) {
        const out = [];
        if (this.seats[seat].riichi) return out;
        const c = this.counts(seat);
        for (let id = 0; id < 34; id++) if (c[id] === 4) out.push(id);
        return out;
    }

    // 能补杠的牌：碰过之后自己摸到第 4 张
    addKanTiles(seat) {
        const out = [];
        if (this.seats[seat].riichi) return out;
        const c = this.counts(seat);
        for (const m of this.seats[seat].melds) {
            if (m.type !== "pon") continue;
            const id = this.idOf(m.tiles[0]);
            if (c[id] >= 1) out.push(id);
        }
        return out;
    }

    // 给人类家列出「现在能做什么」，回执里全念出来，省得猜命令
    optionsFor(seat) {
        const s = this.seats[seat];
        const opts = { tsumo: null, ankan: [], addKan: [], waits: [], mustDiscardFromDrawn: !!s.riichi };
        if (this.phase !== "discard" || this.turn !== seat) return opts;
        const res = this.canTsumo(seat);
        if (res) opts.tsumo = res;
        if (s.riichi) return opts;      // 立直后只能摸切/自摸，别的都不给
        opts.ankan = this.ankanTiles(seat);
        opts.addKan = this.addKanTiles(seat);
        const counts13 = this.counts(seat);
        for (let i = 0; i < 34; i++) {
            if (counts13[i] <= 0) continue;
            const next = counts13.slice();
            next[i]--;
            const w = H.waits(next, {
                melds: s.melds.length,
                chiitoi: true,
                kokushi: this.mode.id !== "sichuan",
            });
            if (w.length) opts.waits.push({ discard: i, tiles: w });
        }
        return opts;
    }

    // 这一家现在允许打哪些牌：立直只能摸切，血战缺门没打光之前只能打缺门。
    // 机器人 AI 不懂这些限制，挑错了 _discard 会直接拒绝，那一巡就没人能动了（整桌卡死）。
    _legalDiscards(seat) {
        const s = this.seats[seat];
        let ids = this.concealedIds(seat);
        if (s.riichi && this.drawn) {
            const drawnId = this.idOf(this.drawn);
            if (ids.includes(drawnId)) ids = [drawnId];
        }
        if (this.mode.que && s.queSuit != null) {
            const que = ids.filter((id) => T.suitOf(id) === s.queSuit);
            if (que.length) ids = que;
        }
        return ids;
    }

    // ---------- 出牌 ----------
    discardBy(userId, tileId) {
        const seat = this.players[userId];
        if (seat === undefined) return { ok: false, hint: "你不在这桌上，发 cc麻将 上桌" };
        if (this.seats[seat].out) return { ok: false, hint: "你这局已经和了，坐着看就行" };
        if (this.phase === "que") return { ok: false, hint: "还没定缺，先 cc缺条 / cc缺万 / cc缺筒" };
        if (this.phase === "claim") return { ok: false, hint: "现在等你声明，先 cc过 才能出牌（能声明什么只走私聊，忘了就发 cc状态）" };
        if (this.phase !== "discard") return { ok: false, hint: "现在不用出牌：" + this.statusText() };
        if (this.turn !== seat) return { ok: false, hint: "没轮到你出牌，现在是 " + this.seats[this.turn].name + " 在打" };
        const events = this._discard(seat, tileId);
        // 打不出去（手里没这张/缺门没打光/立直要摸切）统一算命令失败：
        // 命令层只看 ok，不 ok 就把 hint 原样发出去，不用再去猜事件里有没有 reject
        if (events.length && events[0].type === "reject") return { ok: false, hint: events[0].text, events: events };
        return { ok: true, events: events };
    }

    _discard(seat, tileId, declareRiichi) {
        const s = this.seats[seat];
        const idx = s.hand.findIndex((t) => this.idOf(t) === tileId);
        // 这条 reject 会发到群里：手牌一个字都不能带，只说没有这张
        if (idx < 0) return [{ type: "reject", text: "手里没有" + T.tileName(tileId) + "（发 cc手牌 私聊看自己有什么）" }];
        // 血战：缺门没打光之前只能打缺门
        if (this.mode.que && s.queSuit) {
            const remaining = this.concealedIds(seat).filter((id) => T.suitOf(id) === s.queSuit);
            if (remaining.length && T.suitOf(tileId) !== s.queSuit) {
                // 缺门还剩哪几张是手牌信息：群里只说张数，具体是哪张走私聊手牌看
                return [{ type: "reject", text: "还缺 " + remaining.length + " 张" + this.suitName(s.queSuit) +
                    "，必须先打缺门（发 cc手牌 私聊看是哪几张）" }];
            }
        }
        // 立直家只能打刚摸的那张。declareRiichi 是「这一手就是要立直」：
        // 立直标志已经提前置上了，但摸切限制要从下一巡才开始生效。
        if (s.riichi && !declareRiichi && this.drawn && this.idOf(this.drawn) !== tileId) {
            // 摸的是哪张只有他自己该知道：这条 reject 会发到群里，绝不能带牌名
            return [{ type: "reject", text: "已经立直，只能摸切（打刚摸的那张）。发 cc手牌 私聊能看到是哪张，再用 cc<牌名> 打出去" }];
        }

        const tile = s.hand.splice(idx, 1)[0];
        s.river.push(tile);
        this.lastDiscard = { seat, id: tile.id };
        const wasDrawn = this.drawn && this.idOf(this.drawn) === tile.id;
        this.drawn = null;
        this.discardsInRound++;
        this._sortHands();
        this.turn = seat;

        const events = [{ type: "discard", seat, tile: tile.id, red: !!tile.red, riichi: s.riichi, tsumogiri: wasDrawn }];
        return events.concat(this._openClaims(seat, tile));
    }

    // ---------- 声明窗口 ----------
    // 一家打牌后，另外三家能不能和/杠/碰/吃；机器人当场决定，人类先问再等回答
    _openClaims(fromSeat, tile) {
        const tileId = this.idOf(tile);
        const offers = {};
        for (let s = 0; s < Rules.SEATS; s++) {
            if (s === fromSeat || this.seats[s].out) continue;
            const o = this._claimsFor(s, fromSeat, tile);
            if (o.ron || o.kan || o.pon || o.chi.length) offers[s] = o;
        }
        if (!Object.keys(offers).length) return this._advanceAfterPass(fromSeat);

        const answers = {};
        const humanSeats = [];
        for (const key of Object.keys(offers)) {
            const s = Number(key);
            if (this.seats[s].bot) {
                const choice = this._botClaim(s, offers[s], tileId);
                if (choice) answers[s] = choice;
            } else {
                humanSeats.push(s);
            }
        }
        if (!humanSeats.length) return this._resolveClaims(fromSeat, tile, offers, answers);

        this.phase = "claim";
        this.claim = { tile: tileId, tileObj: tile, from: fromSeat, offers, answers };
        const events = [{ type: "claim-open", tile: tileId, from: fromSeat, seats: humanSeats }];
        for (const s of humanSeats) {
            events.push({ type: "need-claim", seat: s, tile: tileId, from: fromSeat, fromName: this.seats[fromSeat].name, prompt: this.claimPrompt(s) });
        }
        return events;
    }

    _claimsFor(seat, fromSeat, tile) {
        const s = this.seats[seat];
        const tileId = this.idOf(tile);
        const out = { ron: null, pon: false, kan: false, chi: [], furiten: null };
        if (s.riichi) return out;              // 立直后不能碰杠吃（只能自摸/荣和）

        out.ron = this.canRon(seat, tile, fromSeat);
        if (out.ron && out.ron.furiten) { out.furiten = out.ron; out.ron = null; }

        const counts = this.counts(seat);
        // counts 里已经把要打来的这张算进去了，所以门槛是「手里 2 张 = 3」而不是 2。
        // 报错了会引出「碰不了但已经喊了碰」的死局，宁可不报也别报错。
        counts[tileId]++;
        if (counts[tileId] >= 4 && this.wall.length) out.kan = true;
        else if (counts[tileId] >= 3) out.pon = true;
        if (this.mode.chi && (fromSeat + 1) % Rules.SEATS === seat) {
            out.chi = AI.chiOptions(this.concealedIds(seat), tileId);
        }
        return out;
    }

    // 能不能荣和这张牌；被振听挡住时返回 {furiten:true, by, tile} 让上层能说明原因
    canRon(seat, tile, fromSeat, chankan) {
        const s = this.seats[seat];
        if (s.out) return null;
        if (this.mode.que && !this.queCleared(seat)) return null;
        const tileId = this.idOf(tile);
        const res = this.mode.score(this._winCtx(seat, { tile: tileId, tileObj: tile, selfDrawn: false, from: fromSeat, chankan }));
        if (!res.ok) return null;
        if (this.mode.furiten) {
            const waitIds = H.waits(this.counts(seat), { melds: s.melds.length, kokushi: this.mode.id !== "sichuan" });
            const fu = H.isFuriten(waitIds, this.riverIds(seat), this.tempFuriten[seat]);
            if (fu.yes) return { furiten: true, by: fu.by, tile: fu.tile };
        }
        return res;
    }

    claimPrompt(seat) {
        const c = this.claim;
        if (!c || !c.offers[seat]) return "这张牌跟你没关系，直接 cc过";
        const o = c.offers[seat];
        const parts = [];
        if (o.ron) parts.push("cc和（" + (o.ron.label || "和了") + "）");
        if (o.pon) parts.push("cc碰");
        if (o.kan) parts.push("cc杠");
        if (o.chi && o.chi.length) parts.push("cc吃" + this.chiHint(o.chi));
        if (o.furiten) {
            // 说清楚为什么和不了、还能怎么和：只写「只能 cc过」会让人以为这局彻底没戏
            parts.push("（你振听：" + (o.furiten.by === "own" ? "自己牌河里打过 " : "这一巡已经放过 ") +
                T.tileName(o.furiten.tile) + "，这张荣和不了，只能 cc过；自己摸到照样能胡）");
        }
        parts.push("cc过");
        return parts.join(" / ");
    }

    // 提示里给「手里那两张」的点数（cc吃46），跟玩家平时的写法一致；整副三张的写法也一样认
    chiHint(chiOptions) {
        return chiOptions.map((pair) => this._ranksOf(pair).slice().sort((a, b) => a - b).join(""))
            .join(" 或 cc吃");
    }

    _ranksOf(ids) {
        return ids.map((id) => T.rankOf(id));
    }

    suitName(suit) {
        return { m: "万", p: "筒", s: "条" }[suit] || suit;
    }

    // 人类回应声明
    claimBy(userId, parsed) {
        const seat = this.players[userId];
        if (seat === undefined) return { ok: false, hint: "你不在这桌上，发 cc麻将 上桌" };
        if (this.phase !== "claim" || !this.claim) return { ok: false, hint: "现在没有要声明的牌" };
        const c = this.claim;
        const kind = this.normClaimKind(parsed.claim);
        if (!kind) return { ok: false, hint: "认不出这个声明，能用的只有 cc和 / cc碰 / cc杠 / cc吃34 / cc过" };
        if (this.seats[seat].out) return { ok: false, hint: "你这局已经和了" };
        if (kind === "selfdraw") return { ok: false, hint: "自摸要等轮到你摸牌：cc自摸" };
        if (seat === c.from) return { ok: false, hint: "自己打的牌不能自己声明，等下家打" };

        const offer = c.offers[seat];
        if (kind === "pass") {
            c.answers[seat] = { claim: "pass" };
            return { ok: true, events: this._maybeResolve(c.from) };
        }
        if (!offer) return { ok: false, hint: "这张牌你没什么可声明的，发 cc过 就行" };
        if (kind === "ron") {
            if (!offer.ron) {
                return { ok: false, hint: (offer.furiten ? "振听不能荣和（自己打过待牌）。" : "这张牌你和不了。") +
                    "能声明什么只走私聊，忘了就发 cc状态" };
            }
        } else if (!offer[kind]) {
            return { ok: false, hint: "这张牌你" + this.claimVerb(kind) + "不了。能声明什么只走私聊，忘了就发 cc状态" };
        }
        c.answers[seat] = Object.assign({}, parsed, { claim: kind });
        return { ok: true, events: this._maybeResolve(c.from) };
    }

    // notation.parseClaim 给的是 minkan/ankan/ranka/tsumo 这些写法，声明窗口里先归一
    normClaimKind(kind) {
        if (kind === "minkan") return "kan";
        if (kind === "ankan" || kind === "ranka" || kind === "ron" || kind === "pon" || kind === "chi" || kind === "kan") return kind;
        if (kind === "tsumo") return "selfdraw";
        if (kind === "pass") return "pass";
        return null;
    }

    claimVerb(kind) {
        return { ron: "和", pon: "碰", kan: "杠", chi: "吃" }[kind] || kind;
    }

    // 有资格的人类都答完了才结算，避免抢了别人的声明权
    _maybeResolve(fromSeat) {
        const c = this.claim;
        const waiting = Object.keys(c.offers).map(Number).filter((s) => !this.seats[s].bot && !c.answers[s]);
        if (waiting.length) return [];
        const answers = c.answers;
        const tileObj = c.tileObj;
        this.claim = null;
        return this._resolveClaims(fromSeat, tileObj, c.offers, answers);
    }

    // 声明优先级：和 > 杠/碰 > 吃；日麻三家同时荣和 = 流局
    _resolveClaims(fromSeat, tile, offers, answers) {
        this.claim = null;
        this.phase = "discard";
        const tileId = this.idOf(tile);
        // 同巡振听：这张本来能荣和却放过了，直到自己下次摸牌都不能再荣和。
        // 注意只能记「放弃掉的」——以前拿 lastDiscard 当同巡牌河，正在和的这张也在里面，
        // 日麻就永远判振听，谁都没和过。
        for (const key of Object.keys(offers)) {
            const s = Number(key);
            const choice = answers[s];
            const passed = !(choice && choice.claim === "ron");
            if (offers[s].ron && passed && !this.tempFuriten[s].includes(tileId)) {
                this.tempFuriten[s].push(tileId);
            }
        }
        const decisions = [];
        for (const key of Object.keys(offers)) {
            const s = Number(key);
            const choice = answers[s];
            if (choice) decisions.push({ seat: s, choice });
        }
        const rons = decisions.filter((d) => d.choice.claim === "ron");
        if (rons.length) {
            if (rons.length >= 3 && !this.mode.multiRon) return this._endRound("abortive", "三家和");
            return this._multiRon(fromSeat, tile, rons);
        }
        const kan = decisions.find((d) => d.choice.claim === "kan");
        if (kan) return this._orAdvance(fromSeat, this._doMinkan(kan.seat, fromSeat, tile));
        const pon = decisions.find((d) => d.choice.claim === "pon");
        if (pon) return this._orAdvance(fromSeat, this._doPon(pon.seat, fromSeat, tile));
        const chi = decisions.find((d) => d.choice.claim === "chi");
        if (chi) return this._orAdvance(fromSeat, this._doChi(chi.seat, fromSeat, tile, chi.choice));

        return this._advanceAfterPass(fromSeat);
    }

    // 副露失败（手牌不够、吃法写错）时这张牌就当场作废，必须把这一巡推下去。
    // 不往下走的话整桌会停在「打完牌没人摸」的死状态，比错过一次副露严重得多。
    _orAdvance(fromSeat, events) {
        if (events.length && events[0].type === "reject") return events.concat(this._advanceAfterPass(fromSeat));
        return events;
    }

    _advanceAfterPass(fromSeat) {
        this.phase = "discard";
        const next = this.nextSeat(fromSeat);
        if (next === null) return this._endRound("draw");
        if (this.wall.length === 0) return this._endRound("draw");
        return this._beginTurn(next);
    }

    // ---------- 副露落地 ----------
    _takeFrom(seat, tileId, count) {
        const s = this.seats[seat];
        const out = [];
        for (let i = 0; i < count; i++) {
            const idx = s.hand.findIndex((t) => this.idOf(t) === tileId);
            if (idx < 0) break;
            out.push(s.hand.splice(idx, 1)[0]);
        }
        return out;
    }

    _redIds(tiles) {
        return tiles.filter((t) => t && t.red).map((t) => this.idOf(t));
    }

    // 副露一律存「牌对象」而不是裸 id：赤牌标记要跟着这枚牌走，
    // 而且整副牌必须能追溯回牌墙里的原件，不然牌数守恒没法检查。
    _sortedMeld(objs) {
        return objs.slice().sort((a, b) => this.idOf(a) - this.idOf(b));
    }

    _doPon(seat, fromSeat, tile) {
        const tileId = this.idOf(tile);
        if (this.counts(seat)[tileId] < 2) return [{ type: "reject", text: T.tileName(tileId) + " 手里不够两张，碰不了" }];
        const taken = this._takeFrom(seat, tileId, 2);
        if (taken.length < 2) return [{ type: "reject", text: T.tileName(tileId) + " 手里不够两张，碰不了" }];
        const picked = this._clearFromRiver(fromSeat, tileId, tile) || tile;
        this.seats[seat].melds.push({ type: "pon", tiles: this._sortedMeld(taken.concat([picked])), from: fromSeat, concealed: false });
        this._breakIppatsu();
        this.turn = seat;
        this.drawn = null;
        this.phase = "discard";
        const events = [{ type: "meld", seat, kind: "pon", tile: tileId, from: fromSeat }];
        if (this.seats[seat].bot) return events.concat(this._botDiscard(seat));
        events.push({ type: "need-discard", seat, options: this.optionsFor(seat), afterMeld: true });
        return events;
    }

    _doMinkan(seat, fromSeat, tile) {
        const tileId = this.idOf(tile);
        if (this.counts(seat)[tileId] < 3) return [{ type: "reject", text: T.tileName(tileId) + " 手里不够三张，杠不了" }];
        const taken = this._takeFrom(seat, tileId, 3);
        if (taken.length < 3) return [{ type: "reject", text: T.tileName(tileId) + " 手里不够三张，杠不了" }];
        const picked = this._clearFromRiver(fromSeat, tileId, tile) || tile;
        this.seats[seat].melds.push({ type: "kan", tiles: this._sortedMeld(taken.concat([picked])), from: fromSeat, concealed: false });
        this.kanCount++;
        this.lastGangSeat = seat;
        this._flipDora();
        const events = [{ type: "meld", seat, kind: "minkan", tile: tileId, from: fromSeat }];
        events.push(...this._gangScore(seat, "diangang", fromSeat));
        return events.concat(this._rinshanDraw(seat));
    }

    _doChi(seat, fromSeat, tile, choice) {
        const tileId = this.idOf(tile);
        const options = AI.chiOptions(this.concealedIds(seat), tileId);
        const howTo = options.length
            ? "能吃的是 " + this.chiHint(options).replace(/ 或 cc吃/g, " / ") +
              "（写法 cc吃" + this._ranksOf(options[0]).join("") + "）"
            : "手里凑不出这副顺子";
        const wanted = this._chiTiles(seat, tileId, choice);
        if (!wanted) return [{ type: "reject", text: "吃不了：" + howTo }];
        const counts = this.counts(seat);
        if (wanted.some((id) => counts[id] < 1)) return [{ type: "reject", text: "吃不了：" + howTo }];
        const taken = [];
        for (const id of wanted) taken.push(...this._takeFrom(seat, id, 1));
        const picked = this._clearFromRiver(fromSeat, tileId, tile) || tile;
        const objs = this._sortedMeld(taken.concat([picked]));
        this.seats[seat].melds.push({ type: "chi", tiles: objs, from: fromSeat, concealed: false });
        this._breakIppatsu();
        this.turn = seat;
        this.drawn = null;
        this.phase = "discard";
        const events = [{ type: "meld", seat, kind: "chi", tiles: objs.map((t) => this.idOf(t)), from: fromSeat }];
        if (this.seats[seat].bot) return events.concat(this._botDiscard(seat));
        events.push({ type: "need-discard", seat, options: this.optionsFor(seat), afterMeld: true });
        return events;
    }

    _chiTiles(seat, tileId, choice) {
        const options = AI.chiOptions(this.concealedIds(seat), tileId);
        if (!options.length) return null;
        if (choice && choice.ranks && choice.ranks.length) {
            // 点数两种写法都认：写手牌那两张（cc吃46）或写整副三张（cc吃456）。
            // 三条吃法都凑得上时不许瞎猜，让人自己指明。
            const want = choice.ranks.slice().sort((a, b) => a - b).join("");
            for (const pair of options) {
                const handRanks = pair.map((id) => T.rankOf(id)).sort((a, b) => a - b).join("");
                const allRanks = T.sortTiles([tileId].concat(pair)).map((id) => T.rankOf(id)).join("");
                if (want === handRanks || want === allRanks) return pair;
            }
            return null;
        }
        if (choice && choice.tiles && choice.tiles.length === 2) {
            const sorted = T.sortTiles(choice.tiles).join(",");
            for (const pair of options) if (T.sortTiles(pair).join(",") === sorted) return pair;
            return null;
        }
        if (options.length > 1) return null;    // 没说吃哪副，宁可回一句问清楚也别替人挑
        return options[0];
    }

    // 读快照时用：JSON 会把同一枚牌复制成互不相干的对象，牌河里那枚和声明窗口里的
    // tileObj 恢复后不再指向同一枚。碰/吃按对象挖牌河会挖不到，牌河留一张、副露再多一张。
    // 声明窗口挂着的时候牌河没人动过，被声明的那张就是牌河里最后一张同牌，照它对回去。
    relinkRefs() {
        if (!this.claim || !this.claim.tileObj) return;
        const river = (this.seats[this.claim.from] || {}).river || [];
        const red = !!this.claim.tileObj.red;
        for (let i = river.length - 1; i >= 0; i--) {
            if (this.idOf(river[i]) === this.claim.tile && !!river[i].red === red) {
                this.claim.tileObj = river[i];
                return;
            }
        }
    }

    // 被打出来的那张被副露/和牌拿走，牌河要挖掉它（牌河只展示「打出去没被人捡走」的牌）。
    // 给了牌对象就按对象挖：一家牌河里可能有同 id 的另一枚（第二次打五筒），
    // 按 id 挖会挖错枚，错的那枚既不在牌河也不在副露里，整副牌的守恒检查当场崩。
    // 返回拿到的牌对象；返回 null 说明这张已经被别人捡走了（一炮多响）。
    _clearFromRiver(fromSeat, tileId, obj) {
        const river = this.seats[fromSeat].river;
        const idx = obj != null ? river.indexOf(obj) : river.map((t) => this.idOf(t)).lastIndexOf(tileId);
        if (idx < 0) return null;
        const tile = river.splice(idx, 1)[0];
        this.lastDiscard = null;
        return tile;
    }

    // 别家副露会打断一发（除了副露那家自己本来就没有一发）
    _breakIppatsu() {
        for (const s of this.seats) s.ippatsu = false;
    }

    // ---------- 杠 ----------
    // 宝牌指示牌：牌尾头两张是「一张宝牌 + 它底下的里宝」一对，每杠一次多开一对。
    _openIndicators() {
        const open = this.dead.slice(0, this.flipIndex);
        this.doraIndicators = open.filter((t, i) => i % 2 === 0).map((t) => this.idOf(t));
        this.uraIndicators = open.filter((t, i) => i % 2 === 1).map((t) => this.idOf(t));
    }

    _flipDora() {
        if (!this.dead.length) return;
        this.flipIndex = Math.min(this.dead.length, this.flipIndex + 2);
        this._openIndicators();
    }

    _gangScore(seat, kind, discarderSeat) {
        if (!this.mode.gangSettle) return [];
        const res = this.mode.gangSettle({ kind, seat, otherSeats: this.liveSeats(), discarderSeat, base: this.base });
        if (!res.transfers.length) return [];
        this._apply(res.transfers);
        return [{ type: "gang-score", seat, name: res.name, transfers: res.transfers }];
    }

    doAnkanBy(userId, tileId) {
        const seat = this.players[userId];
        if (seat === undefined) return { ok: false, hint: "你不在这桌上" };
        if (this.phase !== "discard" || this.turn !== seat) return { ok: false, hint: "没轮到你" };
        return { ok: true, events: this._doAnkan(seat, tileId) };
    }

    _doAnkan(seat, tileId) {
        if (!this.ankanTiles(seat).includes(tileId)) {
            // 能暗杠哪几张是手牌信息：这条 reject 会发到群里，只指路不报牌
            return [{ type: "reject", text: "手里没有四张" + T.tileName(tileId) + "，暗杠不了（发 cc手牌 私聊看能杠哪张）" }];
        }
        const quad = this._takeFrom(seat, tileId, 4);
        this.seats[seat].melds.push({ type: "kan", tiles: quad, from: seat, concealed: true });
        this.kanCount++;
        this.lastGangSeat = seat;
        this._flipDora();
        const events = [{ type: "meld", seat, kind: "ankan", tile: tileId }];
        return events.concat(this._gangScore(seat, "anzeng", null), this._rinshanDraw(seat));
    }

    doAddKanBy(userId, tileId) {
        const seat = this.players[userId];
        if (seat === undefined) return { ok: false, hint: "你不在这桌上" };
        if (this.phase !== "discard" || this.turn !== seat) return { ok: false, hint: "没轮到你" };
        return { ok: true, events: this._doAddKan(seat, tileId) };
    }

    // 补杠有被抢杠的风险：别人正好和这张，杠不成、直接算他和牌
    _doAddKan(seat, tileId) {
        if (!this.addKanTiles(seat).includes(tileId)) {
            return [{ type: "reject", text: "没碰过 " + T.tileName(tileId) + "，补杠不了（能补杠的：" + (this.addKanTiles(seat).map(T.tileName).join(" ") || "没有") + "）" }];
        }
        const meld = this.seats[seat].melds.find((m) => m.type === "pon" && this.idOf(m.tiles[0]) === tileId);
        if (!meld) return [{ type: "reject", text: "找不到那副碰牌，补杠不了" }];
        const taken = this._takeFrom(seat, tileId, 1);
        const robbers = [];
        for (let s = 0; s < Rules.SEATS; s++) {
            if (s === seat || this.seats[s].out) continue;
            const can = this.canRon(s, taken[0] || { id: tileId, red: false }, seat, true);
            if (can && !can.furiten) robbers.push({ seat: s, res: can });
        }
        if (robbers.length) {
            // 抢杠不成杠：那张第 4 张被和牌家拿走，碰牌还是碰牌
            const events = [];
            const winners = robbers.map((x) => x.seat);
            robbers.forEach((r, i) => {
                const last = i === robbers.length - 1;
                events.push(...this._win(r.seat, {
                    tile: tileId, tileObj: taken[0], selfDrawn: false, from: seat,
                    chankan: true, winners,
                }, !last));
            });
            return events;
        }
        meld.type = "kan";
        meld.tiles = this._sortedMeld(meld.tiles.concat(taken));
        meld.concealed = false;
        this.kanCount++;
        this.lastGangSeat = seat;
        this._flipDora();
        const events = [{ type: "meld", seat, kind: "ranka", tile: tileId }];
        return events.concat(this._gangScore(seat, "bugang", null), this._rinshanDraw(seat));
    }

    // 杠后摸牌：从牌墙尾部摸（岭上开花）
    _rinshanDraw(seat) {
        // 杠是谁杠的就轮到谁出牌。明杠是在「打牌那家」的回合里发生的，
        // 不把 turn 抢过来的话，人杠完机器人的回合还挂着，全桌没人能打=死局
        this.turn = seat;
        if (!this.wall.length) return this._endRound("draw");
        const tile = this.wall.pop();
        this.tempFuriten[seat] = [];
        this.drawn = tile;
        this.seats[seat].hand.push(tile);
        this._sortHands();
        const events = [{ type: "draw", seat, tile: this.idOf(tile), red: !!tile.red, rinshan: true }];
        if (this.seats[seat].bot) return events.concat(this._botAfterDraw(seat, true));
        this.phase = "discard";
        events.push({ type: "need-discard", seat, options: this.optionsFor(seat), rinshan: true });
        return events;
    }

    // 门清：副露全是暗杠（暗杠不破门清）。立直只给门清家，碰/吃/明杠过的一律不行。
    isMenzen(seat) {
        return this.seats[seat].melds.every((m) => m.concealed);
    }

    // ---------- 立直 ----------
    riichiBy(userId, tileId) {
        const seat = this.players[userId];
        if (seat === undefined) return { ok: false, hint: "你不在这桌上，发 cc麻将 上桌" };
        if (!this.mode.riichi) return { ok: false, hint: this.mode.name + "玩法没有立直" };
        if (this.phase === "claim") return { ok: false, hint: "先处理完这次的声明（能声明什么只走私聊，忘了就发 cc状态）" };
        if (this.phase !== "discard" || this.turn !== seat) return { ok: false, hint: "没轮到你出牌" };
        const s = this.seats[seat];
        if (s.riichi) return { ok: false, hint: "已经立直了" };
        if (!this.isMenzen(seat)) {
            return { ok: false, hint: "你碰/吃/明杠过了，不能立直——立直要门清（暗杠不破门清）" };
        }
        if (s.score < 1000) return { ok: false, hint: "立直要付 1000 点，你只有 " + s.score + " 点" };
        if (this.wall.length < 4) return { ok: false, hint: "牌墙剩不到 4 张，不能立直" };
        const counts = this.counts(seat);
        if (counts[tileId] < 1) return { ok: false, hint: "手里没有" + T.tileName(tileId) };
        counts[tileId]--;
        // 暗杠的 4 张不在手牌 counts 里，但结构上要算一组面子
        const waits = H.waits(counts, { melds: s.melds.length });
        if (!waits.length) {
            return { ok: false, hint: "打了" + T.tileName(tileId) + "还没听牌，立直要打完就听（换一张打法，或发 cc手牌 私聊看你打哪张能听）" };
        }
        s.riichi = true;
        s.ippatsu = true;
        s.doubleRiichi = this.discardsInRound === 0;
        this.riichiSticks++;
        s.score -= 1000;
        const events = [{ type: "riichi", seat, tile: tileId, waits, double: s.doubleRiichi }];
        return { ok: true, events: events.concat(this._discard(seat, tileId, true)) };
    }

    // ---------- 和牌 ----------
    tsumoBy(userId) {
        const seat = this.players[userId];
        if (seat === undefined) return { ok: false, hint: "你不在这桌上，发 cc麻将 上桌" };
        if (this.phase === "claim") return { ok: false, hint: "先把这次的声明答了（能声明什么只走私聊，忘了就发 cc状态）" };
        if (this.phase !== "discard" || this.turn !== seat) return { ok: false, hint: "没轮到你摸牌，和不了" };
        const res = this.canTsumo(seat);
        if (!res) return { ok: false, hint: "现在不能自摸：" + this.whyNoWin(seat, this.idOf(this.drawn), true) };
        return { ok: true, events: this._win(seat, { tile: this.idOf(this.drawn), selfDrawn: true }) };
    }

    // 荣和走声明窗口（_resolveClaims），这里兜底处理「在别人刚打完的那一步直接喊 cc和」
    ronBy(userId) {
        const seat = this.players[userId];
        if (seat === undefined) return { ok: false, hint: "你不在这桌上，发 cc麻将 上桌" };
        if (this.phase === "claim" && this.claim) return this.claimBy(userId, { claim: "ron" });
        if (this.phase === "discard" && this.turn === seat) return this.tsumoBy(userId);
        return { ok: false, hint: "和牌要在别人刚打完的那一步喊：现在轮到 " + this.seats[this.turn].name + " 出牌" };
    }

    whyNoWin(seat, tileId, selfDrawn) {
        if (this.mode.que && !this.queCleared(seat)) {
            return "手里还有缺门牌（" + this.suitName(this.seats[seat].queSuit) + "），花猪和不了";
        }
        const ids = this.concealedIds(seat);
        const counts = this.counts(seat);
        if (!selfDrawn) counts[tileId]++;
        const melds = this.seats[seat].melds.length;
        const shapeOk = H.isStandardWin(counts, melds) ||
            (melds === 0 && (H.isChiitoiCounts(counts) || (this.mode.id !== "sichuan" && H.isKokushiCounts(counts))));
        if (!shapeOk) return "牌型还没凑成（要 4 面子 + 1 雀头，或七对/国士）";
        const res = this.mode.score(this._winCtx(seat, { tile: tileId, selfDrawn }));
        return res.reason || "算不出番来";
    }

    _winCtx(seat, opts) {
        const s = this.seats[seat];
        const winTile = opts.tile;
        // 计分模块要的是「含和牌张」的门前牌：自摸那张已经在手里了，
        // 荣和/抢杠这张还得把牌河（或杠）里的那枚并进来。
        const tiles = s.hand.slice();
        if (!opts.selfDrawn) tiles.push(opts.tileObj || { id: winTile, red: false });
        const ids = tiles.map((t) => this.idOf(t));
        // 赤宝牌要看全部牌：副露里那枚赤 5 也算，只数门前的话会少一番
        const redMeldTiles = [];
        for (const m of s.melds) for (const t of m.tiles) if (t && t.red) redMeldTiles.push(t);
        const counts13 = this.counts(seat);
        if (opts.selfDrawn && counts13[winTile] > 0) counts13[winTile]--;
        const firstRound = this.discardsInRound <= 1;   // 第一巡内：天和/地和/人和都看这个
        const afterGang = !!opts.rinshan || this.lastGangSeat === seat;

        const ctx = {
            concealedIds: ids,
            concealedTiles: tiles.concat(redMeldTiles),   // 计分模块只用它数赤牌
            redIds: this._redIds(tiles).concat(this._redIds(redMeldTiles)),
            melds: s.melds,
            winTile,
            winSeat: seat,
            dealerSeat: this.dealerSeat,
            seatWind: WINDS[(seat - this.dealerSeat + Rules.SEATS) % Rules.SEATS],
            roundWind: WINDS[this.roundWind],
            selfDrawn: !!opts.selfDrawn,
            discarderSeat: opts.from == null ? null : opts.from,
            doraIndicators: this.doraIndicators,
            uraIndicators: this.uraIndicators,
            riichi: !!s.riichi,
            doubleRiichi: !!s.doubleRiichi,
            ippatsu: !!s.ippatsu,
            honba: this.honba,
            riichiSticks: this.riichiSticks,
            waitShape: guessWaitShape(counts13, winTile),
            chankan: !!opts.chankan,
            rinshan: !!opts.rinshan,
            haitei: !!opts.selfDrawn && this.wall.length === 0,
            houtei: !opts.selfDrawn && this.wall.length === 0,
            tenhou: !!opts.selfDrawn && seat === this.dealerSeat && this.turnNumber === 1 && s.melds.length === 0,
            chihou: !!opts.selfDrawn && seat !== this.dealerSeat && firstRound && s.melds.length === 0,
            renhou: !opts.selfDrawn && firstRound && s.melds.length === 0,
            allowChiitoi: true,
            allowKokushi: this.mode.id !== "sichuan",
            base: this.base,
            fanCap: this.fanCap,
            wallEmpty: this.wall.length === 0,
            afterGangDraw: afterGang,
            gangPlayerSeat: this.lastGangSeat,
            robbedKang: !!opts.chankan,
            tianhu: ctx_tianhu(opts.selfDrawn, seat, this),
            dihu: !!opts.selfDrawn && seat !== this.dealerSeat && firstRound,
        };
        if (this.mode.que) ctx.queSuit = s.queSuit;
        return ctx;
    }

    _multiRon(fromSeat, tile, rons) {
        const events = [];
        const winners = rons.map((r) => r.seat);
        rons.forEach((r, i) => {
            events.push(...this._win(r.seat, {
                tile: this.idOf(tile), tileObj: tile, selfDrawn: false, from: fromSeat, winners,
            }, i !== rons.length - 1));
        });
        return events;
    }

    // noEnd = true：还有别家要和这一张（一炮多响/多人抢杠），这一步先不结算本局
    _win(seat, opts, noEnd) {
        const s = this.seats[seat];
        if (s.out) return [];
        const ctx = this._winCtx(seat, opts);
        const res = this.mode.score(ctx);
        if (!res.ok) return [{ type: "reject", text: s.name + " 和不了" + T.tileName(opts.tile) + "：" + res.reason }];

        const transfers = res.transfers || [];
        this._apply(transfers);
        // total 里可能含「立直棒池子」（那 1000 是 declarer 之前扣的，不属于任何人的付），
        // 池子以外的钱 _apply 已经转过了，这里只补差额，绝不能整个 total 再加一遍。
        const paid = transfers.reduce((a, t) => a + t.amount, 0);
        const sticks = Math.max(0, (res.total || paid) - paid);
        s.score += sticks;
        this.riichiSticks = 0;

        if (!opts.selfDrawn) {
            const from = opts.from == null ? null : opts.from;
            const obj = opts.tileObj || { id: opts.tile, red: false };
            if (from != null && !opts.chankan) this._clearFromRiver(from, opts.tile, obj);
            // 一炮多响/多人抢杠：同一枚实物只能有一份，后拿的那家是「虚牌」，牌数检查要算上
            if (this.claimedObjs.has(obj)) this.phantomTiles++;
            this.claimedObjs.add(obj);
            s.hand.push(obj);
        }
        this._sortHands();
        s.out = true;
        s.ippatsu = false;
        s.winInfo = { res, tile: opts.tile, selfDrawn: !!opts.selfDrawn, from: opts.from == null ? null : opts.from };

        const events = [{
            type: "win", seat, name: s.name, tile: opts.tile, selfDrawn: !!opts.selfDrawn,
            from: opts.from == null ? null : opts.from, res, transfers, sticks,
        }];

        // 血战到底：和完离桌，剩下的人接着打，直到只剩一家或牌墙摸完
        if (noEnd) return events;                       // 一炮多响：还有别家要和这张
        if (this.mode.id === "sichuan") {
            const stillIn = this.liveSeats();
            if (stillIn.length > 1 && this.wall.length) {
                this.phase = "discard";
                return events.concat(this._beginTurn(this.nextSeat(seat)));
            }
            const won = [];
            for (let i = 0; i < Rules.SEATS; i++) if (this.seats[i].out) won.push(i);
            return events.concat(this._endRound("win", null, won));
        }
        return events.concat(this._endRound("win", null, opts.winners || [seat]));
    }

    // ---------- 流局 / 结算 / 轮庄 ----------
    _endRound(reason, abortBy, winners) {
        if (this.phase === "round-over") return [];
        const events = [];
        const tenpaiSeats = [];
        for (let i = 0; i < Rules.SEATS; i++) {
            if (this.seats[i].out) continue;
            if (this.isTenpai(i)) tenpaiSeats.push(i);
        }

        if (reason === "draw" || reason === "abortive") {
            if (this.mode.drawSettle && !abortBy) {
                const transfers = this.mode.drawSettle(this._drawCtx(tenpaiSeats));
                if (transfers && transfers.length) {
                    this._apply(transfers);
                    events.push({ type: "draw-settle", name: this.mode.drawName, transfers });
                }
            }
            events.push({ type: "round-end", reason: abortBy ? "中途流局：" + abortBy : "流局", winners: [], tenpai: tenpaiSeats });
        } else {
            events.push({ type: "round-end", reason: "和牌", winners: winners || [], tenpai: tenpaiSeats });
        }

        // 轮庄：和牌看庄家有没有和，流局看庄家听没听
        const list = winners || [];
        const keepDealer = reason === "win" ? list.includes(this.dealerSeat) : tenpaiSeats.includes(this.dealerSeat);
        if (keepDealer) {
            this.honba++;
        } else {
            this.dealerSeat = (this.dealerSeat + 1) % Rules.SEATS;
            this.honba = 0;
        }
        this.phase = "round-over";
        this.claim = null;
        this.turn = this.dealerSeat;
        events.push({
            type: "standings",
            scores: this.seats.map((x, i) => ({ seat: i, name: x.name, score: x.score, bot: x.bot, out: x.out, riichi: x.riichi })),
            dealer: this.dealerSeat, honba: this.honba, keepDealer,
            sticksLeft: this.riichiSticks,
        });
        this.tail.push(events.filter((e) => e.type === "win" || e.type === "round-end" || e.type === "draw-settle"));
        if (this.tail.length > 12) this.tail.shift();
        return events;
    }

    _drawCtx(tenpaiSeats) {
        const list = [];
        for (let i = 0; i < Rules.SEATS; i++) {
            const s = this.seats[i];
            if (s.out) continue;      // 已经和了的不参与查花猪/查叫
            list.push({
                seat: i,
                queLeft: s.queSuit ? this.concealedIds(i).filter((id) => T.suitOf(id) === s.queSuit).length : 0,
                ting: tenpaiSeats.includes(i),
                maxFan: this._bestFan(i),
            });
        }
        return { tenpaiSeats, dealerSeat: this.dealerSeat, players: list, base: this.base, fanCap: this.fanCap };
    }

    // 听牌家最多能番多大（查叫按这个赔），血战才算，日麻罚符不看番
    _bestFan(seat) {
        if (this.mode.id !== "sichuan") return 0;
        const s = this.seats[seat];
        if (!s.queSuit || !this.queCleared(seat) || s.melds.length) return 0;
        const counts = this.counts(seat);
        let best = 0;
        for (let id = 0; id < 34; id++) {
            if (counts[id] >= 4) continue;
            const next = counts.slice();
            next[id]++;
            const ids = T.tilesFromCounts(next);
            const res = this.mode.score({
                concealedIds: ids, concealedTiles: ids.map((x) => ({ id: x, red: false })),
                melds: [], winTile: id, winSeat: seat, queSuit: s.queSuit,
                selfDrawn: false, discarderSeat: 0, dealerSeat: this.dealerSeat,
                base: this.base, fanCap: this.fanCap,
            });
            if (res.ok) best = Math.max(best, res.rawFan || res.fan || 0);
        }
        return best;
    }

    isTenpai(seat) {
        const s = this.seats[seat];
        if (s.out) return false;
        if (this.mode.que && !this.queCleared(seat)) return false;
        return H.waits(this.counts(seat), {
            melds: s.melds.length,
            chiitoi: true,
            kokushi: this.mode.id !== "sichuan",
        }).length > 0;
    }

    _apply(transfers) {
        for (const t of transfers || []) {
            if (!t || t.from == null || t.to == null || t.from === t.to) continue;
            this.seats[t.from].score -= t.amount;
            this.seats[t.to].score += t.amount;
        }
    }

    // ---------- 机器人 ----------
    _botAfterDraw(seat, rinshan) {
        const s = this.seats[seat];
        const res = this.canTsumo(seat);
        if (res) return this._win(seat, { tile: this.idOf(this.drawn), selfDrawn: true, rinshan });
        const ankans = this.ankanTiles(seat);
        if (ankans.length) return this._doAnkan(seat, ankans[0]);
        const adds = this.addKanTiles(seat);
        if (adds.length && !s.riichi) return this._doAddKan(seat, adds[0]);
        return this._botDiscard(seat);
    }

    _botDiscard(seat) {
        const s = this.seats[seat];
        const hand = this.concealedIds(seat);
        let tileId;
        if (s.riichi) tileId = this.drawn ? this.idOf(this.drawn) : hand[hand.length - 1];
        else tileId = AI.chooseDiscard(this, seat, hand, {
            chiitoi: true, kokushi: this.mode.id !== "sichuan", defend: this._someoneReichi(seat),
        });
        // AI 不懂缺门/摸切这些限制，挑错了这一巡会整桌卡死，所以强制换成一张合法的
        const legal = this._legalDiscards(seat);
        if (tileId == null || !legal.includes(tileId)) tileId = legal[legal.length - 1];
        if (tileId == null) return this._endRound("draw");
        const events = [];
        let declared = false;
        if (this.mode.riichi && !s.riichi && this.isMenzen(seat) && s.score >= 1000 && this.wall.length >= 4) {
            const counts = this.counts(seat);
            counts[tileId]--;
            const waits = H.waits(counts, { melds: s.melds.length });
            if (waits.length) {
                s.riichi = true;
                s.ippatsu = true;
                s.doubleRiichi = this.discardsInRound === 0;
                this.riichiSticks++;
                s.score -= 1000;
                events.push({ type: "riichi", seat, tile: tileId, bot: true, double: s.doubleRiichi, waits });
                declared = true;
            }
        }
        return events.concat(this._discard(seat, tileId, declared));
    }

    _someoneReichi(seat) {
        for (let i = 0; i < Rules.SEATS; i++) if (i !== seat && this.seats[i].riichi) return true;
        return false;
    }

    _botClaim(seat, offer, tileId) {
        if (offer.ron) return { claim: "ron" };
        if (offer.kan) return { claim: "kan" };
        const opts = { chiitoi: true, kokushi: this.mode.id !== "sichuan" };
        if (offer.pon && AI.wantsPon(this, seat, this.concealedIds(seat), tileId, opts)) return { claim: "pon" };
        if (offer.chi && offer.chi.length && AI.wantsChi(this, seat, this.concealedIds(seat), tileId, opts)) {
            return { claim: "chi", tiles: offer.chi[0] };
        }
        return null;
    }

    // AI 需要的两个小接口
    isDora(id) {
        if (!this.doraIndicators.length) return false;
        return this.doraIndicators.some((ind) => R_doraOf(ind) === id);
    }

    riversOwn(seat) {
        return this.riverIds(seat);
    }

    // ---------- 定缺（血战） ----------
    setQueBy(userId, suit) {
        const seat = this.players[userId];
        if (seat === undefined) return { ok: false, hint: "你不在这桌上，发 cc麻将 上桌" };
        if (this.phase !== "que") return { ok: false, hint: "现在不用定缺" };
        if (!["m", "p", "s"].includes(suit)) return { ok: false, hint: "定缺只认 万/筒/条：cc缺条" };
        this.seats[seat].queSuit = suit;
        const waiting = [];
        for (let i = 0; i < Rules.SEATS; i++) if (!this.seats[i].queSuit) waiting.push(i);
        if (waiting.length) return { ok: true, events: [{ type: "que-set", seat, suit, waiting }] };
        return { ok: true, events: [{ type: "que-set", seat, suit }].concat(this._beginTurn(this.dealerSeat)) };
    }

    // ---------- 展示 ----------
    handText(seat) {
        const s = this.seats[seat];
        const parts = this.concealedIds(seat).map((id) => T.tileName(id));
        const melds = s.melds.map((m) => H.describeMeld(m).text);
        return (parts.join(" ") || "（没牌）") + (melds.length ? " │ " + melds.join(" ") : "");
    }

    riverText(seat) {
        const ids = this.riverIds(seat);
        return ids.length ? ids.map(T.tileName).join(" ") : "（空）";
    }

    // 渲染层要的结构化盘面（PNG 和文字都从这里出）
    snapshot(seat) {
        // 结算之后全桌亮牌；打牌过程中只有问的那一家能看见自己的手牌
        const revealAll = this.phase === "round-over";
        // 结算时 dealerSeat 已经轮到下局了，盘面要画刚打完这局的庄家，不然风位当场翻个个儿
        const shownDealer = revealAll && this.roundDealer != null ? this.roundDealer : this.dealerSeat;
        return {
            mode: { id: this.mode.id, name: this.mode.name, unit: this.mode.unit },
            phase: this.phase, turn: this.turn, dealer: shownDealer, nextDealer: this.dealerSeat,
            round: this.roundNumber, honba: this.honba, roundWind: WINDS[this.roundWind],
            wall: this.wall.length, sticks: this.riichiSticks,
            // 刚摸的牌只有轮到他自己的那家才看得到；公开盘面/别人的盘面一律不给
            drawn: (seat != null && seat === this.turn && this.drawn)
                ? { id: this.idOf(this.drawn), red: !!this.drawn.red } : null,
            claim: this.claim ? { tile: this.claim.tile, from: this.claim.from } : null,
            dora: this.doraIndicators, ura: this.uraIndicators,
            deadWall: this.dead.map((t) => ({ id: this.idOf(t), red: !!t.red })), flipIndex: this.flipIndex,
            seatOfUser: seat == null ? null : seat,
            seats: this.seats.map((s, i) => ({
                seat: i, id: s.id, name: s.name, bot: s.bot, score: s.score,
                // 别人的手牌是隐私：公开盘面只给张数，命令层拿到 seat 才画得出来
                hand: (revealAll || seat === i) ? s.hand.map((t) => ({ id: this.idOf(t), red: !!t.red })) : [],
                handCount: s.hand.length,
                river: s.river.map((t) => ({ id: this.idOf(t), red: !!t.red })),
                melds: s.melds.map((m) => ({
                    type: m.type,
                    tiles: m.tiles.map((t) => this.idOf(t)),
                    reds: this._redIds(m.tiles),
                    concealed: !!m.concealed,
                    from: m.from,
                })),
                riichi: !!s.riichi, out: !!s.out, queSuit: s.queSuit,
                win: s.winInfo ? { tile: s.winInfo.tile, selfDrawn: s.winInfo.selfDrawn, label: s.winInfo.res.label } : null,
                // 待牌只算问的那一家：别人的听牌是手牌信息，不能画到公开盘面上
                waits: (seat === i && !s.out) ? H.waits(this.counts(i), { melds: s.melds.length, kokushi: this.mode.id !== "sichuan" }) : [],
            })),
        };
    }

    statusText() {
        if (this.phase === "lobby") return "还没开局，发 cc麻将 上桌，人不够机器人补满";
        const who = this.seats[this.turn] ? this.seats[this.turn].name : "?";
        const que = this.mode.que ? "　定缺：" + this.seats.map((s, i) => (i + 1) + "家" + (s.queSuit ? this.suitName(s.queSuit) : "没定")).join(" ") : "";
        const line = [
            this.mode.name + (WINDS[this.roundWind] === 27 ? "东" : "南") + "风场",
            "第 " + this.roundNumber + " 局　" + this.honba + " 本棒",
            "庄家 " + this.seats[this.dealerSeat].name,
            "牌墙剩 " + this.wall.length + " 张",
        ];
        if (this.mode.riichi) line.push("立直棒 " + this.riichiSticks);
        if (this.phase === "que") return "【麻将】" + line.join("　") + "\n各家先定缺：cc缺万 / cc缺筒 / cc缺条";
        if (this.phase === "claim") {
            const c = this.claim;
            const waiting = Object.keys(c.offers).map(Number).filter((s) => !this.seats[s].bot && !c.answers[s]);
            // 谁能碰谁能和是隐私：群里只说「这张牌在等人表态」，选项私聊发给被问的那一家
            return "【麻将】" + this.seats[c.from].name + " 打 " + T.tileName(c.tile) + "　" +
                (waiting.length ? "这张牌有人要表态，已经私聊问了，稍等" : "（机器人在想，稍等）");
        }
        if (this.phase === "round-over") return "【麻将】本局已结算：" + (this.tail.length ? "发 cc下一局 开下一局，cc结束 散桌" : "");
        return "【麻将】" + line.join("　") + que + "\n轮到 " + who + (this.seats[this.turn].riichi ? "（立直）" : "");
    }
}

// 宝牌指示牌 -> 宝牌本身（和计分模块同一套推法，只给 AI 的危险度/价值用）
function R_doraOf(indicator) {
    if (indicator == null) return null;
    if (T.isNum(indicator)) {
        const base = Math.floor(indicator / 9) * 9;
        return base + ((indicator % 9 + 1) % 9);
    }
    if (T.isWind(indicator)) return 27 + ((indicator - 27 + 1) % 4);
    return 31 + ((indicator - 31 + 1) % 3);
}

// 天胡：庄家第一巡自摸成牌（血战也叫天胡，两个模块字段名不同，这里一起给）
function ctx_tianhu(selfDrawn, seat, game) {
    return !!selfDrawn && seat === game.dealerSeat && game.turnNumber === 1;
}

module.exports = { MahjongGame, WINDS, BOT_NAMES, guessWaitShape };
