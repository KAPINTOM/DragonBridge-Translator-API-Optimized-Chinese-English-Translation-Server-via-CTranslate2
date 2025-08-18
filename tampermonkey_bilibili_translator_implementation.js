// ==UserScript==
// @name         Chinese to english translator (Local API)
// @namespace    http://tampermonkey.net/
// @version      1
// @description  Translates Chinese text to English using a local API
// @author       Kenneth Andrey PM
// @match        *://*.bilibili.com/*
// @match        *://*.live.bilibili.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=google.com
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      localhost
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // Configuration for local API
    const SERVER_URL = 'http://localhost:5000/translate';
    const CONFIG = {
        maxTextLength: 5000,
        batchSize: 10,
        translationDelay: 0,
        retryDelay: 2000,
        maxRetries: 3,
        interceptPatterns: [
            '*text*',
            '*json*',
            '*xml*',
            '*html*'
        ]
    };

    // State and cache
    const translationCache = new Map();
    const pendingNodes = new WeakSet();
    let activeTranslations = 0;

    // ======================== NETWORK INTERCEPTOR ========================
    const originalFetch = window.fetch;
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;

    window.fetch = async function(input, init) {
        const response = await originalFetch.call(this, input, init);
        if (shouldIntercept(response)) {
            const clone = response.clone();
            return processResponse(clone);
        }
        return response;
    };

    XMLHttpRequest.prototype.open = function(method, url) {
        this._method = method;
        this._url = url;
        originalXHROpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function(data) {
        const xhr = this;
        xhr.addEventListener('load', function() {
            if (xhr.readyState === 4 && shouldIntercept(xhr)) {
                const originalResponse = xhr.responseText;
                processTextResponse(originalResponse).then(translated => {
                    Object.defineProperty(xhr, 'responseText', { value: translated });
                    Object.defineProperty(xhr, 'response', { value: translated });
                });
            }
        });
        originalXHRSend.apply(this, arguments);
    };

    function shouldIntercept(response) {
        try {
            const contentType = response.headers?.get('Content-Type') || '';
            const url = response.url || '';
            return (
                CONFIG.interceptPatterns.some(pattern => url.includes(pattern)) &&
                /text|json|xml|html/.test(contentType) &&
                !/\.(css|js|png|jpg|jpeg|gif|svg|mp3|mp4|webm|woff2?|ttf|eot|otf)$/i.test(url)
            );
        } catch {
            return false;
        }
    }

    async function processResponse(response) {
        const contentType = response.headers.get('Content-Type') || '';
        const originalText = await response.text();
        if (/json/.test(contentType)) {
            const translated = await processJSONResponse(originalText);
            return new Response(translated, response);
        }
        return new Response(await processTextResponse(originalText), response);
    }

    async function processJSONResponse(jsonText) {
        try {
            const data = JSON.parse(jsonText);
            const translated = await translateJSON(data);
            return JSON.stringify(translated);
        } catch {
            return jsonText;
        }
    }

    async function processTextResponse(text) {
        return containsChinese(text) ? await translateText(text, 'network') : text;
    }

    async function translateJSON(obj, context = 'json') {
        if (typeof obj === 'string' && containsChinese(obj)) {
            return await translateText(obj, context);
        }
        if (Array.isArray(obj)) {
            for (let i = 0; i < obj.length; i++) {
                obj[i] = await translateJSON(obj[i], context);
            }
        }
        if (typeof obj === 'object' && obj !== null) {
            for (const key in obj) {
                obj[key] = await translateJSON(obj[key], context);
            }
        }
        return obj;
    }

    // ======================== DOM TRANSLATION ========================
    const domObserver = new MutationObserver(handleMutations);

    function startDOMObserver() {
        scanDOM(document.documentElement);
        domObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    function handleMutations(mutations) {
        for (const mutation of mutations) {
            if (mutation.type === 'characterData') {
                processTextNode(mutation.target);
            } else if (mutation.type === 'childList') {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.TEXT_NODE) {
                        processTextNode(node);
                    } else if (node.nodeType === Node.ELEMENT_NODE) {
                        scanDOM(node);
                    }
                });
            }
        }
    }

    function scanDOM(root) {
        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: node =>
                    node.textContent.trim() &&
                    containsChinese(node.textContent) &&
                    !pendingNodes.has(node) &&
                    isTranslatableElement(node.parentElement)
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_SKIP
            }
        );

        while (walker.nextNode()) {
            processTextNode(walker.currentNode);
        }
    }

    function processTextNode(textNode) {
        if (pendingNodes.has(textNode)) return;
        const originalText = textNode.textContent;
        if (!containsChinese(originalText)) return;

        pendingNodes.add(textNode);

        translateText(originalText, `dom:${textNode.parentElement?.tagName || 'unknown'}`)
            .then(translated => {
                if (textNode.textContent === originalText) {
                    textNode.textContent = translated;
                }
                pendingNodes.delete(textNode);
            })
            .catch(() => pendingNodes.delete(textNode));
    }

    function isTranslatableElement(element) {
        if (!element) return false;
        const tag = element.tagName.toLowerCase();
        const skipTags = ['script', 'style', 'textarea', 'option', 'noscript', 'code', 'pre'];
        return !skipTags.includes(tag);
    }

    // ======================== TRANSLATION CORE ========================
    function containsChinese(text) {
        return /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/.test(text);
    }

    async function translateText(text, context, retryCount = 0) {
        if (!text.trim()) return text;

        const cacheKey = `${context}:${text}`;
        if (translationCache.has(cacheKey)) {
            return translationCache.get(cacheKey);
        }

        // Concurrency control
        while (activeTranslations >= CONFIG.batchSize) {
            await new Promise(resolve => setTimeout(resolve, CONFIG.translationDelay));
        }

        activeTranslations++;

        try {
            const cleanText = text.trim().substring(0, CONFIG.maxTextLength);
            const translated = await new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: SERVER_URL,
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify({ text: cleanText }),
                    timeout: 8000,
                    onload: (response) => {
                        try {
                            const data = JSON.parse(response.responseText);
                            if (data.translated_text) {
                                translationCache.set(cacheKey, data.translated_text);
                                resolve(data.translated_text);
                            } else {
                                resolve(cleanText);
                            }
                        } catch {
                            resolve(cleanText);
                        }
                    },
                    onerror: () => resolve(cleanText),
                    ontimeout: () => resolve(cleanText)
                });
            });

            return translated;
        } finally {
            activeTranslations--;

            // Automatic retries
            if (retryCount < CONFIG.maxRetries && !translationCache.has(cacheKey)) {
                setTimeout(async () => {
                    const translated = await translateText(text, context, retryCount + 1);
                    updateTextOccurrences(text, translated);
                }, CONFIG.retryDelay * (retryCount + 1));
            }
        }
    }

    function updateTextOccurrences(originalText, translatedText) {
        const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            { acceptNode: node =>
                node.textContent.includes(originalText) ?
                NodeFilter.FILTER_ACCEPT :
                NodeFilter.FILTER_SKIP
            }
        );

        while (walker.nextNode()) {
            const node = walker.currentNode;
            node.textContent = node.textContent.replace(
                new RegExp(escapeRegExp(originalText), 'g'),
                translatedText
            );
        }
    }

    function escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // ======================== INITIALIZATION ========================
    function initialize() {
        startDOMObserver();

        // Handle SPA
        const pushState = history.pushState;
        const replaceState = history.replaceState;

        history.pushState = function() {
            pushState.apply(this, arguments);
            setTimeout(() => scanDOM(document.documentElement), 500);
        };

        history.replaceState = function() {
            replaceState.apply(this, arguments);
            setTimeout(() => scanDOM(document.documentElement), 500);
        };

        // Periodic scan for dynamic content
        setInterval(() => scanDOM(document.documentElement), 3000);
    }

    // Start
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        setTimeout(initialize, 1000);
    }
})();