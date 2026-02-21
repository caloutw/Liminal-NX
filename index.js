import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import cluster from 'node:cluster';
import path from 'node:path';
import { ExJSB } from 'exjsb';

import config from "./config.json" with { type: "json" };
let httpClient;

function main() {
    /* ====================
    |         定義         |
    ==================== */

    //設定線程基礎設定
    cluster.setupPrimary({
        execArgv: [`--expose-gc`, `--experimental-vm-modules`, `--disable-warning=ExperimentalWarning`, `--max-old-space-size=${config.mjslife.MAX_RAM_SIZE}`]
    });
    

    //列隊
    let mjsQueue = [];
    let requestQueue = {};
    let bannedList = {};

    /* ====================
    |      建立伺服器      |
    ==================== */
    //Create TCP Server
    const netClient = net.createServer((socket) => {
        //建立Buffer
        let dataBuffer = Buffer.alloc(0);

        //連線用Function
        function connection(data) {
            /* ====================
            |     處理Head字串     |
            ==================== */
            dataBuffer = Buffer.concat([dataBuffer, data]);     //串接字串
            if (dataBuffer.length > config.connectlife.MAX_PACKAGE_SIZE) { respondWithCode(431); return; };   //超出上限就 431

            if (!dataBuffer.includes("\r\n\r\n")) return;  //如果沒有傳完就繼續

            //暫停socket傳輸，並且將資料塞回去
            socket.removeAllListeners("data");
            socket.pause();

            /* ====================
            |       拆解標頭       |
            ==================== */

            //拆解標頭
            let requestHeader = {};
            dataBuffer.toString("utf-8").trim().split("\n").slice(1).forEach(v => {
                const headerData = v.trim().split(":");
                requestHeader[headerData[0].trim()] = headerData[1].trim();
            });

            /* ====================
            |      檢查請求數      |
            ==================== */

            //IP
            const requestIp = requestHeader["Cf-Connecting-Ip"] ?? requestHeader["'X-Forwarded-For"] ?? socket.remoteAddress;

            //加入列隊
            if (!requestQueue[requestIp]) requestQueue[requestIp] = [];
            requestQueue[requestIp].push(Date.now());
            requestQueue[requestIp] = requestQueue[requestIp].filter(v => v > Date.now() - (config.connectlife.REQUSET_THRESHOLD_TIME_s * 1000));

            //如果超過閥值，則進入黑名單策略
            if (requestQueue[requestIp].length > config.connectlife.MAX_REQUEST_s) bannedList[requestIp] = Date.now() + (config.connectlife.BLOCK_TIME_s * 1000);

            //如果在黑名單中，就 429
            if (bannedList[requestIp] > Date.now()) { respondWithCode(429); return; }

            /* ====================
            |       檢查標頭       |
            ==================== */

            //拆解 raw request，有問題就 418
            const requestHead = dataBuffer.toString("utf-8").split("\n")[0].split(" ");
            if (requestHead.length !== 3) { respondWithCode(418); return; };

            //如果非標準方法，則阻擋
            if (!["GET", "POST", "HEAD", "PUT", "DELETE", "CONNECT", "OPTIONS", "TRACE", "PATCH"].includes(requestHead[0])) { respondWithCode(405); return; }

            /* ====================
            |       檢查路徑       |
            ==================== */

            //定義各種變數
            const
                requestUrl = requestHead[1].split("?")[0].replace(/\/{2,}/gm, "/"),
                requestParameter = requestHead[1].split("?")[1],
                isUrlSlashed = requestUrl.endsWith("/");
            let isFile = false;

            //先尋找是否是檔案，如果找不到，直接404
            try { if (fs.statSync(path.join(config.folder, requestUrl)).isFile()) isFile = true } catch { respondWithCode(404); return; };

            //如果尾端不是斜線，也不是檔案，就301導向到有斜線
            if (!isUrlSlashed && !isFile) { respondWithCode(301, { "location": `${requestUrl}/${requestParameter ? "?" + requestParameter : ""}` }); return; }

            //定義目標檔案
            let targetFile = isFile ? null : (() => {
                for (const i of ["index.mjs", "index.html"]) {
                    if (fs.existsSync(path.join(config.folder, requestUrl, i))) return i;
                }
                return false;
            })();

            //如果找不到檔案，404
            if (targetFile === false || (targetFile === null && !fs.existsSync(path.join(config.folder, requestUrl)))) { respondWithCode(404); return; };

            //定義標準檔案位置
            const filePath = path.join(config.folder, requestUrl, (targetFile === null ? "" : targetFile));

            /* ====================
            |       標準處理       |
            ==================== */

            //如果後綴是 .mjs，則觸發多線程沙箱，否則走主線程回報
            if (filePath.endsWith(".mjs") && isFile) { mjsProcess(filePath, requestIp); return; }
            else { socket.unshift(dataBuffer); primary(socket, filePath); return; };


            /* ====================
            |       純屬惡搞       |
            ==================== */

            //418
            respondWithCode(418);
            return;
        }

        /* ====================
        |      MJS處理器       |
        ==================== */
        //mjs 執行器
        function mjsProcess(filePath, ip) {
            const mjsSendBox = cluster.fork();
            const mjsSendBoxId = mjsSendBox.id;

            if (mjsQueue.length === config.mjslife.MAX_REQUEST) { respondWithCode(429); return; }
            mjsQueue.push({ ip, filePath, id: mjsSendBox.id });

            let mjsTimeOut = setTimeout(() => {
                if (!mjsSendBox.isDead()) { mjsSendBox.process.kill("SIGKILL"); respondWithCode(504); }
                clearTimeout(mjsTimeOut);
            }, config.mjslife.MAX_LIFE_TIME * 1000 + 500);

            mjsSendBox.once("online", () => { mjsSendBox.send({ dataBase64: dataBuffer.toString("base64"), filePath }, socket); });
            mjsSendBox.once("message", (message, mjsSocket) => { if (message.status === "Error") respondWithCode(500, undefined, message.error.stack.replaceAll("\\n", "\n"), mjsSocket); });
            mjsSendBox.once("exit", (code) => { if (mjsTimeOut) { clearTimeout(mjsTimeOut) }; if (code === 0) { socket.emit("returnToNet") }; mjsQueue = mjsQueue.filter(v => v.ip !== ip && v.filePath !== filePath && v.id !== mjsSendBoxId); });

            return;
        }

        /* ====================
        |      net標題處理     |
        ==================== */
        function respondWithCode(code, other = {}, content, otherSocket) {
            const lockedSocket = otherSocket ?? socket;
            if (!config.mjslife.ERROR_DISPLAY) content = undefined;
            if (content) other["Content-Length"] = content.length;

            const statusCode = {
                "200": "OK",
                "201": "Created",
                "204": "No Content",
                "301": "Moved Permanently",
                "302": "Found",
                "304": "Not Modified",
                "400": "Bad Request",
                "401": "Unauthorized",
                "403": "Forbidden",
                "404": "Not Found",
                "405": "Method Not Allowed",
                "409": "Conflict",
                "418": "I'm a teapot",
                "422": "Unprocessable Entity",
                "429": "Too Many Requests",
                "431": "Request Header Fields Too Large",
                "500": "Internal Server Error",
                "502": "Bad Gateway",
                "503": "Service Unavailable",
                "504": "Gateway Timeout"
            };

            if (typeof other !== "object") other = {};

            if (lockedSocket.writable && !lockedSocket.destroyed) {
                let messagePackage = [`HTTP/1.1 ${code} ${statusCode[code]}`];
                Object.keys(other).forEach(v => messagePackage.push(`${v}: ${other[v]}`));
                lockedSocket.write(`${messagePackage.join("\r\n")}\r\n\r\n${content ? content : ""}`);
                lockedSocket.end();
                lockedSocket.removeAllListeners("data");
            }

            return;
        }

        socket.on('error', () => { });
        socket.on('data', connection);
        socket.on("returnToNet", () => {
            socket.removeAllListeners("data");
            socket.removeAllListeners("drain");
            socket.removeAllListeners("end");
            socket.removeAllListeners("close");
            socket.removeAllListeners("timeout");
            socket.removeAllListeners("error");

            socket.setTimeout(0);

            dataBuffer = Buffer.alloc(0);
            socket.on('data', connection);
            socket.resume();
        });
    });


    /* ====================
    |      建立伺服器      |
    ==================== */
    netClient.listen(config.port, () => {
        console.log(`Server is running on port ${config.port}.`);
    });
}

