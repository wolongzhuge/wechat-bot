"use strict";
// 五子棋：两个人、群里 cc 下子、每手把盘面画成图片发回群里（不需要私信）
const { client } = require("../../app");
const { GomokuGame, SIZE, COLOR_NAME } = require("./game");
const { renderImage, renderText } = require("./render");

// room -> GomokuGame（牌桌钉在 state/store.js，热重载不丢局）
const games = require("../../state/store").gameMaps.gomoku;

// 坐标一律「前列后行」：cc5,6 = 第5列第6行。
// 为什么不是前行后列：盘面上列号写在最上面、行号写在最左边，读图就是先看到上面那个数，
// 顺序跟读图一致，不用在脑子里换一次。
// 纯数字连着写会撞车（111 到底是 11列1行 还是 1列11行），所以允许中文数字：
// 一十一 就是 1 列 11 行 —— 切分点取「前面那段尽量短」的合法切法。
const CN_DIGIT = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const VERB = /^(?:下|落子|落|走|放|摆|去|填)\s*/;
const NUM_RE = "(?:\\d{1,2}|[一二三四五六七八九十]{1,4})";

// 「十一」=11、「一十三」=13、「五」=5；盘面只有 15 路，所以二十几不认
function cnNumber(s) {
    if (!s) return null;
    if (CN_DIGIT[s] !== undefined) return CN_DIGIT[s];
    const m = s.match(/^(?:([一二三四五六七八九])?十([一二三四五六七八九])?)$/);
    if (!m) return null;
    const tens = m[1] ? CN_DIGIT[m[1]] : 1;
    if (tens > 1) return null;
    return tens * 10 + (m[2] ? CN_DIGIT[m[2]] : 0);
}

// 连写的中文数字拆成两个坐标，取第一个能拆通的分界点：一十一 -> (1,11) 而不是 (11,1)
function cnPair(s) {
    for (let i = 1; i < s.length; i++) {
        const a = cnNumber(s.slice(0, i));
        const b = cnNumber(s.slice(i));
        if (a >= 1 && b >= 1) return { col: a, row: b };
    }
    return null;
}

const asNumber = (token) => (CN_DIGIT[token] !== undefined || /^[一二三四五六七八九十]+$/.test(token)
    ? cnNumber(token) : Number(token));

// 返回 {col,row}；认不出来时返回 {bad: 原因}，提示层直接把原因念出来
function parseCoord(text) {
    const raw = String(text)
        .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
        .replace(/[，、；;。．\-－\s]+/g, ",")
        .replace(/,{2,}/g, ",")
        .replace(/^,|,$/g, "");
    const body = raw.replace(VERB, "").replace(/[第]/g, "").replace(/[格路点位]/g, "");
    if (!body) return { bad: "空的" };

    // 带「列/行」字样的最优先，写反了也认：6行5列 照样是 5 列 6 行
    const labeled = body.match(new RegExp("(" + NUM_RE + ")\\s*列[^0-9一二三四五六七八九十]{0,3}(" + NUM_RE + ")\\s*行")) ||
        body.match(new RegExp("(" + NUM_RE + ")\\s*行[^0-9一二三四五六七八九十]{0,3}(" + NUM_RE + ")\\s*列"));
    if (labeled) {
        const m = labeled[0].indexOf("列") < labeled[0].indexOf("行")
            ? [labeled[1], labeled[2]] : [labeled[2], labeled[1]];
        return pair(m[0], m[1]);
    }

    // 中文数字整串连着写
    if (/^[一二三四五六七八九十]+$/.test(body)) {
        const hit = cnPair(body);
        if (hit) return hit;
        const single = cnNumber(body);
        return { bad: single ? "只给了一个数（" + single + "），要两个：前列后行" : "没拆出两段数字" };
    }

    // 逗号/空格分开的一对数字
    const parts = body.split(",").filter(Boolean);
    if (parts.length >= 2) return pair(parts[0], parts[1]);

    // 光秃秃连着写：两位就 1+1，四位就 2+2，三位是歧义（111），拒绝并教怎么写
    if (/^\d$/.test(body)) return { bad: "只给了一个数（" + body + "），要两个：前列后行" };
    if (/^\d{2}$/.test(body)) return pair(body[0], body[1]);
    if (/^\d{4}$/.test(body)) return pair(body.slice(0, 2), body.slice(2));
    if (/^\d{3}$/.test(body)) {
        return { bad: "连写三位分不清是「" + body[0] + "列" + body.slice(1) + "行」还是「" +
            body.slice(0, 2) + "列" + body[2] + "行」，中间加个逗号，或者写中文「" +
            toCn(body[0]) + toCn(body.slice(1)) + "」" };
    }
    return { bad: "没看懂" };
}

