"use strict";
// 坐标走法：cc21 33 = 从「2 列 1 行」走到「3 列 3 行」。
// 一律「前列后行」（跟五子棋一致，也跟读图顺序一致：先看到边线上那个数）。
// 列和行都从自己这方数起 —— 列从右手边数第 1 列，行从自己底线数第 1 行，
// 盘面上自己这一侧那一圈同色的数字就是自己的坐标（红方看下面+右边，黑方看上面+左边）。
// 官方记谱（马五进三）照样能用；带进/退/平的文本由命令层送记谱解析，不归这里。

const CN_DIGIT = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
// 棋子名可以带在坐标前面当校验：cc马21 33
const PIECE_CHARS = ["车", "马", "炮", "兵", "卒", "相", "象", "仕", "士", "帅", "将"];
// 分隔符：空格、逗号、顿号、分号、破折号、箭头、「到/至」都当同一种分隔
const SEPS = /[，、,；;：:。.\-–—~～→至到\/|\s]+/g;
// 语气词/量词，让人能整句写：cc把2列1行的马走到3列3行
const FILLER = /[第从格路点位移动把子走落放上下个枚只条的]/g;
// 光一个数字（没跟配对的行/列）：用来给「只写了一半」的输入回更准的提示
const isAtom = (p) => /^\d$/.test(p) || /^[一二三四五六七八九十]$/.test(p);

// 「十」=10；「十八」这种超范围的不认（行最多 10、列最多 9）
function cnNumber(s) {
    if (!s) return null;
    if (CN_DIGIT[s] !== undefined) return CN_DIGIT[s];
    if (s === "十") return 10;
    return null;
}

// 从 i 起取 len 个字符当一个数；认不出来返回 null
function numAt(s, i, len) {
    const sub = s.slice(i, i + len);
    if (!sub || sub.length !== len) return null;
    if (/^\d+$/.test(sub)) return Number(sub);
    return cnNumber(sub);
}

// 一个坐标 = 列（必定 1 个字符，1~9）+ 行（1~2 个字符：1、10、「十」都算）
function coordHere(s, i) {
    const out = [];
    if (!/^[1-9一二三四五六七八九]$/.test(s[i] || "")) return out;
    const col = numAt(s, i, 1);
    for (const len of [1, 2]) {
        const row = numAt(s, i + 1, len);
        if (row === null || row < 1 || row > 10) continue;
        out.push({ col, row, next: i + 1 + len });
    }
    return out;
}

// 一段文字（中间没有分隔符）能完整切成 1 个或 2 个坐标的所有切法
function coordsOf(part) {
    const out = [];
    for (const a of coordHere(part, 0)) {
        if (a.next === part.length) out.push([a]);
        for (const b of coordHere(part, a.next)) {
            if (b.next === part.length) out.push([a, b]);
        }
    }
    return out;
}

// 各段候选切法做笛卡尔积，只留总坐标数正好 2 的
function combos(parts) {
    const lists = parts.map(coordsOf);
    if (lists.some((l) => !l.length)) return [];
    let acc = [[]];
    for (const list of lists) {
        const next = [];
        for (const pre of acc) {
            for (const cs of list) {
                if (pre.length + cs.length <= 2) next.push(pre.concat(cs));
            }
        }
        acc = next;
    }
    return acc.filter((c) => c.length === 2);
}

// 四段独立数字：cc2,10,3,3（第 10 行怕撞车就全用逗号分开）
function fourNumbers(parts) {
    if (parts.length !== 4) return null;
    const v = parts.map((p) => (/^\d{1,2}$/.test(p) ? Number(p) : cnNumber(p)));
    if (v.some((n) => n === null || n < 1)) return null;
    if (v[0] > 9 || v[2] > 9 || v[1] > 10 || v[3] > 10) return null;
    return [{ col: v[0], row: v[1] }, { col: v[2], row: v[3] }];
}

const keyOf = (sols) => sols.map((s) => s.map((c) => c.col + "," + c.row).join(";")).join("|");

// 每段各自是完整坐标的正规切法；一个都没有时允许把相邻两段粘起来
// （「2,1,33」粘成「21 / 33」），因为有人就是爱把列和行分开写
function solve(parts) {
    const direct = combos(parts);
    if (direct.length) return direct;
    const merged = [];
    for (let i = 0; i < parts.length - 1; i++) {
        const joined = parts.slice(0, i).concat(parts[i] + parts[i + 1], parts.slice(i + 2));
        merged.push(...combos(joined));
    }
    const uniq = [];
    const seen = new Set();
    for (const s of merged) {
        const k = s.map((c) => c.col + "," + c.row).join(";");
        if (!seen.has(k)) { seen.add(k); uniq.push(s); }
    }
    return uniq;
}

const fmt = (c) => c.col + "列" + c.row + "行";
const EXAMPLE = "cc21 33 = 从 2 列 1 行走到 3 列 3 行（前列后行，列从自己右手边数、行从自己底线数）；" +
    "空格/逗号/顿号都算分隔，中文数字也认（cc二一三三）；第 10 行怕撞车就全分开写 cc2,10,3,3";

// 主入口：返回 {from:{col,row}, to:{col,row}, piece:棋子名|null} 或 {bad:"原因"}
function parseCoordMove(text) {
    const original = String(text || "").trim();
    let t = original.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
    let piece = null;
    const hit = PIECE_CHARS.find((ch) => t.includes(ch));
    if (hit) {
        piece = hit;
        t = t.replace(hit, " ");
    }
    t = t.replace(/[列行]/g, ",").replace(SEPS, ",").replace(FILLER, "").replace(/,{2,}/g, ",").replace(/^,+|,+$/g, "");
    if (!t) return { bad: "没给坐标。写法：" + EXAMPLE };
    const parts = t.split(",").filter(Boolean);
    if (!parts.length) return { bad: "没给坐标。写法：" + EXAMPLE };

    const four = fourNumbers(parts);
    const sols = four ? [four] : solve(parts);
    if (!sols.length) {
        if (parts.every(isAtom)) {
            return { bad: "只给了 " + parts.length + " 个数字，坐标要 4 个数：起点列、起点行、终点列、终点行。写法：" + EXAMPLE };
        }
        return { bad: "「" + original.slice(0, 20) + "」拆不出两个坐标。写法：" + EXAMPLE };
    }
    if (sols.length > 1) {
        const a = sols[0], b = sols[1];
        return { bad: "连写能切成好几种：" + fmt(a[0]) + "→" + fmt(a[1]) + "，或者 " + fmt(b[0]) + "→" + fmt(b[1]) +
            "。中间加个逗号或顿号就行，如 " + a[0].col + "," + a[0].row + " " + a[1].col + "," + a[1].row };
    }
    const [from, to] = sols[0];
    if (from.col === to.col && from.row === to.row) return { bad: "起点和终点同一格，得真的走一步" };
    return { from, to, piece };
}

module.exports = { parseCoordMove, fmt, EXAMPLE, cnNumber, PIECE_CHARS };
