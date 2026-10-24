"use strict";

const { client } = require("../app");
const { modeMap, gameMaps } = require("../state/store");
const { getDouCommand } = require("../command/dou/douIndex");
const { getGomokuCommand } = require("../command/gomoku/gomokuIndex");
const { getXiangqiCommand } = require("../command/xiangqi/xiangqiIndex");
const { getUnoCommand } = require("../command/uno/unoIndex");
const { getJunqiCommand } = require("../command/junqi/junqiIndex");
const { getMahjongCommand } = require("../command/mahjong/mahjongIndex");
const { getSmallCommand } = require("../command/small/smallIndex");
const gameMap = gameMaps.dou;
require("dotenv").config();

// AI 只留在私聊（见 message/private.js），群里不再有 gpt 模式
const DEFAULT_MODE = "斗地主";
const MODES = ["斗地主", "五子棋", "象棋", "军棋", "麻将", "UNO", "小功能"];
// 微信里 @ 机器人显示的是"@机器人群昵称 "，前缀要清掉
const triggerPrefixes = (process.env.trigger_prefix || "").split(",").map((s) => s.trim()).filter(Boolean);

function handleGroupEvent(event) {
    if ((process.env.group || "false") !== "true") return;

    const room = event.group_id;
    if (!modeMap.has(room)) modeMap.set(room, DEFAULT_MODE);

    let raw_message = "";
    event.message.forEach((message) => {
        if (message.type === "text") raw_message += message.text;
    });

    raw_message = stripAtName(raw_message, event);
    if (!raw_message) return;

    // # 命令既可以直接发（#帮助），也可以带触发前缀发（cc#帮助），所以两处都要认
    if (raw_message.startsWith("#")) return handleSharp(raw_message.slice(1).trim(), event);

    const isTriggered = event.atme || triggerPrefixes.some((p) => raw_message.startsWith(p));
    if (!isTriggered) {
        console.log("群「" + client.displayName(room) + "」消息没触发（既没 @机器人 也没 " +
            (triggerPrefixes[0] || "cc") + " 前缀）: " + JSON.stringify(raw_message.slice(0, 30)));
        return;
    }
    for (const p of triggerPrefixes) {
        if (raw_message.startsWith(p)) {
            raw_message = raw_message.slice(p.length).trim();
            break;
        }
    }
    if (raw_message.startsWith("#")) return handleSharp(raw_message.slice(1).trim(), event);

    // 管理员终端只在私聊生效（2026-10-24）：群里管理员的消息和普通人一样走群模式，
    // 不然在群里随手一句话就把机器人当电脑操作，太危险。

    const mode = modeMap.get(room);
    if (mode === "斗地主") {
        getDouCommand(event, raw_message);
    } else if (mode === "五子棋") {
        getGomokuCommand(event, raw_message);
    } else if (mode === "象棋") {
        getXiangqiCommand(event, raw_message);
    } else if (mode === "UNO") {
        getUnoCommand(event, raw_message);
    } else if (mode === "军棋") {
        getJunqiCommand(event, raw_message);
    } else if (mode === "麻将") {
        getMahjongCommand(event, raw_message);
    } else if (mode === "小功能") {
        getSmallCommand(event, raw_message);
    }
}

// 处理器注册到钉住的分发器（热重载时重新注册即换槽位）
require("../dispatch").register("group", handleGroupEvent);

function handleSharp(command, event) {
    const room = event.group_id;
    const prefix = triggerPrefixes[0] || "cc";

    if (command === "帮助" || command.startsWith("帮助 ")) {
        const wanted = command.replace(/^帮助\s*/, "").trim();
        if (wanted) {
            event.reply(MODES.includes(wanted) ? ruleText(wanted) : "没这个模式，可查：" + MODES.join(" / "));
            return;
        }
        event.reply(
            "当前模式：" + (modeMap.get(room) || DEFAULT_MODE) + "\n" +
            "可切换：" + MODES.map((m) => "#" + m).join("  ") + "\n" +
            "看某个模式的玩法：#帮助 五子棋\n" +
            "查当前模式：#模式\n" +
            "命令用 " + prefix + " 开头最稳（@" + (event.client.ourName || "机器人") + " 有时识别不到）"
        );
        return;
    }

    if (command === "模式" || command === "当前模式") {
        const mode = modeMap.get(room) || DEFAULT_MODE;
        event.reply("当前模式：" + mode + "\n" + ruleText(mode));
        return;
    }

    if (!MODES.includes(command)) {
        event.reply("不存在该模式，可切：" + MODES.map((m) => "#" + m).join("  ") + "，或发 #帮助");
        return;
    }

    // 切模式会把牌局状态留在原地没人接手，正在打的时候必须先结束
    const running = runningGame(room);
    if (running && command !== running) {
        event.reply("本群 " + running + " 还在进行中，先 " + prefix + "结束 再切到" + command + "，不然牌局会丢。");
        return;
    }

    modeMap.set(room, command);
    event.reply("切换到" + command + "模式成功\n" + ruleText(command));
}

// 这个群里还有没有没打完的局（等人上桌的阶段不算，那种随时可以散）
function runningGame(room) {
    const dou = gameMap.get(room);
    if (dou && dou.status >= 1 && !dou.gameOver) return "斗地主";
    const gomoku = gameMaps.gomoku.get(room);
    if (gomoku && gomoku.started && !gomoku.winner) return "五子棋";
    const xiangqi = gameMaps.xiangqi.get(room);
    if (xiangqi && xiangqi.started && !xiangqi.winner) return "象棋";
    const uno = gameMaps.uno.get(room);
    if (uno && uno.started && !uno.gameOver) return "UNO";
    const junqi = gameMaps.junqi.get(room);
    if (junqi && junqi.started && !junqi.winner) return "军棋";
    const mahjong = gameMaps.mahjong.get(room);
    // 麻将桌只有「开了局」才算在打，光上桌坐着随时可以散
    if (mahjong && mahjong.phase !== "lobby") return "麻将";
    return null;
}

