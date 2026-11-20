/*
------------------------------------------
@Author: sm
@Date: 2026.06.09
@Description: 腾讯地图 签到领现金/现金余额查询
cron: 18 8 * * *
------------------------------------------
【抓包直连模式（推荐，无需 wx_server 中转服务）】
变量名：txdt
变量值：openid#user_id#session_id#map_session_id[#备注]
  - 抓包方式：微信里打开腾讯地图小程序，用 Reqable 抓
    POST https://miniapp.map.qq.com/minLogin/v2/login 的响应（err_code=0 那条），
    从 data 里取出 openid / user_id / session_id / map_session_id 四个字段，按上面顺序拼成一行。
  - 也支持 JSON（字段名兼容 openid/user_id/session_id/map_session_id，或驼峰 openId/userId/sessionId/mapSessionId）：
    {"openid":"xxx","user_id":"xxx","session_id":"xxx","map_session_id":"xxx","remark":"备注"}
  - 也支持直接填 /minLogin/v2/login 响应的整个 data JSON（脚本会按上面的字段自动提取）。
  - map_session_id 若无则留空（openid#user_id#session_id 三段也可）。
  - 多账号用 & 或换行分隔。
  - 凭证有效期未知，报 AUTH/登录失效时重抓一次即可，无需改脚本。

【中转模式（原有逻辑，需自建 wx_server）】
变量值：仅 openid 时走中转模式，需配下面两个全局变量：
wx_server_url  默认 http://192.168.31.196:8787
wx_auth        必填，wx_server 鉴权值
------------------------------------------
*/

const { Env } = require("../tools/env.js");
const $ = new Env("腾讯地图");
const axios = require("axios");
const crypto = require("crypto");

const CK_NAME = "txdt";
const APP = { name: "腾讯地图", appid: "wx7643d5f831302ab0", version: 545 };
const WX_SERVER_URL = (process.env.wx_server_url || "http://192.168.31.196:8787").replace(/\/$/, "");
const WX_AUTH = process.env.wx_auth || "";
const MINI_LOGIN_BASE = "https://miniapp.map.qq.com";
const MAP_BASE = "https://mmapgwh.map.qq.com";
const LOGIN_ACCESS_KEY = "1";
const LOGIN_SECRET_KEY = "4300eec60bedec22a73408a0d76b03ec";
const TMAP_SECRET = "3a9875e795c3ecff15f617085e72d4cc";
const CHECKIN_TOKEN = "e643d512f085d621bf6c9e80310d0498";
const ACTIVITY_ID = 1721983577;
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MicroMessenger/3.9.12 MiniProgramEnv/Windows WindowsWechat/WMPF";

