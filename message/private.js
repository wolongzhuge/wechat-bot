"use strict";

const admin = require("../state/admin");
const { client } = require("../app");
require("dotenv").config();

const is_private_on = (process.env.private || "true") === "true";

// 解锁暗号：私信精确发这句，该微信号成为管理员（名单持久化在 data/admin.json）
const UNLOCK_PHRASE = "沐水智天下第一帅";

function handlePrivateEvent(event) {
    if (!is_private_on) return;

    let raw_message = "";
    const sender = event.sender.user_id;
    event.message.forEach((message) => {
        if (message.type === "text") raw_message += message.text;
    });

    if (!raw_message.trim()) return;

    // 在麻将桌上的人可以私聊回命令：碰不碰只私聊问，回答自然也得能私聊发。
    // 这一句必须排在管理员开关前面——关掉管理员模式时下面会直接 return，
    // 而且麻将的私聊回复要贴回群里（盘面给全桌看），不能顺着 event 走私聊。
    require("../command/mahjong/mahjongIndex").handlePrivateMessage(sender, raw_message)
        .then((handled) => { if (!handled) rest(event, sender, raw_message); })
        .catch((err) => console.error("私聊分发异常：" + err.message));
}

function rest(event, sender, raw_message) {
    const text = raw_message.trim();
    // 总开关在 command/admin/adminIndex.js（ENABLED）
    if (!require("../command/admin/adminIndex").isEnabled()) {
        console.log("管理员模式停用中，私聊忽略：" + client.displayName(sender));
        return;
    }

    if (text === UNLOCK_PHRASE) {
        if (admin.isAdmin(sender)) {
            event.reply("你已经在管理员模式里了。\n" +
                "cc 开头 = 操作电脑（读文件、跑命令、热更机器人），不带 cc = 只聊天。\n" +
                "cc退出 可以退出。");
        } else {
            admin.addAdmin(sender);
            event.reply("管理员模式已开启，只在私聊生效。\n" +
                "cc 开头 = 操作电脑（读文件、跑命令、热更机器人），不带 cc = 只聊天。\n" +
                "发 cc退出 退出管理员模式。");
        }
        return;
    }

    // 私聊只留给管理员终端：非管理员私信一律不回
    if (!admin.isAdmin(sender)) {
        console.log("私聊「" + client.displayName(sender) + "」不在管理员模式，忽略");
        return;
    }

    if (/^cc\s*退出(管理员(模式)?)?$/.test(text)) {
        admin.removeAdmin(sender);
        event.reply("已退出管理员模式，之后私聊不再处理。\n想再开就发暗号：" + UNLOCK_PHRASE);
        return;
    }

    require("../command/admin/adminIndex").handleAdminMessage(event, raw_message, sender);
}

// 处理器注册到钉住的分发器（热重载时重新注册即换槽位）
require("../dispatch").register("private", handlePrivateEvent);