function ruleText(mode) {
    if (mode === "五子棋") {
        return "【五子棋】两个人就能玩，先五连者胜\n" +
            "cc五子棋 开局（随机黑白，黑棋先手）\n" +
            "cc3,8 在「第3列第8行」落子——列在前、行在后，「下」不用打\n" +
            "cc38 / cc3 8 / cc3-8 / cc3列8行 / cc三八 都认；连写分不清就用中文，cc一十三 = 1 列 13 行\n" +
            "cc棋盘 重看盘面 / cc认输 判对方赢 / cc结束 清盘\n" +
            "每一步都会在群里贴出盘面和最后一手";
    }
    if (mode === "象棋") {
        return "【象棋】两个人就能玩，红先黑后，将死对方为胜\n" +
            "cc象棋 开局（随机定红黑，红先走）\n" +
            "走子写坐标，前列后行：cc21 33 = 从2列1行走到3列3行\n" +
            "　列从自己右手边数、行从自己底线数（盘面上自己那侧的同色数字）\n" +
            "　空格/逗号/顿号都行：cc21,33、cc21、33；中文也认：cc二一三三；\n" +
            "　第10行怕撞车就全分开：cc2,10,3,3；想指定子可以写 cc马21 33\n" +
            "官方记谱照样能用：cc马五进六 / cc炮二平五 / cc前马进三\n" +
            "cc棋盘 看盘面 / cc认输 认负 / cc结束 清盘\n" +
            "每一步都会在群里贴出盘面，玩法看 cc规则";
    }
    if (mode === "军棋") {
        return "【军棋】两个人就能玩，暗棋，机器人当裁判\n" +
            "cc军棋 上桌（先来的是红方先走），再拉一人发 cc军棋\n" +
            "cc布阵 随机摆一版（阵图私聊发你），cc换位 B12 C12 微调\n" +
            "两人都布好自动开打，红先\n" +
            "走子：cc走B7-C7（起点-终点，列 A~E、行 1~12，蓝在上 1~6，红在下 7~12）\n" +
            "cc棋盘 看盘面 / cc战报 看亮子 / cc状态 看轮到谁 / cc认输 / cc结束 清盘\n" +
            "大吃小、同级同归、炸弹同归、工兵挖雷、行营免吃、进大本营锁死；扛旗或对方无子可走即胜";
    }
    if (mode === "麻将") {
        return "【麻将】1~3 个真人上桌，机器人补满四家，默认日麻\n" +
            "cc麻将 上桌 → cc开局 发牌（人不够机器人补齐，随时能开）\n" +
            "出牌：cc + 牌名（cc5m、cc五万 都认）；立直和出牌一起发：cc5m立直\n" +
            "副露：cc碰 / cc吃34 / cc杠 / cc暗杠五筒 / cc补杠五筒；不想动 ccp\n" +
            "和牌：别人打的那张发 cc和，自己摸到发 cc自摸\n" +
            "碰不碰、和不和只私聊问那一家，私聊回、群里回都算数\n" +
            "换玩法：cc模式 日麻 / 血战 / 广东（血战要先 cc缺万 定缺）\n" +
            "你的手牌私聊发你（要先加机器人为好友），群里只贴牌河盘面图\n" +
            "cc棋盘 看盘面 / cc状态 看轮到谁 / cc点数 / cc战报 / cc下一局 / cc结束";
    }
    if (mode === "斗地主") {
        return "【斗地主】需要三个人\n" +
            "cc斗地主 开桌 / cc上桌 加入，满三人自动发牌（牌私聊发，要先加机器人为好友）\n" +
            "cc抢 或 cc不 表态：谁先抢谁当地主，三张底牌归地主，地主先出\n" +
            "cc334455 出牌 / cc过 不要 / cc状态 看轮到谁 / cc投降\n" +
            "B=大王 S=小王 X=10";
    }
    if (mode === "UNO") {
        return "【UNO】2-4 人玩，先出完手牌者胜\n" +
            "ccuno 上桌（第一个开桌的是房主，最多 4 人），房主发 cc开始 开局\n" +
            "手牌私聊发（要先加机器人为好友），出牌在群里\n" +
            "cc出红5 / cc出跳过 / cc出+2，同色或同数字都能接\n" +
            "cc万能 蓝 / cc出+4 红：变色，+4 还罚下家摸 4 张\n" +
            "跳过=下家停一轮；反转=方向掉头（两人局等于跳过）\n" +
            "没得打 cc摸（摸到能出的可以打），不想出 cc过\n" +
            "cc状态 看牌局 / cc手牌 重看自己的牌 / cc投降 认负 / cc结束 散桌";
    }
    if (mode === "小功能") {
        return "【小功能】搜歌xx / 选歌N / 发病xx / 肯德基 / 天气 城市 / 热更";
    }
    return "";
}

function stripAtName(text, event) {
    // 去掉行首的 @某人（微信的 @ 在文本里就是 "@昵称 " 且后面跟一个 \u2005 空格）
    let out = text.replace(/^@[\s\S]{1,40}?[\s\u2005\u00a0]/, "");
    const c = event && event.client;
    // 机器人自己的 wxid 和群昵称都可能出现，昵称里可能带 ( . 等正则元字符，要先转义
    for (const name of [c && c.ourWxid, c && c.ourName]) {
        if (!name) continue;
        out = out.replace(new RegExp("^@" + String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*"), "");
    }
    return out.trim();
}