function primary(socket, filePath) {
    socket.__filePath = filePath;
    httpClient = (httpClient) ? httpClient : http.createServer(async (req, res) => {
        let httpSpecFilePath = req.socket.__filePath;

        //如果是.mjs，走沙箱，然後執行完就摧毀容器
        if (httpSpecFilePath.endsWith(".mjs") && cluster.isWorker) {
            const mjsRuntime = new ExJSB(httpSpecFilePath, false);
            await mjsRuntime.initialization((e) => { process.send({ status: "Error", error: { name: e.name, message: e.message, stack: e.stack, code: e.code } }, req.socket) });
            await mjsRuntime.run((e) => { process.send({ status: "Error", error: { name: e.name, message: e.message, stack: e.stack, code: e.code } }, req.socket) }, "main", req, res);
            mjsRuntime.destroy();
            process.exit(0);
        } else {
            const ext = path.extname(httpSpecFilePath).toLowerCase();
            const mimeTypes = {
                '.html': 'text/html; charset=utf-8',
                '.htm': 'text/html; charset=utf-8',
                '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8',
                '.json': 'application/json; charset=utf-8',
                '.txt': 'text/plain; charset=utf-8',
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.gif': 'image/gif',
                '.svg': 'image/svg+xml',
                '.wav': 'audio/wav',
                '.mp4': 'video/mp4',
                '.mp3': 'audio/mpeg',
                '.webm': 'video/webm',
                '.ogg': 'audio/ogg',
                '.pdf': 'application/pdf',
                '.doc': 'application/msword',
                '.ejs': 'application/x-ejs',
                '.woff': 'application/font-woff',
                '.ttf': 'application/font-ttf',
                '.eot': 'application/vnd.ms-fontobject',
                '.otf': 'application/font-otf',
                '.wasm': 'application/wasm'
            };
            const contentType = mimeTypes[ext] || 'application/octet-stream';

            //設定標頭類型
            res.setHeader('Content-Type', contentType);

            //串流文件
            const file = fs.createReadStream(httpSpecFilePath, { highWaterMark: 1024 * 1024 });
            file.once("error", () => { if (!res.headersSent) { res.statusCode = 500; } res.end(); });
            file.pipe(res);

            //當檔案傳輸完畢，將掛載的socket傳回去給net
            res.once("finish", () => {
                if (req.socket?.destroyed || !req.socket) return;

                req.socket.emit("returnToNet");
            });
        }

        return;
    });

    httpClient.emit("connection", socket);
    process.nextTick(() => socket.resume());
}


if (cluster.isPrimary) main();
else if (cluster.isWorker) {
    process.once("message", (data, socket) => {
        socket.pause();
        socket.unshift(Buffer.from(data.dataBase64, 'base64'));
        primary(socket, data.filePath);
    });
}