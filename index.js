import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import cluster from 'node:cluster';
import path from 'node:path';
import url from 'url';
import crypto from 'crypto';
import { ExJSB } from 'exjsb';

import config from "./config.json" with { type: "json" };
import EventEmitter from 'node:events';
let httpClient;

const __dirname = url.fileURLToPath(path.dirname(import.meta.url));
if (config.folder.includes("{THIS_DIR}")) config.folder = config.folder.replaceAll("{THIS_DIR}", __dirname);

function main() {
    console.clear();

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
                requestHeader[headerData[0].trim()] = headerData[1]?.trim();
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
            |       細化標頭       |
            ==================== */

            //定義各種變數
            const
                requestUrl = requestHead[1].split("?")[0].replace(/\/{2,}/gm, "/"),
                requestParameter = requestHead[1].split("?")[1],
                isUrlSlashed = requestUrl.endsWith("/"),
                isUpgrade = requestHeader["Upgrade"]?.toLowerCase() === "websocket";

            let
                pointUrl = requestUrl,
                pathArray = requestUrl.split("/").slice(0, isUrlSlashed ? -1 : undefined),
                isFile = undefined,
                routerList = ["index.mjs", "index.html"];


            /* ====================
            |     規則過濾替換     |
            ==================== */

            //TODO: 快取規則.

            //總規則籍
            let passfilterFull = [];

            //規則專屬檔案判斷
            const isFileForPassFilter = (() => { try { return fs.statSync(path.join(config.folder, pointUrl)).isFile() } catch { return undefined; } })();

            //遞歸掃描
            while (pathArray.length > 0) {
                (() => { try { return JSON.parse(fs.readFileSync(path.join(config.folder, pathArray.join("/"), ".passfilter"))); } catch { return []; } })().forEach(rule => {
                    passfilterFull.push({ ...rule, root: pathArray.join("/") });
                });
                pathArray.pop();
            }

            //開始逐一判斷規則
            for (const rule of passfilterFull) {
                //如果缺少關鍵要素就下一步
                if (!rule["action"]) continue;
                if (!rule["includes"]) continue;

                //includes的字串合集
                let includesToken = [];

                //開始拆解includes規則
                for (let name of rule["includes"]) {
                    const fixedPosition = name.startsWith("/");
                    const wildCards = name.match(/\*|\?/g) !== null;

                    if (fixedPosition) name = name.slice(1);

                    if (wildCards) includesToken.push({ type: "RegExp", Depth: name.split("/").length, content: new RegExp(name.replaceAll(".", "\\.").replace(/(?<!\\)\*/g, ".*").replace(/(?<!\\)\?/g, ".{1}"), "g"), fixedPosition });
                    else includesToken.push({ type: "String", Depth: name.split("/").length, content: name, fixedPosition });
                }

                //偵測旗標
                let findFilterFlag = false;

                //開始判斷
                for (const rulePackage of includesToken) {
                    //左匹配 或者 尾匹配
                    let leftMatch = false;

                    //當前目錄，不包含父目錄，因為父層不套用子規則
                    let lookupUrl = requestUrl.replace(rule["root"], "").split("/").filter(v => v !== "");
                    if (lookupUrl.length === 0) lookupUrl = [""];

                    //檢查是否是固定位置，是的話啟用左匹配
                    if (rulePackage.fixedPosition) leftMatch = true;

                    //如果是RegExp
                    if (rulePackage.type === "RegExp") {
                        if ((leftMatch && lookupUrl.slice(0, rulePackage.Depth).join("/") === ((lookupUrl.slice(0, rulePackage.Depth).join("/").match(rulePackage.content) ?? [])[0])) || (!leftMatch && lookupUrl.join("/").match(rulePackage.content))) {
                            findFilterFlag = true;
                            break;
                        }

                        //不是檔案的話則離開
                        if (isFileForPassFilter) continue;

                        //如果都沒有，則開始查找預設路由表
                        for (const i of routerList) {
                            const routerUrl = path.join(config.folder, requestUrl, i);
                            if (fs.existsSync(routerUrl) && !leftMatch && routerUrl.match(rulePackage.content)) {
                                findFilterFlag = true;
                                break;
                            }
                        }
                    }

                    //字串
                    else if (rulePackage.type === "String") {
                        //進行左匹配時，會自動切割到與標準RESTful的長度進行強匹配
                        if ((leftMatch && lookupUrl.slice(0, rulePackage.Depth).join("/") === rulePackage.content) || (!leftMatch && lookupUrl.join("/").includes(rulePackage.content))) {
                            findFilterFlag = true;
                            break;
                        }

                        //不是檔案的話則離開
                        if (isFileForPassFilter) continue;

                        //如果都沒有，則開始查找預設路由表
                        for (const i of routerList) {
                            const routerUrl = path.join(config.folder, requestUrl, i);
                            if (fs.existsSync(routerUrl) && !leftMatch && routerUrl.includes(rulePackage.content)) {
                                findFilterFlag = true;
                                break;
                            }
                        }
                    }

                    //給第二階段跳脫用的
                    if (findFilterFlag) break;
                }

                //如果旗標成立了
                if (findFilterFlag) {
                    switch (rule["action"]) {
                        case "pass":
                            break;
                        case "deny":
                            if (typeof rule["to"] === "number") { respondWithCode(rule["to"]); return; }
                            else if (typeof rule["to"] === "string") pointUrl = path.join(rule.root, rule["to"]);
                            else { respondWithCode(403); return; }
                            break;
                        case "forward":
                            if (typeof rule["to"] === "number") { respondWithCode(rule["to"]); return; }
                            else if (typeof rule["to"] === "string") pointUrl = path.join(rule.root, rule["to"]);
                            else { respondWithCode(500); return; }
                            break;
                        default:
                            break;
                    }

                    break;
                }
            }

            /* ====================
            |       路徑確認       |
            ==================== */

            //先尋找是否是檔案
            if (!isFile) try { isFile = fs.statSync(path.join(config.folder, pointUrl)).isFile() } catch { isFile = undefined };

            //尋找是否是.mjs檔案，是的話則導向
            if (!isFile && config.mjslife.EXT_DETECT && fs.existsSync(path.join(config.folder, `${pointUrl}.mjs`))) {
                pointUrl = `${pointUrl}.mjs`;
                isFile = true;
            };

            //如果尾端不是斜線，也不是檔案，就301導向到有斜線
            if (!isUrlSlashed && isFile === false) { respondWithCode(301, { "location": `${requestUrl}/${requestParameter ? "?" + requestParameter : ""}` }); return; }

            //定義目標檔案
            let targetFile = isFile ? null : (() => {
                //如果沒有檔案，也不是資料夾，則後推
                if (isFile === undefined) return null;

                //開始順序查找
                for (const i of routerList) {
                    if (fs.existsSync(path.join(config.folder, pointUrl, i))) return i;
                }
                isFile = undefined;
                return false;
            })();

            /* ====================
            |       標準處理       |
            ==================== */

            //定義標準檔案位置
            const filePath = path.join(config.folder, pointUrl, targetFile || "");

            //如果是連線 .passfilter，403
            if (isFile && filePath.endsWith(".passfilter")) { respondWithCode(403); return; };

            //如果找不到檔案，404
            if (isFile === undefined || !fs.existsSync(filePath)) { respondWithCode(404); return; };

            //如果走Websocket但是不支援他
            if(!config.mjslife.WEBSOCKET && isUpgrade) { respondWithCode(400); return; };

            //如果後綴是 .mjs，則觸發多線程沙箱，否則走主線程回報
            if (filePath.endsWith(".mjs") && isFile) { mjsProcess(filePath, requestIp, isUpgrade); return; }
            else if (!isUpgrade && !filePath.endsWith(".mjs")) { socket.unshift(dataBuffer); primary(socket, filePath); return; }
            else { respondWithCode(400); return; };


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
        function mjsProcess(filePath, ip, isUpgrade) {
            const mjsSendBox = cluster.fork();
            const mjsSendBoxId = mjsSendBox.id;

            if (mjsQueue.length === config.mjslife.MAX_REQUEST) { respondWithCode(429); return; }
            mjsQueue.push({ ip, filePath, id: mjsSendBox.id });

            let mjsTimeOut = isUpgrade ? null : setTimeout(() => {
                if (!mjsSendBox.isDead()) { mjsSendBox.process.kill("SIGKILL"); respondWithCode(504); }
                clearTimeout(mjsTimeOut);
            }, config.mjslife.MAX_LIFE_TIME * 1000 + 500);

            mjsSendBox.once("online", () => { mjsSendBox.send({ dataBase64: dataBuffer.toString("base64"), filePath }, socket); });
            mjsSendBox.once("message", (message, mjsSocket) => { if (message.status === "Error") respondWithCode(500, undefined, message.error.stack.replaceAll("\\n", "\n"), mjsSocket); });
            mjsSendBox.once("exit", (code) => { if (mjsTimeOut && !isUpgrade) { clearTimeout(mjsTimeOut) }; if (code === 0) { socket.emit("returnToNet") }; mjsQueue = mjsQueue.filter(v => v.ip !== ip && v.filePath !== filePath && v.id !== mjsSendBoxId); });

            return;
        }

        /* ====================
        |     net標題處理      |
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

            if (!statusCode[code]) code = 500;

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
    //(httpClient) ? httpClient : 
    socket.__filePath = filePath;
    httpClient = http.createServer(async (req, res) => {
        let httpSpecFilePath = req.socket.__filePath;

        //如果是Websocket就踢掉
        if (req.headers["upgrade"]?.toLowerCase() === "websocket") return;

        //.mjs，走沙箱，然後執行完就摧毀容器
        if (httpSpecFilePath.endsWith(".mjs") && cluster.isWorker) {
            const mjsRuntime = new ExJSB(httpSpecFilePath, false);
            await mjsRuntime.initialization((e) => { process.send({ status: "Error", error: { name: e.name, message: e.message, stack: e.stack, code: e.code } }, req.socket) });
            await mjsRuntime.run((e) => { process.send({ status: "Error", error: { name: e.name, message: e.message, stack: e.stack, code: e.code } }, req.socket) }, "main", req, res);
            mjsRuntime.destroy();
            process.exit(0);
        }
        //其餘業務走普通邏輯
        else {
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

    //WebSocket業務
    httpClient.on("upgrade", async (req, websocketSocket, head) => {
        if (!websocketSocket.__filePath.endsWith(".mjs")) { websocketSocket.destroy(); return; };

        //定義http位置
        let httpSpecFilePath = req.socket.__filePath;

        //先加密
        const websocketKey = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
        const cryptoKey = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}${websocketKey}`).digest("base64");

        //加密標頭
        const responseHeaders = [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${cryptoKey}`
        ].join("\r\n");

        //回應加密
        websocketSocket.write(`${responseHeaders}\r\n\r\n`);

        //res回應function
        function dataPackager(data) {
            //建立資料負載設定
            const isBuffer = Buffer.isBuffer(data);
            const payload = isBuffer ? data : Buffer.from(String(data), "utf8");
            const opCode = isBuffer ? 0x02 : 0x01;
            const packageSize = payload.length;

            //計算所需的老二長度
            let headerSize = 2;
            if (packageSize > 65535) headerSize = 10;
            else if (packageSize > 125) headerSize = 4;

            //建立回應用的 Buffer
            const responseBuffer = Buffer.alloc(headerSize + packageSize);

            //丟入第一段的 FIN + opCode
            responseBuffer[0] = 0x80 | opCode;

            //寫入第二段，老二長度預告
            if (packageSize <= 125) responseBuffer[1] = packageSize;
            else if (packageSize <= 65535) { responseBuffer[1] = 126; responseBuffer.writeUInt16BE(packageSize, 2); }
            else { responseBuffer[1] = 127; responseBuffer.writeBigUInt64BE(BigInt(packageSize), 2); }

            //寫入第三段，真正的老二
            payload.copy(responseBuffer, headerSize);

            //返回值
            return responseBuffer;
        }

        //建立特有res
        const res = {
            "write": (data) => {
                if (websocketSocket.destroyed || !websocketSocket.writable) return false;

                let responseBuffer = dataPackager(data);
                websocketSocket.write(responseBuffer);
                return true;
            }, "end": (data) => {
                if (websocketSocket.destroyed || !websocketSocket.writable) return false;

                if (data) {
                    let responseBuffer = dataPackager(data);
                    websocketSocket.write(responseBuffer);
                }

                websocketSocket.write(Buffer.from([0x88, 0x00]));
                websocketSocket.destroy();

                process.exit(0);
                return;
            }
        };

        //創建監聽器
        const wsData = new EventEmitter();

        //建立 MJS 執行環境
        const mjsRuntime = new ExJSB(httpSpecFilePath, false);
        await mjsRuntime.initialization((e) => { process.send({ status: "Error", error: { name: e.name, message: e.message, stack: e.stack, code: e.code } }, req.socket) });
        await mjsRuntime.run((e) => { process.send({ status: "Error", error: { name: e.name, message: e.message, stack: e.stack, code: e.code } }, req.socket) }, "websocket", wsData, req, res);

        //建立快取Buffer
        let cacheBuffer = Buffer.alloc(0);
        //房門鎖
        let ProcessingLock = false;

        //資料解析器
        async function dataProcesser() {
            //把房門上鎖開始🦌
            if (ProcessingLock) return;
            ProcessingLock = true;

            //建立一個嘗試區域，避免結束沒人開門
            try {
                while (cacheBuffer.length >= 2) {
                    //監聽第一組位元，最後一組切片
                    const isLastData = (cacheBuffer[0] & 0x80) !== 0;
                    //監聽第一組位元，類型
                    const opCode = cacheBuffer[0] & 0x0F;

                    //如果類型是 斷線(0x08)，則關閉連線，並摧毀個體
                    if (opCode === 0x08) {
                        websocketSocket.end();
                        websocketSocket.destroy();
                        process.exit(0);
                        return;
                    };

                    //監聽第二組位元，胸罩👍
                    const isMask = (cacheBuffer[1] & 0x80) !== 0;
                    //監聽第二組位元，預判老二長度👍
                    const payloadSize = cacheBuffer[1] & 0x7F;

                    //建立老二長度
                    let packageSize = (payloadSize <= 125) ? payloadSize : 0;

                    //老二之後的位置
                    let nextPos = 2;

                    //如果老二長度126，表示要擴充兩個區塊
                    if (payloadSize === 126) {
                        nextPos = 4;
                        //提前先判斷整個老二長度是否有到達要求
                        if (cacheBuffer.length < nextPos) return;
                        packageSize = Number(cacheBuffer.readUInt16BE(2));
                    } else if (payloadSize === 127) {
                        nextPos = 10;
                        //提前先判斷整個老二長度是否有到達要求
                        if (cacheBuffer.length < nextPos) return;
                        packageSize = Number(cacheBuffer.readBigUInt64BE(2));
                    }

                    let maskKey;
                    //有請求需要胸罩
                    if (isMask) {
                        //檢查是否有到達穿胸罩的標準
                        if (cacheBuffer.length < nextPos + 4) return;
                        //處理胸罩
                        maskKey = cacheBuffer.subarray(nextPos, nextPos + 4);
                        //下個老二的位置
                        nextPos += 4;
                    }

                    //整根老二還沒現形
                    if (cacheBuffer.length < nextPos + packageSize) return;

                    //整根老二現形了
                    const processingBuffer = cacheBuffer.subarray(nextPos, nextPos + packageSize);

                    //開始🦌管
                    let decodeBuffer = Buffer.alloc(packageSize);
                    //如果有穿胸罩，就用他🦌
                    if (isMask) {
                        for (let i = 0; i < packageSize; i++) { decodeBuffer[i] = processingBuffer[i] ^ maskKey[i % 4] }
                    } else {
                        //沒有就直接🦌
                        processingBuffer.copy(decodeBuffer);
                    }

                    //看一下新的老二
                    cacheBuffer = cacheBuffer.subarray(nextPos + packageSize);

                    //把🦌完的東西送別人處理
                    await packageProcess(decodeBuffer);
                }
            } finally {
                // 解鎖房門
                ProcessingLock = false; 
            }

            //處理新的老二
            async function packageProcess(data) {
                //暫時測試一下，看一下別人的老二
                wsData.emit('data', data);
            }
        }

        //監聽
        websocketSocket.on('data', (buffer) => {
            //推入快取
            cacheBuffer = Buffer.concat([cacheBuffer, buffer]);

            //如果停止處理，則呼叫
            dataProcesser();
            return;
        });
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