const CN_OF = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五"];
const toCn = (n) => CN_OF[Number(n)] || String(n);

function pair(a, b) {
    const col = asNumber(a), row = asNumber(b);
    if (!(col >= 1 && row >= 1)) return { bad: "认不出「" + a + "」或「" + b + "」是数字" };
    return { col, row };
}

// 用户手滑写反了怎么办：越界的那个方向反过来试一次
function fixSwap(coord) {
    if (coord.col <= SIZE && coord.row <= SIZE) return coord;
    const swapped = { col: coord.row, row: coord.col };
    return swapped.col <= SIZE && swapped.row <= SIZE ? swapped : null;
}

// 图片发不出去就退回文本盘面，别让人对着空气下棋
function postBoard(event, game) {
    let b64 = null;
    try {
        b64 = renderImage(game);
    } catch (err) {
        console.error("盘面渲染失败: " + err.message);
    }
    if (!b64) return event.reply(renderText(game));
    return event.reply({ image: b64 }).catch((err) => {
        console.error("盘面图片发送失败，改发文本: " + err.message);
        return event.reply(renderText(game));
    });
}

function startCommand(event) {
    const room = event.group_id;
    const userId = event.sender.user_id;
    const name = client.displayName(userId);

    let game = games.get(room);
    // 上一局已经下完就自动清盘重开，不然「两个人已经齐了」会把人堵死
    if (game && game.winner) game = null;
    if (!game) {
        game = new GomokuGame();
        games.set(room, game);
    }
    const added = game.addPlayer(userId, name);
    if (!added.ok) return event.reply("【五子棋】" + added.reason);

    if (game.players.length < 2) {
        return event.reply(
            game.statusText() +
            "\n规则：15×15，先连成五子者胜，黑棋先手。\n" +
            "等人时可以先发 cc规则 看玩法。"
        );
    }
    game.start(true);
    const vs = game.players.map((p) => p.name + "(" + COLOR_NAME[p.color] + ")").join("  对  ");
    return event.reply(
        "【五子棋】开局！" + vs + "\n随机定黑白，黑棋先手，共 " + SIZE + "×" + SIZE + " 格。\n" +
        "落子：cc3,8 = 第3列第8行（列在前、行在后，逗号 , 或 ， 都行，也可以不打逗号直接 cc38）\n" +
        "「下」不用打：cc8,8、cc八八、cc8列8行 都认；连写分不清就用中文，cc一十三 = 1 列 13 行。\n" +
        "随时 cc棋盘 看盘面（图上列号在最上面、行号在最左边），撑不住就 cc认输。\n" +
        "第一手建议占天元 cc8,8。"
    ).then(() => postBoard(event, game));
}

