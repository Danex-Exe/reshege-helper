// ==UserScript==
// @name         ReshEge-Ad-Cleaner
// @namespace    http://tampermonkey.net/
// @version      1.0.3
// @description  Блокирует рекламу и предотвращает антиадблок
// @author       Danex-Exe
// @match        *://*.sdamgia.ru/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const originalFetch = window.fetch;
    window.fetch = function(url, ...args) {
        if (typeof url === 'string' && url.includes('yandex.ru/ads/system/context.js')) {
            return Promise.resolve(new Response('a'.repeat(20000), {
                status: 200,
                headers: { 'Content-Type': 'application/javascript' }
            }));
        }
        return originalFetch.call(this, url, ...args);
    };

    const originalXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        if (typeof url === 'string' && url.includes('yandex.ru/ads/system/context.js')) {
            Object.defineProperty(this, 'responseText', { value: 'a'.repeat(20000) });
            Object.defineProperty(this, 'status', { value: 200 });
            setTimeout(() => {
                if (this.onload) this.onload.call(this, new Event('load'));
                if (this.onreadystatechange) {
                    this.readyState = 4;
                    this.onreadystatechange.call(this, new Event('readystatechange'));
                }
            }, 0);
            return;
        }
        originalXHROpen.call(this, method, url, ...rest);
    };

    document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = `
            .AdBlockBlockMessage-Wrap,
            .AdBlockBlockMessage-BlockDetect,
            #yandex_varioqub_test1,
            #yandex_varioqub_test2,
            #yandex_varioqub_test3,
            #yandex_fad,
            .no_dark,
            .Se5da2342e2,
            .notice_win,
            .s54a65f4s5d,
            [id^="yandex_varioqub"],
            [id^="yandex_rtb"],
            [class*="csr-uniq"],
            [data-r-a-154002] {
                display: none !important;
            }
        `;
        document.head.appendChild(style);

        const observer = new MutationObserver(() => {
            const adBlockMsg = document.querySelector('.AdBlockBlockMessage-Wrap');
            if (adBlockMsg) {
                adBlockMsg.style.display = 'none';
                const appDiv = document.querySelector('.App');
                if (!appDiv && document.body.children.length === 1 && adBlockMsg.parentElement === document.body) {
                    const storedApp = sessionStorage.getItem('reshu_app_html');
                    if (storedApp) {
                        document.body.innerHTML = storedApp;
                    }
                }
            }
            const app = document.querySelector('.App');
            if (app && app.offsetParent === null) {
                app.style.display = '';
                app.style.visibility = '';
                app.style.opacity = '';
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });

        setInterval(() => {
            const app = document.querySelector('.App');
            if (!app && document.body.children.length === 1) {
                const onlyChild = document.body.firstElementChild;
                if (onlyChild && onlyChild.classList.contains('AdBlockBlockMessage-Wrap')) {
                    onlyChild.remove();
                    location.reload();
                }
            }
        }, 1000);
    });

    window.addEventListener('load', () => {
        const app = document.querySelector('.App');
        if (app) {
            sessionStorage.setItem('reshu_app_html', app.outerHTML);
        }
    });
})();