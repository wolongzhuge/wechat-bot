"use strict";

const SIZE = 15;
const EMPTY = 0, BLACK = 1, WHITE = 2;
const WIN_LENGTH = 5;

const COLOR_NAME = { [BLACK]: "黑棋", [WHITE]: "白棋" };

// 内部棋盘一律 0 基，对外（玩家看到的坐标）1 基
function key(row, col) {
    return row * SIZE + col;
}

class GomokuGame {
    constructor() {
        this.grid = new Array(SIZE * SIZE).fill(EMPTY);
        this.players = [];        // {id, name, color}
        this.moves = [];          // {row, col, color, playerId}
        this.turnColor = BLACK;   // 黑棋先手
        this.winner = null;       // {playerId, name, color}
        this.winLine = [];        // 五连的格子，画出来给人看
        this.started = false;
    }

    // 第一人是创建者，第二人加入即开局
    addPlayer(id, name) {
        if (this.players.length >= 2) return { ok: false, reason: "两个人已经齐了" };
        if (this.players.some((p) => p.id === id)) return { ok: false, reason: "你已经在这局里了" };
        this.players.push({ id, name, color: null });
        return { ok: true };
    }

    // 随机定黑白，黑先手；不随机就按加入顺序
    start(randomColor) {
        if (this.players.length < 2) return false;
        let order = this.players;
        if (randomColor && Math.random() < 0.5) order = [this.players[1], this.players[0]];
        order[0].color = BLACK;
        order[1].color = WHITE;
        this.turnColor = BLACK;
        this.started = true;
        return true;
    }

    playerById(id) {
        return this.players.find((p) => p.id === id);
    }

    playerByColor(color) {
        return this.players.find((p) => p.color === color);
    }

    current() {
        return this.playerByColor(this.turnColor);
    }

    // row/col 是玩家看到的 1 基坐标
    cellAt(row, col) {
        return this.grid[key(row - 1, col - 1)];
    }

    // 落子。row/col 是玩家看到的 1 起始坐标，内部转 0 基
    place(playerId, row, col) {
        if (!this.started) return { ok: false, hint: "这局还没开始，先让玩家都 cc五子棋 进来" };
        if (this.winner) return { ok: false, hint: "已经分出胜负了，发 cc结束 清盘后重开" };
        const player = this.playerById(playerId);
        if (!player) return { ok: false, hint: "你不在这局里，发 cc五子棋 加入" };
        if (player.color !== this.turnColor) {
            const cur = this.current();
            return { ok: false, hint: "还没轮到你，现在是 " + (cur ? cur.name : "?") + " 的" + COLOR_NAME[this.turnColor] + "走" };
        }
        if (!(row >= 1 && row <= SIZE && col >= 1 && col <= SIZE)) {
            return { ok: false, hint: "坐标要在 1~" + SIZE + " 之间，写「前列后行」，例如 cc1,2 = 第1列第2行" };
        }
        if (this.grid[key(row - 1, col - 1)] !== EMPTY) {
            return { ok: false, hint: "第" + col + "列第" + row + "行已经有子了，换一个位置" };
        }

        this.grid[key(row - 1, col - 1)] = player.color;
        this.moves.push({ row, col, color: player.color, playerId });
        const line = this.checkWin(row - 1, col - 1, player.color);
        if (line) {
            this.winner = { playerId, name: player.name, color: player.color };
            this.winLine = line.map(([r, c]) => ({ row: r + 1, col: c + 1 }));
        } else if (this.moves.length === SIZE * SIZE) {
            this.winner = { playerId: null, name: "没有人", color: null, draw: true };
        } else {
            this.turnColor = player.color === BLACK ? WHITE : BLACK;
        }
        return { ok: true, player, row, col };
    }

    // 四个方向数五连，返回连成的格子（0 基坐标）
    checkWin(row, col, color) {
        const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
        for (const [dr, dc] of dirs) {
            const line = [[row, col]];
            for (const sign of [1, -1]) {
                let r = row + dr * sign, c = col + dc * sign;
                while (r >= 0 && r < SIZE && c >= 0 && c < SIZE && this.grid[key(r, c)] === color) {
                    if (sign === 1) line.push([r, c]); else line.unshift([r, c]);
                    r += dr * sign;
                    c += dc * sign;
                }
            }
            if (line.length >= WIN_LENGTH) return line;
        }
        return null;
    }

    resign(playerId) {
        const player = this.playerById(playerId);
        if (!this.started) return { ok: false, hint: "还没开始，不用认输" };
        if (this.winner) return { ok: false, hint: "已经结束了" };
        if (!player) return { ok: false, hint: "你不在这局里" };
        const other = this.players.find((p) => p.id !== playerId);
        this.winner = { playerId: other.id, name: other.name, color: other.color };
        return { ok: true, player, other };
    }

    // 状态提示，每次都带上，省得人反复问
    statusText() {
        if (!this.started) {
            const have = this.players.length;
            return "【五子棋】还差 " + (2 - have) + " 个人：现在只有 " +
                (this.players.map((p) => p.name).join("、") || "没人") +
                "\n再拉一个人发 cc五子棋 就能开局。";
        }
        if (this.winner) {
            if (this.winner.draw) return "棋盘下满了，平局。发 cc结束 清盘。";
            return "【五子棋】" + this.winner.name + " 的" + COLOR_NAME[this.winner.color] + "五连获胜！共 " + this.moves.length + " 手\n发 cc结束 清盘，或 cc五子棋 重开。";
        }
        const cur = this.current();
        const last = this.moves[this.moves.length - 1];
        const vs = this.players.map((p) => p.name + "(" + COLOR_NAME[p.color] + ")").join("  对  ");
        return vs + "\n第 " + (this.moves.length + 1) + " 手，轮到 " + (cur ? cur.name : "?") + " 的" + COLOR_NAME[this.turnColor] +
            (last ? "（上一手：第" + last.col + "列第" + last.row + "行）" : "（黑先，请落第一子）") +
            "\n落子写「前列后行」：cc" + (last ? "3,4" : "8,8") + " = 第3列第4行，「下」可以省。";
    }
}

module.exports = { GomokuGame, SIZE, BLACK, WHITE, EMPTY, COLOR_NAME, key };