function moveCommand(event, raw) {
    const room = event.group_id;
    const game = games.get(room);
    if (!game) return event.reply("【五子棋】这里还没有棋局，发 cc五子棋 开一局（两个人就能玩）。");

    const coord = parseCoord(raw);
    if (coord.bad) {
        return event.reply(
            "【五子棋】" + coord.bad + "。落子写「前列后行」，例如 cc3,8 = 第3列第8行。\n" +
            "「下」可以省：cc3,8、cc3 8、cc3-8、cc三八、cc3列8行 都认；" +
            "连写的中文数字按「前列后行」拆，cc一十三 就是 1 列 13 行。\n" +
            "行列都从 1 数到 " + SIZE + "，盘面图上列号在最上面、行号在最左边。\n" +
            game.statusText()
        );
    }
    const fixed = fixSwap(coord);
    if (!fixed) {
        return event.reply("【五子棋】坐标要在 1~" + SIZE + " 之间（第" + coord.col + "列第" + coord.row +
            "行超了），列在前、行在后。" + game.statusText());
    }
    const res = game.place(event.sender.user_id, fixed.row, fixed.col);
    if (!res.ok) return event.reply("【五子棋】" + res.hint);

    const label = res.player.name + " 第" + res.col + "列第" + res.row + "行 " + COLOR_NAME[res.player.color];
    if (game.winner) {
        const again = "发 cc五子棋 立刻再来一局。";
        return event.reply("【五子棋】" + label + " —— 落子成五连！\n" + game.statusText() + "\n" + again)
            .then(() => postBoard(event, game));
    }
    return event.reply("【五子棋】" + label + "\n" + game.statusText()).then(() => postBoard(event, game));
}

function boardCommand(event) {
    const room = event.group_id;
    const game = games.get(room);
    if (!game) return event.reply("【五子棋】这里没有棋局，发 cc五子棋 开一局。");
    return event.reply(game.statusText()).then(() => postBoard(event, game));
}

function resignCommand(event) {
    const room = event.group_id;
    const game = games.get(room);
    if (!game) return event.reply("【五子棋】这里没有棋局。");
    const res = game.resign(event.sender.user_id);
    if (!res.ok) return event.reply("【五子棋】" + res.hint);
    return event.reply(
        "【五子棋】" + res.player.name + " 认输，" + res.other.name + " 获胜（共 " + game.moves.length + " 手）\n" +
        "发 cc五子棋 再来一局。"
    ).then(() => postBoard(event, game));
}

function endCommand(event) {
    const room = event.group_id;
    if (!games.has(room)) return event.reply("【五子棋】这里没有棋局。");
    const game = games.get(room);
    const summary = game.moves.length + " 手，" + game.players.map((p) => p.name).join("、");
    games.delete(room);
    return event.reply("【五子棋】已清盘（" + summary + "）。开新局发 cc五子棋。");
}

function rulesCommand(event) {
    return event.reply(
        "【五子棋规则】15×15，黑先白后，轮流落子，横/竖/斜任意方向先连成 5 子者胜。\n" +
        "玩法：\n" +
        "cc五子棋 开局（两人各发一次，随机定黑白）\n" +
        "cc3,8 落子在「第3列第8行」——列在前、行在后，「下」不用打\n" +
        "写法都认：cc3,8 / cc3，8 / cc3 8 / cc3-8 / cc38 / cc3列8行 / cc三八\n" +
        "连写的中文数字按前列后行拆：cc一十一 = 1 列 11 行、cc一十三 = 1 列 13 行；" +
        "纯数字连写三位（cc118）会有歧义，加个逗号或者改用中文\n" +
        "cc棋盘 重看盘面 / cc认输 判对方赢 / cc结束 清盘\n" +
        "每手都会把盘面画成图发到群里，不私信。"
    );
}

function getGomokuCommand(event, raw_message) {
    const text = String(raw_message || "").trim();
    if (!text) return;
    if (text.includes("规则") || text === "帮助") return rulesCommand(event);
    if (text.includes("结束") || text.includes("清盘")) return endCommand(event);
    if (text.includes("认输") || text.includes("输了")) return resignCommand(event);
    if (text.includes("棋盘") || text.includes("盘面") || text.includes("看盘")) return boardCommand(event);
    if (text.includes("五子棋") || text.includes("开局") || text.includes("加入") || text.includes("上桌")) return startCommand(event);
    if (text.startsWith("下") || text.startsWith("落子") || /^[０-９\d]/.test(text) ||
        /^[一二三四五六七八九十]/.test(text)) return moveCommand(event, text);
    const game = games.get(event.group_id);
    return event.reply("【五子棋】没看懂「" + text.slice(0, 20) + "」。" + (game ? game.statusText() : "发 cc五子棋 开局，或 cc规则 看玩法。"));
}

module.exports = { getGomokuCommand, games, parseCoord };
