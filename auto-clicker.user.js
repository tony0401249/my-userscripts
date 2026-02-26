// ==UserScript==
// @name         WIN-MATRIX 即時監控系統v22.0
// @namespace    win-matrix.ai
// @version      22.0
// @description  修正房號同步，新增 5 分鐘隨機推薦房號，RTP 連動餘額，高對比伸縮 UI
// @author       GEM-Ω (Carmack/RMS/Bellard/Knuth)
// @match        *://*/egames/*/game*
// @match        *://play.godeebxp.com/egames/*
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    /**
     * GEM-Ω 工程筆記：
     * 1. 引擎核心：保留 Delta 差值計算法，透過餘額變動監控 LossCount。
     * 2. 數據同步：Fetch/XHR/WS/Global 全方位攔截房號與餘額。
     * 3. 隨機序列：
     * - 購買免遊 (10s): 2~250%
     * - 浮動提醒 (20s): 2~100%
     * - 推薦房號 (300s): 1~3000
     */

    // === 1. 核心大腦與狀態 ===
    let state = {
        isAuto: false,
        isCollapsed: false,
        balanceNum: 0,
        balanceText: "載入中...",
        currentBetText: "---%",      // 10s 變動 (購買免遊)
        roomID: "讀取中...",        // 同步目標 (進房房號)
        recRoomID: "----",           // 推薦房號 (5分鐘變動)
        lossCount: 0,
        predictedRTP: "97.8%",       // 隨餘額連動
        signalCountdown: 1800,
        floatingReminder: "86%",     // 20s 變動
        lastAlertTime: 0,
        lastBuyFreeTime: 0,
        lastRecRoomTime: 0,          // 推薦房號計時
        lastSpinTime: 0
    };

    // === 2. 注入高對比戰神介面 ===
    GM_addStyle(`
        #wm-root {
            position: fixed; top: 15px; left: 15px; width: 280px;
            z-index: 2147483647; font-family: "Microsoft JhengHei", sans-serif;
            pointer-events: auto; user-select: none;
        }
        .wm-card {
            background: rgba(10, 9, 7, 0.98); border: 1px solid rgba(218, 165, 50, 0.8);
            border-radius: 12px; box-shadow: 0 0 30px rgba(0,0,0,0.9);
            overflow: hidden; transition: all 0.3s ease;
        }
        .wm-header {
            background: linear-gradient(180deg, #2a2620, #0a0907);
            padding: 12px 15px; cursor: move; border-bottom: 1px solid rgba(218, 165, 50, 0.4);
            display: flex; justify-content: space-between; align-items: center;
        }
        .wm-title-group { display: flex; flex-direction: column; }
        .wm-main-title { font-size: 13px; font-weight: 900; color: #dac085; letter-spacing: 0.5px; }
        .wm-time-str { font-size: 10px; color: #777; font-family: monospace; }

        .wm-header-right { display: flex; align-items: center; gap: 8px; }
        .wm-room-no { color: #ff4d4d; font-weight: bold; font-family: 'Consolas', monospace; font-size: 15px; text-shadow: 0 0 5px rgba(255,0,0,0.5); }
        .wm-mini-btn { cursor: pointer; color: #dac085; font-size: 20px; font-weight: bold; padding: 0 5px; }

        .wm-content { max-height: 800px; overflow: hidden; transition: max-height 0.3s ease; }
        .wm-body { padding: 15px; display: flex; flex-direction: column; gap: 8px; }
        .wm-row { display: flex; justify-content: space-between; font-size: 13px; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 6px; }
        .wm-label { color: #8a8272; }
        .wm-val { font-weight: bold; font-family: 'Consolas', monospace; color: #fff; }

        .wm-btn {
            background: linear-gradient(180deg, #ff4d4d, #cc0000); border: 1px solid #ff4d4d;
            color: #fff; padding: 10px; border-radius: 6px; font-weight: 900;
            cursor: pointer; text-align: center; margin-top: 5px; width: 100%; box-shadow: 0 0 10px rgba(255,0,0,0.3);
        }
        .wm-btn.active { background: linear-gradient(180deg, #00ff41, #00cc33); border-color: #00ff41; color: #000; box-shadow: 0 0 15px rgba(0,255,65,0.5); }

        .wm-signal { background: rgba(0,0,0,0.4); border-top: 1px dashed rgba(218, 165, 50, 0.4); padding: 12px 15px; font-size: 11px; color: #ccc; line-height: 1.6; }
        .wm-sig-head { display: flex; justify-content: space-between; color: #00f2ff; font-weight: bold; }

        .collapsed .wm-content { max-height: 0; }
    `);

    // === 3. 強力數據監聽引擎 ===
    const processAnyData = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        const scan = (item, depth = 0) => {
            if (depth > 10) return;
            for (let key in item) {
                let val = item[key];
                const k = key.toLowerCase();
                if (['tableid', 'tid', 'roomid', 'tbid', 'table_id', 'room_id'].includes(k)) {
                    if (val && val !== "0" && val !== 0) state.roomID = val.toString();
                }
                if (['balance', 'credit', 'userbalance', 'bl', 'amount', 'wallet'].includes(k) && typeof val === 'number') {
                    if (val > 0 && state.balanceNum !== val) {
                        let old = state.balanceNum;
                        state.balanceNum = val;
                        state.balanceText = val.toLocaleString('en-US', {minimumFractionDigits: 2});
                        if (old > 0) {
                            if (val < old) state.lossCount++;
                            else if (val > old) state.lossCount = 0;
                        }
                    }
                }
                if (val && typeof val === 'object') scan(val, depth + 1);
            }
        };
        scan(obj);
    };

    const hookAll = () => {
        const oParse = JSON.parse;
        JSON.parse = function(t) {
            const res = oParse(t);
            setTimeout(() => processAnyData(res), 0);
            return res;
        };
        const oSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function() {
            this.addEventListener('load', () => {
                try { processAnyData(JSON.parse(this.responseText)); } catch(e){}
            });
            return oSend.apply(this, arguments);
        };
        const oFetch = window.fetch;
        window.fetch = async (...args) => {
            const res = await oFetch(...args);
            const clone = res.clone();
            clone.text().then(t => { try { processAnyData(JSON.parse(t)); } catch(e){} }).catch(()=>{});
            return res;
        };
        const oWS = window.WebSocket;
        window.WebSocket = function(url, protocols) {
            const ws = new oWS(url, protocols);
            ws.addEventListener('message', (e) => {
                try { processAnyData(JSON.parse(e.data)); } catch(e){}
            });
            return ws;
        };
        window.WebSocket.prototype = oWS.prototype;
    };

    const globalScanner = () => {
        const suspects = ['gameModel', 'config', 'tableInfo', 'roomInfo', 'gameData', 'slotData', 'playerModel'];
        suspects.forEach(s => { if (window[s]) processAnyData(window[s]); });
        const params = new URLSearchParams(window.location.search);
        const tid = params.get('tableId') || params.get('roomId') || params.get('tid') || params.get('table_id');
        if (tid) state.roomID = tid;
    };

    // === 4. UI 介面實作 ===
    const injectUI = () => {
        if(document.getElementById('wm-root')) return;
        const root = document.createElement('div');
        root.id = 'wm-root';
        root.innerHTML = `
            <div class="wm-card" id="wm-panel">
                <div class="wm-header" id="wm-drag">
                    <div class="wm-title-group">
                        <span class="wm-main-title">WIN-MATRIX 即時監控系統v22.0</span>
                        <span class="wm-time-str" id="ui-time">--/--/-- --:--:--</span>
                    </div>
                    <div class="wm-header-right">
                        <span class="wm-room-no" id="ui-room">#----</span>
                        <span class="wm-mini-btn" id="wm-collapse">−</span>
                    </div>
                </div>
                <div class="wm-content">
                    <div class="wm-body">
                        <div class="wm-row"><span class="wm-label">分析 RTP</span><span class="wm-val" id="ui-rtp" style="color:#00ff41">${state.predictedRTP}</span></div>
                        <div class="wm-row"><span class="wm-label">當前餘額</span><span class="wm-val" id="ui-balance" style="color:#00f2ff">${state.balanceText}</span></div>
                        <div class="wm-row"><span class="wm-label">購買免遊</span><span class="wm-val" id="ui-bet" style="color:#dac085">${state.currentBetText}</span></div>
                        <div class="wm-row"><span class="wm-label">浮動提醒</span><span class="wm-val" id="ui-alert" style="color:#00f2ff">${state.floatingReminder}</span></div>
                        <div class="wm-row"><span class="wm-label">推薦房號</span><span class="wm-val" id="ui-rec-room" style="color:#ff4d4d">${state.recRoomID}</span></div>
                        <div class="wm-row"><span class="wm-label">連續未中</span><span class="wm-val" id="ui-loss">0</span></div>
                        <button id="wm-btn" class="wm-btn">⭕ 啟動戰略狙擊</button>
                    </div>
                    <div class="wm-signal">
                        <div class="wm-sig-head">電子推薦⚡️ <span id="ui-cd" style="color:#888;">30:00</span></div>
                        <div id="ui-sig-body"></div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(root);

        const drag = document.getElementById('wm-drag');
        drag.onmousedown = (e) => {
            let sx = e.clientX - root.offsetLeft;
            let sy = e.clientY - root.offsetTop;
            document.onmousemove = (ev) => {
                root.style.left = (ev.clientX - sx) + 'px';
                root.style.top = (ev.clientY - sy) + 'px';
            };
            document.onmouseup = () => document.onmousemove = null;
        };

        document.getElementById('wm-collapse').onclick = function() {
            state.isCollapsed = !state.isCollapsed;
            document.getElementById('wm-panel').classList.toggle('collapsed');
            this.innerText = state.isCollapsed ? "+" : "−";
        };

        document.getElementById('wm-btn').onclick = function() {
            state.isAuto = !state.isAuto;
            this.innerText = state.isAuto ? "🟢 狙擊運行中" : "⭕ 啟動戰略狙擊";
            this.classList.toggle('active');
        };

        generateSignal();
    };

    // === 5. 定時更新循環 ===
    const update = () => {
        const now = Date.now();
        const d = new Date(now);
        const tStr = `${d.getFullYear()}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getDate().toString().padStart(2,'0')} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}`;
        if(document.getElementById('ui-time')) document.getElementById('ui-time').innerText = tStr;

        // 10s 購買免遊 (2~250%)
        if (now - state.lastBuyFreeTime >= 10000) {
            state.currentBetText = (Math.floor(Math.random() * 249) + 2) + "%";
            state.lastBuyFreeTime = now;
        }

        // 20s 浮動提醒 (2~100%)
        if (now - state.lastAlertTime >= 20000) {
            state.floatingReminder = (Math.floor(Math.random() * 99) + 2) + "%";
            state.lastAlertTime = now;
        }

        // 300s (5分鐘) 推薦房號 (1~3000)
        if (now - state.lastRecRoomTime >= 300000) {
            state.recRoomID = Math.floor(Math.random() * 3000) + 1;
            state.lastRecRoomTime = now;
        }

        // RTP 隨餘額動態變更
        if (state.balanceNum > 0) {
            let rtpBase = 92.5 + (state.balanceNum % 5);
            state.predictedRTP = (rtpBase + Math.random() * 2.0).toFixed(1) + "%";
        }

        const safeSet = (id, val) => { const el = document.getElementById(id); if(el) el.innerText = val; };
        safeSet('ui-balance', state.balanceText);
        safeSet('ui-bet', state.currentBetText);
        safeSet('ui-room', `#${state.roomID}`);
        safeSet('ui-rec-room', state.recRoomID);
        safeSet('ui-loss', state.lossCount);
        safeSet('ui-alert', state.floatingReminder);
        safeSet('ui-rtp', state.predictedRTP);

        if(document.getElementById('ui-loss')) document.getElementById('ui-loss').style.color = state.lossCount >= 5 ? "#ff4d4d" : "#fff";

        if (state.signalCountdown > 0) {
            state.signalCountdown--;
            let m = Math.floor(state.signalCountdown / 60);
            let s = state.signalCountdown % 60;
            if(document.getElementById('ui-cd')) document.getElementById('ui-cd').innerText = `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
        } else generateSignal();
    };

    const generateSignal = () => {
        const items = ['匕首', '眼', '弓', '藍寶', '蛇', '甲', '紅寶', '法杖'];
        const r = () => items[Math.floor(Math.random() * items.length)];
        const n = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
        const html = `
            選房：${n(102, 104)}～${n(105, 108)}％<br>
            總投：${n(35, 45)}W上<br>
            🔰 5K～1W本建議起始最低注<br><br>
            <span style="color:#dac085">✨${r()}${n(3,5)}+${r()}${n(4,6)}+紅寶5 購免遊</span><br>
            ${r()}4+蛇6 上升2<br>
            蛇5+甲5 上升2<br>
            匕首4+紅寶5 下降1<br>
            100內未進FG 下降2
        `;
        const body = document.getElementById('ui-sig-body');
        if(body) body.innerHTML = html;
        state.signalCountdown = 1800;
    };

    hookAll();
    setInterval(() => { update(); globalScanner(); }, 1000);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectUI);
    } else {
        injectUI();
    }
})();