function splitAccounts(value = "") {
    return String(value)
        .split(/\n|&/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function short(value, max = 320) {
    if (value === undefined || value === null) return "";
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

// 账号标识脱敏：只保留前6后4，避免 openid 明文落日志
function mask(v) {
    const s = String(v || "");
    if (!s) return "未知";
    return s.length <= 10 ? s.replace(/./g, "*") : `${s.slice(0, 6)}****${s.slice(-4)}`;
}

function md5(value) {
    return crypto.createHash("md5").update(String(value)).digest("hex");
}

function sha256(value) {
    return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function uuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
        const n = (Math.random() * 16) | 0;
        return (char === "x" ? n : (n & 3) | 8).toString(16);
    });
}

function sortedQuery(data) {
    const normalized = {};
    Object.keys(data)
        .sort()
        .forEach((key) => {
            if (data[key] !== undefined && data[key] !== null) normalized[key] = data[key];
        });
    return Object.keys(normalized)
        .map((key) => `${key}=${normalized[key]}`)
        .join("&");
}

function formatCoin(value) {
    const num = Number(value || 0);
    return `${num}(${(num / 100).toFixed(2)})`;
}

function pick(data, ...keys) {
    for (const key of keys) {
        if (data[key] !== undefined && data[key] !== null && data[key] !== "") return data[key];
    }
    return "";
}

function parseAccount(raw) {
    const text = String(raw || "").trim();
    if (!text) return {};
    if (text.startsWith("{")) {
        // 支持两种 JSON：
        //   1) 精简凭证 {"openid","user_id","session_id","map_session_id"}
        //   2) /minLogin/v2/login 响应的整个 data（字段更多，自动提取可用的）
        const data = JSON.parse(text);
        const nested = data.data && typeof data.data === "object" ? data.data : data;
        // 只有当 JSON 里带登录凭证字段时，才走直连；否则视为旧式仅 openid 的中转配置
        const userId = pick(nested, "user_id", "userId");
        const sessionId = pick(nested, "session_id", "sessionId");
        if (userId || sessionId) {
            return {
                raw: text,
                direct: true,
                openid: String(pick(nested, "openid", "openId") || ""),
                user_id: String(userId || ""),
                session_id: String(sessionId || ""),
                map_session_id: String(pick(nested, "map_session_id", "mapSessionId") || ""),
                remark: String(pick(nested, "remark", "name") || ""),
            };
        }
        return { raw: text, openid: String(pick(nested, "openid", "openId") || ""), remark: String(pick(nested, "remark", "name") || "") };
    }
    const parts = text.split("#").map((item) => item.trim());
    // 抓包直连：openid#user_id#session_id#map_session_id[#备注]（至少 3 段）
    if (parts.length >= 3) {
        return {
            raw: text,
            direct: true,
            openid: parts[0] || "",
            user_id: parts[1] || "",
            session_id: parts[2] || "",
            map_session_id: parts[3] || "",
            remark: parts[4] || "",
        };
    }
    const [openid, remark] = parts;
    return { raw: text, openid: openid || "", remark: remark || "" };
}

async function request(options) {
    const res = await axios.request({
        timeout: 20000,
        validateStatus: () => true,
        ...options,
        headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json, text/plain, */*",
            Referer: `https://servicewechat.com/${APP.appid}/${APP.version}/page-frame.html`,
            ...(options.headers || {}),
        },
    });
    return { status: res.status, headers: res.headers || {}, data: res.data };
}

async function getWxCode(openid) {
    const { status, data } = await request({
        method: "POST",
        url: `${WX_SERVER_URL}/wx/code`,
        headers: {
            auth: WX_AUTH,
            ...(WX_AUTH ? { Authorization: `Bearer ${WX_AUTH}` } : {}),
            "content-type": "application/json",
        },
        // 兼容 smallcat({appid,openid}) 与 yyb-go 等({app_id,ref})
        data: { appid: APP.appid, openid, app_id: APP.appid, ref: openid },
    });
    // 兼容多种取码服务返回结构：
    //   smallcat : {code} / {data:{code}}
    //   yyb-go   : {code:0, data:{openid, result:{code, errMsg}}}
    //   早期mock : {result:{code}}
    const code = data?.data?.result?.code || data?.data?.code || data?.code || data?.result?.code;
    if (status !== 200 || !code) {
        throw new Error(`获取code失败 HTTP ${status}: ${short(data)}${WX_AUTH ? "" : "（未配置 wx_auth）"}`);
    }
    return code;
}

function loginSign({ appId, sessionId = "-1", openId, userId, postBody }) {
    const reqId = md5(`${Math.random()} ${Date.now()}`);
    const reqTime = Date.now().toString().slice(0, 10);
    const signParams = {
        appId,
        reqId,
        reqTime,
        userId,
        openID: openId,
        sessionID: sessionId,
        accessKey: LOGIN_ACCESS_KEY,
        businessStr: JSON.stringify(postBody),
    };
    const signText = `${sortedQuery(signParams)}&secretKey=${LOGIN_SECRET_KEY}`;
    const headers = {
        "mapservice-sign-version": "v2",
        "mapservice-sign": sha256(signText),
        "mapservice-reqid": reqId,
        "mapservice-reqtime": reqTime,
        "mapservice-appid": appId,
        "mapservice-accesskey": LOGIN_ACCESS_KEY,
        "mapservice-sessionid": sessionId,
    };
    if (sessionId && sessionId !== "-1") {
        headers["mapservice-openid"] = openId;
        headers["mapservice-userid"] = userId;
    }
    return headers;
}

function mapH5Sign(apiPath, user) {
    const reqId = uuid();
    const reqTime = Date.now();
    const normalizedPath = apiPath.split("?")[0];
    const signBase = `mapinst=0&mapnonce=0&reqid=${reqId}&reqtime=${reqTime}`;
    const defaultSign = md5(`${signBase}${normalizedPath}0${TMAP_SECRET}`);
    const headers = {
        "tmap-reqid": reqId,
        "tmap-reqtime": reqTime,
        "tmap-userid": Number(user.user_id) || Number(user.userId) || 0,
        "tmap-login-ssid": user.session_id || user.sessionId || 0,
        "tmap-imei": 0,
        "tmap-qimei": 0,
        "tmap-qimei36": 0,
        "tmap-nonce": 0,
        "tmap-install-id": 0,
        "tmap-sign": 0,
        "tmap-default-sign": defaultSign,
        "tmap-app-version": 0,
        "tmap-channel": 0,
        "tmap-engine": "web",
        "tmap-mini-login-ssid": user.map_session_id || user.mapSessionId || "",
        "tmap-app-id": user.appId || APP.appid,
    };
    if (user.openid || user.openId) headers["tmap-openid"] = user.openid || user.openId;
    return headers;
}

function checkinHeader(user) {
    const requestId = uuid();
    const timestamp = Math.floor(Date.now() / 1000);
    const signText = `request_id=${requestId}&from_source=${APP.appid}&timestamp=${timestamp}&token=${CHECKIN_TOKEN}`;
    return {
        user_id: user.openid || user.openId,
        from_source: APP.appid,
        request_id: requestId,
        timestamp,
        sign: sha256(signText).toUpperCase(),
    };
}

class TencentMap {
    constructor(rawAccount, index) {
        this.index = index;
        this.account = parseAccount(rawAccount);
        this.loginInfo = {};
        this.userInfo = {};
    }

    async miniLogin() {
        // 优先中转模式：配置了 wx_server_url（已换成动态 code 服务）时，每次运行动态登录，凭证永不过期
        // 抓包直连仅作为未配置中转服务时的兜底
        const useRelay = !!(process.env.wx_server_url && this.account.openid);
        if (useRelay) {
            if (!this.account.openid) throw new Error("账号格式错误，请配置 openid");
            let code;
            try {
                code = await getWxCode(this.account.openid);
            } catch (e) {
                // 中转取码失败时，如果有抓包凭证则降级兜底
                if (this.account.direct && this.account.session_id) {
                    $.log(`中转取码失败(${e.message})，降级使用抓包凭证`);
                    this.loginInfo = {
                        openid: this.account.openid,
                        user_id: this.account.user_id,
                        session_id: this.account.session_id,
                        map_session_id: this.account.map_session_id,
                        appId: APP.appid,
                    };
                    return;
                }
                throw e;
            }
            const body = {
                seqid: uuid(),
                app_id: APP.appid,
                auth_code: code,
                devHeader: {},
            };
            const { status, data } = await request({
                method: "POST",
                url: `${MINI_LOGIN_BASE}/minLogin/v2/login`,
                headers: {
                    "content-type": "application/json",
                    ...loginSign({ appId: APP.appid, postBody: body }),
                },
                data: body,
            });
            if (status !== 200 || Number(data?.err_code) !== 0) throw new Error(`登录失败 HTTP ${status}: ${short(data)}`);
            this.loginInfo = { ...data, appId: APP.appid };
            $.log(`登录：中转动态登录成功 userId=${data.user_id || "未知"}，openid=${mask(data.openid)}（凭证不过期）`);
            return;
        }
        // 抓包直连模式：环境变量里已带 user_id/session_id，无中转服务时使用
        if (this.account.direct) {
            const missing = ["openid", "user_id", "session_id"].filter((k) => !this.account[k]);
            if (missing.length) throw new Error(`抓包凭证缺少字段：${missing.join("、")}（格式 openid#user_id#session_id#map_session_id）`);
            this.loginInfo = {
                openid: this.account.openid,
                user_id: this.account.user_id,
                session_id: this.account.session_id,
                map_session_id: this.account.map_session_id,
                appId: APP.appid,
            };
            $.log(`登录：抓包直连 userId=${this.account.user_id}，openid=${mask(this.account.openid)}（未走 wx_server）`);
            return;
        }
        throw new Error("账号格式错误，请配置 openid 或抓包凭证");
    }

    async queryUser() {
        const user = this.loginInfo;
        const body = {
            seqid: uuid(),
            app_id: APP.appid,
            userId: user.user_id,
            openId: user.openid,
            source: "mini-tencentmap",
        };
        const { status, data } = await request({
            method: "POST",
            url: `${MINI_LOGIN_BASE}/minLogin/v2/getUserInfo`,
            headers: {
                "content-type": "application/json",
                ...loginSign({
                    appId: APP.appid,
                    sessionId: user.session_id,
                    userId: user.user_id,
                    openId: user.openid,
                    postBody: body,
                }),
            },
            data: body,
        });
        if (status !== 200 || Number(data?.err_code) !== 0) {
            $.log(`用户信息：查询失败 HTTP ${status}: ${short(data)}`);
            return;
        }
        this.userInfo = data || {};
        $.log(`用户信息：${data.nickname || "微信用户"}，userId=${data.userid || user.user_id}`);
    }

    async mapApi(apiPath, data) {
        const { status, data: body } = await request({
            method: "POST",
            url: `${MAP_BASE}${apiPath}`,
            headers: {
                "content-type": "application/json",
                ...checkinHeader(this.loginInfo),
                ...mapH5Sign(apiPath, this.loginInfo),
            },
            data,
        });
        if (status !== 200 || Number(body?.code) !== 0) throw new Error(`${apiPath} HTTP ${status}: ${short(body)}`);
        return body.data || {};
    }

    async queryBalance(prefix = "现金余额") {
        const data = await this.mapApi("/activity/v1/withdraw/home", {
            activity_id: ACTIVITY_ID,
            game_id: 4,
            rule_id: "tencent_map_withdraw",
        });
        $.log(
            `${prefix}：金币=${formatCoin(data.coins)}，可提现=${formatCoin(data.withdrawable_amount)}，门槛=${formatCoin(data.current_withdraw_threshold)}，奖池=${formatCoin(data.jackpot_amount)}`
        );
        return data;
    }

    async queryAssets() {
        const data = await this.mapApi("/activity/v1/assert/home", { activity_id: ACTIVITY_ID });
        $.log(
            `资产信息：金币=${formatCoin(data.coins)}，优惠券=${data.coupons_total || 0}，抽奖券=${data.lottery_ticket_total || 0}`
        );
        return data;
    }

    todayKey() {
        const now = new Date();
        const year = now.getFullYear();
        const month = `${now.getMonth() + 1}`.padStart(2, "0");
        const day = `${now.getDate()}`.padStart(2, "0");
        return `${year}${month}${day}`;
    }

    async queryCalendar(prefix = "签到状态") {
        const data = await this.mapApi("/activity/v1/checkin/calendar", {
            activity_id: ACTIVITY_ID,
            game_id: 1,
            rule_id: "tencent_map_checkin",
        });
        const today = data.calendar?.[this.todayKey()] || {};
        const prizes = Array.isArray(today.prizes)
            ? today.prizes.map((item) => `${item.name || item.type || "奖励"}:${item.amount ?? ""}`).join("，")
            : "";
        $.log(`${prefix}：今日${today.checkin ? "已签" : "未签"}，周期已签=${data.checkin_days || 0}/${data.period || 0}${prizes ? `，奖励=${prizes}` : ""}`);
        return { data, today };
    }

    async checkin() {
        const { today } = await this.queryCalendar("签到前");
        if (today.checkin) {
            $.log("签到：今日已签到");
            return;
        }
        const data = await this.mapApi("/activity/v1/checkin", {
            activity_id: ACTIVITY_ID,
            game_id: 1,
            rule_id: "tencent_map_checkin",
            nick: this.userInfo.nickname || "微信用户",
        });
        const prizes = Array.isArray(data.prizes)
            ? data.prizes.map((item) => `${item.name || item.type || "奖励"}:${item.amount ?? ""}`).join("，")
            : short(data);
        $.log(`签到：成功${prizes ? `，${prizes}` : ""}`);
    }

    async run() {
        $.log(`\n========== ${APP.name} 账号[${this.index}] ${this.account.remark || mask(this.account.openid)} ==========`);
        await this.miniLogin();
        await this.queryUser();
        await this.queryBalance("签到前现金余额");
        await this.queryAssets();
        await this.checkin();
        await this.queryBalance("签到后现金余额");
        await this.queryCalendar("签到后");
    }
}

(async () => {
    const accounts = splitAccounts(process.env[CK_NAME] || process.env.tencentmap || process.env.wx_openid || "");
    if (!accounts.length) {
        $.log(`未配置 ${CK_NAME}`);
        await $.done();
        return;
    }
    $.log(`共找到${accounts.length}个账号`);
    for (let i = 0; i < accounts.length; i++) {
        const runner = new TencentMap(accounts[i], i + 1);
        try {
            await runner.run();
        } catch (e) {
            $.log(`账号[${i + 1}] 执行失败：${e.message || e}`);
        }
        await $.wait(800);
    }
    await $.done();
})().catch(async (e) => {
    $.log(`脚本异常：${e.stack || e.message || e}`);
    await $.done();
});
