const axios = require("axios");
class WeChatCodeServer {
    constructor(options) {
        this.serverUrl = options.url;
        this.appid = options.appid;
        this.auth = options.auth;
    }
    getCode(openid) {
        console.log('等待获取code:');
        return new Promise((resolve, reject) => {
            // 兼容两种取码服务：
            //   - smallcat 原版: body {appid, openid}，返回 {code} / {data:{code}}
            //   - yyb-go 等新服务: body {app_id, ref}，返回 {result:{code}}
            // 同时发送两套字段名，服务端各取所需；响应统一归一化到 res.data.code
            const payload = {
                appid: this.appid,
                openid,
                app_id: this.appid,
                ref: openid,
            };
            axios.post(this.serverUrl + '/wx/code', payload, {
                headers: {
                    'auth': this.auth,
                    'Authorization': this.auth ? `Bearer ${this.auth}` : undefined
                },
                timeout: 30 * 1000
            }).then(res => {
                const d = res && res.data;
                if (d && d.status === false) {
                    console.log('获取code失败:', d.message || d.msg || '');
                    resolve(res); // 保留原响应，交由脚本判断 status:false
                    return;
                }
                // 归一化：yyb-go 的 data.result.code -> data.code / 顶层 code
                // yyb-go 实际返回 {code:0, data:{openid, result:{code, errMsg}}}
                const yybCode = d && d.data && d.data.result && d.data.result.code;
                const legacyCode = d && d.result && d.result.code;
                if (d && !d.data?.code && (yybCode || legacyCode)) {
                    const realCode = yybCode || legacyCode;
                    res.data = Object.assign({}, d, {
                        code: realCode,
                        data: Object.assign({}, d.data || {}, { code: realCode })
                    });
                }
                console.log('获取code成功:');
                resolve(res);
            }).catch(err => {
                reject(err);
            });
        });
    }
   
    cloudInit(openid) {
        console.log('等待云函数初始化:');
        return new Promise((resolve, reject) => {
            axios.post(this.serverUrl + '/wx/call/init', { appid: this.appid, openid }, {
                headers: {
                    'auth': this.auth
                },
                timeout: 30 * 1000
            }).then(res => {
                console.log('云函数初始化成功:');
                resolve(res);
            }).catch(err => {
                reject(err);
            });
        });
    }
    cloudCall(openid) {
        console.log('等待云函数调用:');
        return new Promise((resolve, reject) => {
            axios.post(this.serverUrl + '/wx/cloud/call', { appid: this.appid, openid }, {
                headers: {
                    'auth': this.auth
                },
                timeout: 30 * 1000
            }).then(res => {
                console.log('云函数调用成功:');
                resolve(res);
            }).catch(err => {
                reject(err);
            });
        });
    }
}
module.exports = WeChatCodeServer;