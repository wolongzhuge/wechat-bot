const fs = require("fs");
const path = require("path");

// 用相对路径写文件的话，胜率记录会落到「启动时的工作目录」，换个目录启动就等于清零
const RECORD_FILE = path.join(__dirname, "..", "data", "userRecords.json");

function readRecords() {
    try {
        return JSON.parse(fs.readFileSync(RECORD_FILE, "utf8"));
    } catch (err) {
        // 文件不存在或坏了都按新用户处理
        return {};
    }
}

class FileUtils {
    static recordResult(userName, isWin) {
        const userRecords = readRecords();

        // 更新用户记录
        if (!userRecords[userName]) {
            userRecords[userName] = {totalGames: 0, totalWins: 0};
        }
        userRecords[userName].totalGames++;
        if (isWin) {
            userRecords[userName].totalWins++;
        }

        // 计算胜率
        const winRate = userRecords[userName].totalWins / userRecords[userName].totalGames;

        // 保存用户记录
        if (!fs.existsSync(path.dirname(RECORD_FILE))) fs.mkdirSync(path.dirname(RECORD_FILE), { recursive: true });
        fs.writeFileSync(RECORD_FILE, JSON.stringify(userRecords), "utf8");

        // 返回结果
        return {
            totalGames: userRecords[userName].totalGames,
            totalWins: userRecords[userName].totalWins,
            winRate,
        };
    }


    // 榜单是发给群里看的，key 是 wxid，必须换成昵称才有人看得懂
    static getWinRate(nameOf) {
        const userRecords = readRecords();

        // 将用户记录转换为数组
        const recordsArray = Object.entries(userRecords);

        // 根据胜率进行排序
        recordsArray.sort((a, b) => {
            const winRateA = a[1].totalWins / a[1].totalGames;
            const winRateB = b[1].totalWins / b[1].totalGames;
            return winRateB - winRateA;
        });

        // 构造胜率信息字符串
        let result = '';
        for (const [userName, record] of recordsArray) {
            const winRate = record.totalWins / record.totalGames;
            const label = nameOf ? nameOf(userName) : userName;
            result += `${label}  总场数：${record.totalGames}  胜率：${winRate.toFixed(2)}\n`;
        }

        return result;
    }
}

module.exports = FileUtils;
