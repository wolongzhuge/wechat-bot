"use strict";
// 发送队列的限速行为：令牌桶要允许小突发（几个群同时各回一条得一口气发完），
// 但平均速率、同一目标最小间隔、严禁并发这三条不能被突发破坏。
const { WeChatClient } = require("../wechat/client");

const BOT = "wxid_self_0001";
let failures = 0;

function check(name, ok, detail) {
    if (ok) console.log("  ok  " + name);
    else { failures++; console.log("  FAIL " + name + (detail ? " —— " + detail : "")); }
}

// 假服务端：只记录每次发送落地的时刻，顺带盯住「同一时刻只允许一条在飞」
function fakeClient(rateLimit) {
    const log = [];
    let active = 0;
    let maxActive = 0;
    const c = new WeChatClient({ baseUrl: "http://127.0.0.1:1", wxid: BOT, timeout: 500, rateLimit });
    c._request = async (method, apiPath) => {
        if (apiPath !== "/Msg/SendTxt") throw new Error("不该被调用: " + apiPath);
        active++;
        if (active > maxActive) maxActive = active;
        await new Promise((r) => setTimeout(r, 20));
        active--;
        log.push({ at: Date.now() });
        return { Code: 0, Success: true };
    };
    return { client: c, log, maxActive: () => maxActive };
}

async function main() {
    // 场景一：6 个不同群同时各一条，桶容量 3、平均 60 条/分钟（每 1s 补 1 个令牌）
    // → 前 3 条靠突发额度立刻走，后面每条约等 1s 补令牌
    const a = fakeClient({ perMinute: 60, burst: 3, privateMs: 0, groupMs: 0 });
    const t0 = Date.now();
    await Promise.all([1, 2, 3, 4, 5, 6].map((i) => a.client.sendText("r" + i + "@chatroom", "x" + i)));
    const gaps = a.log.map((s) => s.at - t0);
    check("6 条全部发出，一条不丢", a.log.length === 6, JSON.stringify(gaps));
    check("前 3 条走突发额度，不排队", gaps[2] < 300, "第 3 条 " + gaps[2] + "ms");
    check("第 4 条开始按平均速率等令牌", gaps[3] - gaps[2] >= 700,
        "第 3→4 条间隔 " + (gaps[3] - gaps[2]) + "ms");
    check("发送接口全程串行", a.maxActive() === 1, "最多同时在飞 " + a.maxActive() + " 条");

    // 场景二：同一个群连发，突发额度再足也要守住群间隔
    const b = fakeClient({ perMinute: 600, burst: 10, privateMs: 0, groupMs: 250 });
    const tb = Date.now();
    await Promise.all([1, 2, 3].map(() => b.client.sendText("same@chatroom", "y")));
    const bgaps = b.log.map((s) => s.at - tb);
    check("同一群相邻两条守住 groupMs", bgaps[1] >= 250 && bgaps[2] - bgaps[1] >= 250, JSON.stringify(bgaps));
    check("不同目标不受这条约束（对照场景一）", a.log.length === 6);

    // 场景三：一条发送失败不能把队卡住，而且失败的那条照样占一次额度
    const c = fakeClient({ perMinute: 60, burst: 1, privateMs: 0, groupMs: 0 });
    const order = [];
    const tStart = Date.now();
    c.client._request = async (method, apiPath, body) => {
        order.push({ at: Date.now() - tStart });
        if (body && body.ToWxid === "bad@chatroom") throw new Error("模拟发送被拒");
        if (apiPath === "/Msg/SendTxt") return { Code: 0, Success: true };
        throw new Error("不该被调用: " + apiPath);
    };
    const results = await Promise.all([
        c.client.sendText("bad@chatroom", "坏的一条").then(() => "已发", () => "报错"),
        c.client.sendText("r2@chatroom", "后一条").then(() => "已发", () => "报错"),
    ]);
    check("失败的那条把错误抛给调用方，后面的照样发出去",
        results[0] === "报错" && results[1] === "已发", JSON.stringify(results));
    check("失败同样占用一次发送额度（不然一直报错会瞬间打满接口）",
        order.length === 2 && order[1].at - order[0].at >= 700,
        "两次调用相隔 " + (order.length > 1 ? order[1].at - order[0].at : "-") + "ms");

    console.log(failures ? "有 " + failures + " 项不通过" : "全部通过：小突发 / 平均速率 / 同目标间隔 / 串行 / 失败不卡队");
    process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
