function KFCvFiftyCommand(event, raw_message) {
    fetchData(raw_message.slice(0))
        .then(data => {
            console.log(data)
            event.reply(data.msg)
        })
        .catch()
}

function fetchData() {
    return fetch("https://api.52starxi.cn/api/kdj-w4/kfc.php?type=json")
        .then(response => response.json())
        .catch(error => {
            console.error('Error fetching data:', error);
        });
}


module.exports = {KFCvFiftyCommand};

