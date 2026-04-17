// ==UserScript==
// @name         ReshEge-Helper
// @namespace    http://tampermonkey.net/
// @version      1.0.3
// @description  Удобное меню для игры «Держи оборону» с историей матчей, таблицей лидеров и расширенной статистикой.
// @author       github.com/Danex-Exe
// @match        https://ege.sdamgia.ru/game.htm
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (window.self !== window.top) return;

  const SCRIPT_META = {
    title: 'ReshEge-Helper',
    version: 'v1.0.3'
  };

  const VIEW = {
    MAIN: 'main',
    HISTORY: 'history',
    LEADERBOARD: 'highscore',
    AUTO_BET: 'auto_bet',
    AUTO_HIGHLIGHT: 'auto_highlight'
  };
  const THEME = {
    DARK: 'dark',
    LIGHT: 'light'
  };

  const PING_TIMEOUT_MS = 10000;
  const CHOICE_MARKER_REGEX = /\(\s*(\d+)\)/g;
  const THEME_STORAGE_KEY = 're_helper_theme_v1';
  const ANSWER_CACHE_STORAGE_KEY = 're_helper_answer_cache_v1';
  const AUTO_ANSWER_STORAGE_KEY = 're_helper_auto_answer_v1';
  const AUTO_BET_STORAGE_KEY = 're_helper_auto_bet_v1';
  const AUTO_HIGHLIGHT_STORAGE_KEY = 're_helper_auto_highlight_v1';
  const SUBJECT_STORAGE_KEY = 're_helper_selected_subject_v1';
  const MAX_ANSWER_CACHE_ENTRIES = 500;
  const SUBJECTS = ['math', 'rus', 'phys', 'chem', 'bio', 'hist', 'soc', 'inf', 'geo', 'eng', 'ger', 'fra', 'spa', 'lit'];

  const EXTRA_MENU_BUTTONS = [];

  let game = null;
  let menuUI = null;
  let pingTimer = null;
  let pingValue = 0;
  let pingDisplayElement = null;
  let lastPingSentTime = 0;
  let currentTheme = THEME.DARK;
  let currentProblemFingerprint = null;
  let answerCache = {};
  let autoAnswerEnabled = false;
  let autoBetEnabled = false;
  let autoBetValue = 10;
  let autoHighlightEnabled = false;
  let highlightWords = [];
  let hotkeysBound = false;
  let leaderboardCache = null;
  let leaderboardCacheTime = 0;
  let selectedSubject = 'math';
  const queuedExternalButtons = [...EXTRA_MENU_BUTTONS];

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => {
      switch (char) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        case "'": return '&#39;';
        default: return char;
      }
    });
  }

  function isValidTheme(theme) {
    return theme === THEME.DARK || theme === THEME.LIGHT;
  }

  function loadThemePreference() {
    try {
      const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
      return isValidTheme(storedTheme) ? storedTheme : THEME.DARK;
    } catch (error) {
      return THEME.DARK;
    }
  }

  function saveThemePreference(theme) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (error) {}
  }

  function applyTheme(theme, persist = true) {
    const nextTheme = isValidTheme(theme) ? theme : THEME.DARK;
    currentTheme = nextTheme;
    document.documentElement.setAttribute('data-re-theme', nextTheme);
    if (persist) saveThemePreference(nextTheme);
  }

  function toggleTheme() {
    const nextTheme = currentTheme === THEME.DARK ? THEME.LIGHT : THEME.DARK;
    applyTheme(nextTheme, true);
    return nextTheme;
  }

  function normalizeCacheRecord(record) {
    if (typeof record === 'string') {
      const normalizedLegacyValue = record.trim();
      return normalizedLegacyValue ? { a: normalizedLegacyValue, t: 0 } : null;
    }
    if (!record || typeof record !== 'object') return null;
    const answer = String(record.a ?? record.answer ?? '').trim();
    if (!answer) return null;
    const updatedAtRaw = Number(record.t ?? record.updatedAt ?? 0);
    const updatedAt = Number.isFinite(updatedAtRaw) ? updatedAtRaw : 0;
    return { a: answer, t: updatedAt };
  }

  function hashStringFNV1a(text, seed = 0x811c9dc5) {
    let hash = seed >>> 0;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  function normalizeProblemText(htmlBody, extraText) {
    const container = document.createElement('div');
    container.innerHTML = `${String(htmlBody ?? '')}${String(extraText ?? '')}`;
    const plain = String(container.textContent ?? '');
    return plain.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function createProblemFingerprint(payload) {
    const legacyKey = normalizeProblemText(payload?.body, payload?.text);
    if (!legacyKey) return null;
    const hashA = hashStringFNV1a(legacyKey, 0x811c9dc5);
    const hashB = hashStringFNV1a(legacyKey, 0x9e3779b1);
    const lengthPart = legacyKey.length.toString(36);
    const key = `${lengthPart}-${hashA.toString(36)}-${hashB.toString(36)}`;
    return { key, legacyKey };
  }

  function pruneAnswerCache() {
    const cacheEntries = Object.entries(answerCache);
    const overflow = cacheEntries.length - MAX_ANSWER_CACHE_ENTRIES;
    if (overflow <= 0) return;
    cacheEntries
      .sort((left, right) => {
        const leftTime = Number(left[1]?.t ?? 0);
        const rightTime = Number(right[1]?.t ?? 0);
        return leftTime - rightTime;
      })
      .slice(0, overflow)
      .forEach(([cacheKey]) => {
        delete answerCache[cacheKey];
      });
  }

  function loadAnswerCache() {
    try {
      const raw = localStorage.getItem(ANSWER_CACHE_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return {};
      const normalizedCache = {};
      Object.entries(parsed).forEach(([cacheKey, cacheValue]) => {
        const normalizedRecord = normalizeCacheRecord(cacheValue);
        if (normalizedRecord) normalizedCache[cacheKey] = normalizedRecord;
      });
      return normalizedCache;
    } catch (error) {
      return {};
    }
  }

  function saveAnswerCache() {
    try {
      pruneAnswerCache();
      localStorage.setItem(ANSWER_CACHE_STORAGE_KEY, JSON.stringify(answerCache));
    } catch (error) {}
  }

  function resolveCacheRecord(problemRef) {
    if (!problemRef?.key) return null;
    const directRecord = normalizeCacheRecord(answerCache[problemRef.key]);
    if (directRecord) {
      answerCache[problemRef.key] = directRecord;
      return directRecord;
    }
    if (!problemRef.legacyKey || problemRef.legacyKey === problemRef.key) return null;
    const legacyRecord = normalizeCacheRecord(answerCache[problemRef.legacyKey]);
    if (!legacyRecord) return null;
    const migratedRecord = { a: legacyRecord.a, t: Date.now() };
    answerCache[problemRef.key] = migratedRecord;
    delete answerCache[problemRef.legacyKey];
    saveAnswerCache();
    return migratedRecord;
  }

  function rememberAnswerForProblem(problemRef, answer) {
    if (!problemRef?.key) return;
    const normalizedAnswer = String(answer ?? '').trim();
    if (!normalizedAnswer) return;
    answerCache[problemRef.key] = { a: normalizedAnswer, t: Date.now() };
    saveAnswerCache();
  }

  function getRememberedAnswer(problemRef) {
    if (!problemRef?.key) return '';
    const cacheRecord = resolveCacheRecord(problemRef);
    return String(cacheRecord?.a ?? '').trim();
  }

  function loadAutoAnswerPreference() {
    try {
      const stored = localStorage.getItem(AUTO_ANSWER_STORAGE_KEY);
      return stored === 'true';
    } catch (error) {
      return false;
    }
  }

  function saveAutoAnswerPreference(enabled) {
    try {
      localStorage.setItem(AUTO_ANSWER_STORAGE_KEY, String(enabled));
    } catch (error) {}
  }

  function toggleAutoAnswer() {
    autoAnswerEnabled = !autoAnswerEnabled;
    saveAutoAnswerPreference(autoAnswerEnabled);
    return autoAnswerEnabled;
  }

  function loadAutoBetPreference() {
    try {
      const stored = localStorage.getItem(AUTO_BET_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed === 'object') {
          autoBetEnabled = parsed.enabled === true;
          autoBetValue = [10, 20, 30, 40, 50].includes(parsed.value) ? parsed.value : 10;
          return;
        }
      }
      autoBetEnabled = false;
      autoBetValue = 10;
    } catch (error) {
      autoBetEnabled = false;
      autoBetValue = 10;
    }
  }

  function saveAutoBetPreference() {
    try {
      localStorage.setItem(AUTO_BET_STORAGE_KEY, JSON.stringify({
        enabled: autoBetEnabled,
        value: autoBetValue
      }));
    } catch (error) {}
  }

  function loadAutoHighlightPreference() {
    try {
      const stored = localStorage.getItem(AUTO_HIGHLIGHT_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed === 'object') {
          autoHighlightEnabled = parsed.enabled === true;
          highlightWords = Array.isArray(parsed.words) ? parsed.words.filter(w => typeof w === 'string' && w.trim()) : [];
          return;
        }
      }
      autoHighlightEnabled = false;
      highlightWords = [];
    } catch (error) {
      autoHighlightEnabled = false;
      highlightWords = [];
    }
  }

  function saveAutoHighlightPreference() {
    try {
      localStorage.setItem(AUTO_HIGHLIGHT_STORAGE_KEY, JSON.stringify({
        enabled: autoHighlightEnabled,
        words: highlightWords
      }));
    } catch (error) {}
  }

  function loadSelectedSubject() {
    try {
      const stored = localStorage.getItem(SUBJECT_STORAGE_KEY);
      if (stored && SUBJECTS.includes(stored)) return stored;
    } catch (e) {}
    return 'math';
  }

  function saveSelectedSubject(subj) {
    try {
      localStorage.setItem(SUBJECT_STORAGE_KEY, subj);
    } catch (e) {}
  }

  function tryAutofillRememberedAnswer(problemRef) {
    if (!autoAnswerEnabled) return false;
    const rememberedAnswer = getRememberedAnswer(problemRef);
    if (!rememberedAnswer) return false;
    const answerInput = document.querySelector('.game_answer_inp');
    if (!answerInput) return false;
    answerInput.value = rememberedAnswer;
    answerInput.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  function setResultBadgeState(selector, isRight) {
    const badge = document.querySelector(selector);
    if (!badge) return;
    badge.classList.remove('re-status-correct', 're-status-wrong');
    if (isRight === true) badge.classList.add('re-status-correct');
    else if (isRight === false) badge.classList.add('re-status-wrong');
  }

  function resetResultBadgeStates() {
    ['.game_my_result', '.game_his_result'].forEach((selector) => {
      const badge = document.querySelector(selector);
      if (!badge) return;
      badge.classList.remove('re-status-correct', 're-status-wrong');
    });
  }

  function hasIdValue(value) {
    if (value === null || value === undefined) return false;
    const normalized = String(value).trim();
    return normalized !== '';
  }

  function isBotMatchOpponent(match) {
    const hasExplicitOpponentId =
      hasIdValue(match?.coplayer_id) ||
      hasIdValue(match?.opponent_id) ||
      hasIdValue(match?.coplayerId);
    if (hasExplicitOpponentId) return false;
    const player1HasId = hasIdValue(match?.player1);
    const player2HasId = hasIdValue(match?.player2);
    return !player1HasId || !player2HasId;
  }

  function getOpponentDisplayName(match) {
    const rawName = String(match?.coplayer ?? '').trim() || 'Неизвестный соперник';
    if (!isBotMatchOpponent(match)) return rawName;
    return rawName.startsWith('БОТ') ? rawName : `БОТ ${rawName}`;
  }

  async function fetchLeaderboard() {
    if (!game || typeof game.send !== 'function') return null;
    return new Promise((resolve) => {
      const originalHandler = game.message_handler;
      game.message_handler = (resp) => {
        if (resp?.function === 'show_highscore') {
          game.message_handler = originalHandler;
          resolve(resp);
        } else if (originalHandler) {
          originalHandler(resp);
        }
      };
      game.send({ action: 'get_highscore' });
      setTimeout(() => {
        game.message_handler = originalHandler;
        resolve(null);
      }, 5000);
    });
  }

  async function getLeaderboardData(force = false) {
    const now = Date.now();
    if (!force && leaderboardCache && (now - leaderboardCacheTime) < 60000) {
      return leaderboardCache;
    }
    const data = await fetchLeaderboard();
    if (data) {
      leaderboardCache = data;
      leaderboardCacheTime = now;
    }
    return leaderboardCache;
  }

  function getOpponentRankInfo(opponentId, leaderboardData) {
    if (!opponentId || !leaderboardData?.scores) return null;
    const scores = leaderboardData.scores;
    for (let i = 0; i < scores.length; i++) {
      const entry = scores[i];
      if (entry && (entry.id === opponentId || entry.user_id === opponentId)) {
        return {
          rank: i + 1,
          score: entry.score
        };
      }
    }
    return null;
  }

  function isLetter(char) {
    return /[a-zA-Zа-яА-ЯёЁ]/.test(char);
  }

  function getSortRank(char) {
    if (/[a-z]/.test(char)) return [0, char.charCodeAt(0)];
    if (/[A-Z]/.test(char)) return [1, char.charCodeAt(0)];
    if (/[0-9]/.test(char)) return [2, char.charCodeAt(0)];
    return [3, char.charCodeAt(0)];
  }

  function sortAnswerCharacters(value) {
    return [...String(value ?? '')]
      .sort((left, right) => {
        const [leftRank, leftCode] = getSortRank(left);
        const [rightRank, rightCode] = getSortRank(right);
        if (leftRank !== rightRank) return leftRank - rightRank;
        return leftCode - rightCode;
      })
      .join('');
  }

  function sanitizeAnswerForSubmit(value) {
    const raw = String(value ?? '').trim();
    const seen = new Set();
    let result = '';
    for (const char of raw) {
      if (isLetter(char)) {
        result += char;
        continue;
      }
      if (seen.has(char)) continue;
      seen.add(char);
      result += char;
    }
    return result;
  }

  function containsChoiceValue(answer, choiceValue) {
    return String(answer ?? '').includes(choiceValue);
  }

  function removeChoiceValue(answer, choiceValue) {
    if (!choiceValue) return String(answer ?? '');
    return String(answer ?? '').split(choiceValue).join('');
  }

  function isEditableTarget(targetElement) {
    if (!(targetElement instanceof Element)) return false;
    const editableSelector = 'input, textarea, select, [contenteditable="true"]';
    return Boolean(targetElement.closest(editableSelector));
  }

  function getAnswerInput() {
    const input = document.querySelector('.game_answer_inp');
    if (!(input instanceof HTMLInputElement)) return null;
    if (input.offsetParent === null) return null;
    return input;
  }

  function isMenuOpen() {
    const drawer = document.querySelector('.ReshEge_Helper_menu_drawer');
    return Boolean(drawer?.classList.contains('is-open'));
  }

  function triggerChoiceFromKeyboard(choiceDigit, answerInput) {
    const choiceButtons = Array.from(document.querySelectorAll('.game_prob .re-choice-button'));
    const matchedButton = choiceButtons.find((button) => button.dataset.choiceValue === choiceDigit);
    if (matchedButton) {
      matchedButton.click();
      return true;
    }
    answerInput.value += choiceDigit;
    answerInput.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  function triggerSubmitFromKeyboard() {
    const submitButton = document.querySelector('.game_answer_send');
    if (!(submitButton instanceof HTMLInputElement || submitButton instanceof HTMLButtonElement)) return false;
    if (submitButton.offsetParent === null || submitButton.disabled) return false;
    submitButton.click();
    return true;
  }

  function bindGlobalAnswerHotkeys() {
    if (hotkeysBound) return;
    hotkeysBound = true;

    document.addEventListener('keydown', (event) => {
      if (event.defaultPrevented) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.repeat) return;
      if (isMenuOpen()) return;

      const answerInput = getAnswerInput();
      const activeElement = document.activeElement;
      const focusedInAnswerInput = activeElement === answerInput;

      const digitMatch = String(event.key).match(/^[1-9]$/);

      if (digitMatch) {
        const digit = digitMatch[0];
        const betButtons = document.querySelectorAll('.game_turn_bet');
        if (betButtons.length > 0 && !focusedInAnswerInput && !isEditableTarget(activeElement)) {
          const betValue = parseInt(digit, 10) * 10;
          for (const btn of betButtons) {
            if (btn.textContent.trim() === String(betValue)) {
              btn.click();
              event.preventDefault();
              event.stopPropagation();
              return;
            }
          }
        }

        if (!answerInput) return;
        if (focusedInAnswerInput) return;
        if (isEditableTarget(activeElement)) return;

        const handled = triggerChoiceFromKeyboard(digit, answerInput);
        if (handled) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      if (event.key === 'Enter') {
        if (!answerInput) return;
        if (focusedInAnswerInput) return;
        if (isEditableTarget(activeElement)) return;
        const submitted = triggerSubmitFromKeyboard();
        if (submitted) {
          event.preventDefault();
          event.stopPropagation();
        }
      }
    }, true);
  }

  function injectStyle(styleId, cssText) {
    if (document.getElementById(styleId)) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = cssText;
    document.head.appendChild(style);
  }

  function waitForGame() {
    return new Promise((resolve) => {
      if (window.game) {
        resolve(window.game);
        return;
      }
      const checkInterval = setInterval(() => {
        if (window.game) {
          clearInterval(checkInterval);
          resolve(window.game);
        }
      }, 100);
    });
  }

  function setConnectionIndicator(online) {
    const indicator = document.getElementById('re_connection_indicator');
    if (!indicator) return;
    indicator.style.backgroundColor = online ? '#40d98a' : '#ff5b7f';
    indicator.title = online ? 'Соединение с сервером активно' : 'Нет ответа от сервера';
  }

  function updatePingDisplay(pingMs) {
    if (!pingDisplayElement) {
      pingDisplayElement = document.createElement('div');
      pingDisplayElement.id = 're_ping_display';
      pingDisplayElement.style.cssText = `
        position: fixed;
        bottom: 36px;
        left: 18px;
        color: var(--re-text-muted);
        font-size: 12px;
        font-weight: 600;
        z-index: 100000;
        background: rgba(0,0,0,0.2);
        padding: 2px 6px;
        border-radius: 8px;
        pointer-events: none;
      `;
      document.body.appendChild(pingDisplayElement);
    }
    pingDisplayElement.textContent = `${pingMs} ms`;
  }

  function resetPingTimer() {
    if (pingTimer) clearTimeout(pingTimer);
    setConnectionIndicator(true);
    pingTimer = setTimeout(() => {
      setConnectionIndicator(false);
    }, PING_TIMEOUT_MS);
  }

  function measurePing() {
    const now = Date.now();
    if (lastPingSentTime > 0) {
      pingValue = now - lastPingSentTime;
      updatePingDisplay(pingValue);
    }
    lastPingSentTime = 0;
  }

  function sendAutoBetIfNeeded() {
    if (!autoBetEnabled || !game || typeof game.send !== 'function') return;
    const betButtons = document.querySelectorAll('.game_turn_bet');
    if (betButtons.length) {
      for (const btn of betButtons) {
        if (btn.textContent.trim() === String(autoBetValue)) {
          btn.click();
          return;
        }
      }
    }
    game.send({ action: 'trade_turn', bet: String(autoBetValue) });
  }

  function clearHighlights() {
    document.querySelectorAll('.re-highlight-word').forEach(el => {
      const parent = el.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(el.textContent), el);
        parent.normalize();
      }
    });
  }

  function applyHighlightToProblem(words) {
    if (!words.length) return;
    const problemContainer = document.querySelector('.game_prob');
    if (!problemContainer) return;
    clearHighlights();
    const regex = new RegExp(`\\b(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi');
    const walker = document.createTreeWalker(problemContainer, NodeFilter.SHOW_TEXT, {
      acceptNode: node => {
        if (node.parentElement?.closest('.re-choice-button, .re-highlight-word, .game_answer, .game_prob_title')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    textNodes.forEach(node => {
      const text = node.nodeValue;
      if (!regex.test(text)) {
        regex.lastIndex = 0;
        return;
      }
      regex.lastIndex = 0;
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const before = text.slice(lastIndex, match.index);
        if (before) fragment.appendChild(document.createTextNode(before));
        const span = document.createElement('span');
        span.className = 're-highlight-word';
        span.textContent = match[0];
        fragment.appendChild(span);
        lastIndex = match.index + match[0].length;
      }
      if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      }
      const parent = node.parentNode;
      if (parent) {
        parent.replaceChild(fragment, node);
      }
    });
  }

  function getCurrentUserId() {
    if (window.user && window.user.id) return window.user.id;
    const cookieMatch = document.cookie.match(/(?:^|;\s*)user_id=([^;]+)/);
    if (cookieMatch) return parseInt(cookieMatch[1], 10);
    return null;
  }

  function getOpponentId() {
    if (game && game.opponent_id) return game.opponent_id;
    if (game && game.coplayer_id) return game.coplayer_id;
    if (game && game.coplayerId) return game.coplayerId;
    return null;
  }

  function createSubjectSelect() {
    const existing = document.querySelector('.re-subject-select');
    if (existing) return existing;

    const select = document.createElement('select');
    select.className = 're-subject-select';
    select.style.cssText = `
      margin: 5px 10px;
      padding: 8px 12px;
      background: var(--re-input-bg);
      border: 1px solid var(--re-input-border);
      border-radius: 10px;
      color: var(--re-text-main);
      font-size: 14px;
      cursor: pointer;
    `;

    const subjects = [
      { value: 'math', label: 'Математика' },
      { value: 'rus', label: 'Русский язык' },
      { value: 'phys', label: 'Физика' },
      { value: 'chem', label: 'Химия' },
      { value: 'bio', label: 'Биология' },
      { value: 'hist', label: 'История' },
      { value: 'soc', label: 'Обществознание' },
      { value: 'inf', label: 'Информатика' },
      { value: 'geo', label: 'География' },
      { value: 'eng', label: 'Английский' },
      { value: 'ger', label: 'Немецкий' },
      { value: 'fra', label: 'Французский' },
      { value: 'spa', label: 'Испанский' },
      { value: 'lit', label: 'Литература' }
    ];

    subjects.forEach(s => {
      const option = document.createElement('option');
      option.value = s.value;
      option.textContent = s.label;
      select.appendChild(option);
    });

    select.value = selectedSubject;
    select.addEventListener('change', () => {
      selectedSubject = select.value;
      saveSelectedSubject(selectedSubject);
    });

    return select;
  }

  function injectSubjectSelect() {
    const findButton = document.querySelector('.game_find_player');
    if (!findButton) return;

    const parent = findButton.parentNode;
    const existing = parent.querySelector('.re-subject-select');
    if (existing) return;

    const select = createSubjectSelect();
    parent.insertBefore(select, findButton);
  }

  function updateTimerWarning(countdownElement) {
    if (!countdownElement) return;
    const text = countdownElement.textContent || '';
    const timeMatch = text.match(/(\d+):(\d+)/);
    if (!timeMatch) return;

    const minutes = parseInt(timeMatch[1], 10);
    const seconds = parseInt(timeMatch[2], 10);
    const totalSeconds = minutes * 60 + seconds;

    countdownElement.classList.remove('re-timer-warning', 're-timer-critical');

    if (totalSeconds <= 10 && totalSeconds > 0) {
      countdownElement.classList.add('re-timer-critical');
    } else if (totalSeconds <= 30 && totalSeconds > 10) {
      countdownElement.classList.add('re-timer-warning');
    }
  }

  function patchGameMessageHandler(gameInstance) {
    const originalHandler = typeof gameInstance.message_handler === 'function'
      ? gameInstance.message_handler.bind(gameInstance)
      : null;

    gameInstance.message_handler = (resp) => {
      if (resp?.function === 'ping') {
        measurePing();
        resetPingTimer();
      }

      if (menuUI && typeof menuUI.handleSocketMessage === 'function') {
        const handledByMenu = menuUI.handleSocketMessage(resp);
        if (handledByMenu) return;
      }

      if (originalHandler) {
        originalHandler(resp);
      }

      if (resp?.function === 'show_prob') {
        currentProblemFingerprint = createProblemFingerprint(resp);
        enhanceProblemAnswerUI();
        resetResultBadgeStates();
        tryAutofillRememberedAnswer(currentProblemFingerprint);
        if (autoHighlightEnabled && highlightWords.length) {
          applyHighlightToProblem(highlightWords);
        }
      }

      if (resp?.function === 'my_result' && typeof resp.answer === 'string' && resp.right === true) {
          rememberAnswerForProblem(currentProblemFingerprint, resp.answer);
      }

      if (resp?.function === 'my_result' && typeof resp.right === 'boolean') {
        setResultBadgeState('.game_my_result', resp.right);
      }

      if (resp?.function === 'his_result' && typeof resp.right === 'boolean') {
        setResultBadgeState('.game_his_result', resp.right);
      }

      if ((resp?.function === 'trade_init' || resp?.function === 'trade_state') && autoBetEnabled) {
        const haveTurn = resp.have_turn === true || resp.have_turn === 1;
        if (haveTurn) {
          setTimeout(sendAutoBetIfNeeded, 100);
        }
      }
    };
  }

  function patchGameSend(gameInstance) {
    const originalSend = typeof gameInstance.send === 'function'
      ? gameInstance.send.bind(gameInstance)
      : null;

    if (!originalSend) return;

    gameInstance.send = (data) => {
      if (data?.action === 'give_answer') {
        const answerInput = document.querySelector('.game_answer_inp');
        const answer = answerInput ? sanitizeAnswerForSubmit(answerInput.value) : '';
        return originalSend({ ...data, answer });
      }

      if (data?.action === 'find_player') {
        const select = document.querySelector('.re-subject-select');
        if (select) {
          data.subject = select.value;
        }
      }

      return originalSend(data);
    };
  }

  function syncChoiceButtonsWithInput(problemContainer, answerInput) {
    if (!problemContainer || !answerInput) return;
    const answer = String(answerInput.value ?? '');
    problemContainer.querySelectorAll('.re-choice-button').forEach((button) => {
      const choiceValue = button.dataset.choiceValue ?? '';
      if (containsChoiceValue(answer, choiceValue)) {
        button.classList.add('is-selected');
      } else if (!button.classList.contains('is-excluded')) {
        button.classList.remove('is-selected');
      }
    });
  }

  function buildChoiceButton(choiceValue, answerInput, problemContainer) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 're-choice-button';
    button.dataset.choiceValue = choiceValue;
    button.textContent = choiceValue;

    button.addEventListener('click', () => {
      let nextAnswer = String(answerInput.value ?? '');
      const currentlySelected = button.classList.contains('is-selected');
      if (currentlySelected) {
        nextAnswer = removeChoiceValue(nextAnswer, choiceValue);
        button.classList.remove('is-selected');
        button.classList.add('is-excluded');
      } else {
        if (!containsChoiceValue(nextAnswer, choiceValue)) {
          nextAnswer += choiceValue;
        }
        button.classList.add('is-selected');
        button.classList.remove('is-excluded');
      }
      answerInput.value = sortAnswerCharacters(nextAnswer);
      syncChoiceButtonsWithInput(problemContainer, answerInput);
    });

    return button;
  }

  function replaceChoiceMarkersWithButtons(problemContainer, answerInput) {
    const textNodes = [];
    const walker = document.createTreeWalker(problemContainer, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode);
    }
    textNodes.forEach((textNode) => {
      const sourceText = textNode.nodeValue ?? '';
      CHOICE_MARKER_REGEX.lastIndex = 0;
      if (!CHOICE_MARKER_REGEX.test(sourceText)) return;
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      sourceText.replace(CHOICE_MARKER_REGEX, (fullMatch, choiceRaw, offset) => {
        if (offset > cursor) {
          fragment.appendChild(document.createTextNode(sourceText.slice(cursor, offset)));
        }
        const choiceValue = String(choiceRaw ?? '').trim();
        fragment.appendChild(buildChoiceButton(choiceValue, answerInput, problemContainer));
        cursor = offset + fullMatch.length;
        return fullMatch;
      });
      if (cursor < sourceText.length) {
        fragment.appendChild(document.createTextNode(sourceText.slice(cursor)));
      }
      if (textNode.parentNode) {
        textNode.parentNode.replaceChild(fragment, textNode);
      }
    });
  }

  function enhanceProblemAnswerUI() {
    const problemContainer = document.querySelector('.game_prob');
    const answerInput = document.querySelector('.game_answer_inp');
    if (!problemContainer || !answerInput) return;
    replaceChoiceMarkersWithButtons(problemContainer, answerInput);
    if (!answerInput.dataset.reChoiceSyncBound) {
      answerInput.dataset.reChoiceSyncBound = '1';
      answerInput.addEventListener('input', () => {
        syncChoiceButtonsWithInput(problemContainer, answerInput);
      });
    }
    syncChoiceButtonsWithInput(problemContainer, answerInput);
  }

  function unlockAnswerButton() {
    document.addEventListener('click', (event) => {
      const submitButton = event.target instanceof Element
        ? event.target.closest('.game_answer_send')
        : null;
      if (!submitButton) return;
      setTimeout(() => {
        submitButton.disabled = false;
      }, 120);
    }, true);

    const observer = new MutationObserver(() => {
      const answerBtn = document.querySelector('.game_answer_send');
      if (answerBtn) answerBtn.disabled = false;
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function observeTimer() {
    const observer = new MutationObserver(() => {
      const timerElement = document.querySelector('.game_countdown');
      if (timerElement) {
        updateTimerWarning(timerElement);
      }
    });

    const timerContainer = document.querySelector('.game_div');
    if (timerContainer) {
      observer.observe(timerContainer, { childList: true, subtree: true, characterData: true });
    }

    setInterval(() => {
      const timerElement = document.querySelector('.game_countdown');
      if (timerElement) updateTimerWarning(timerElement);
    }, 500);
  }

  function applySiteStyles() {
    injectStyle('re_helper_site_styles', `
      :root {
        --re-drawer-width: min(580px, calc(100vw - 16px));
        --re-game-reduce-factor: 1.2;
        --re-bg-main: #120f1f;
        --re-bg-glow-a: rgba(181, 143, 255, 0.20);
        --re-bg-glow-b: rgba(127, 104, 255, 0.12);
        --re-bg-card: #1f1b31;
        --re-bg-soft: #2a2540;
        --re-accent: #b58fff;
        --re-accent-2: #7f68ff;
        --re-text-main: #f4edff;
        --re-text-muted: #b8a8d6;
        --re-game-surface: linear-gradient(160deg, #26213a 0%, #1b162a 60%, #171223 100%);
        --re-game-surface-border: rgba(181, 143, 255, 0.42);
        --re-game-prob-surface: rgba(50, 43, 77, 0.55);
        --re-game-prob-border: rgba(181, 143, 255, 0.30);
        --re-player-found-surface: linear-gradient(145deg, #453061 0%, #2f2242 100%);
        --re-player-found-border: rgba(191, 155, 255, 0.65);
        --re-button-gradient: linear-gradient(135deg, #a77dff 0%, #6f62ff 100%);
        --re-button-text: #ffffff;
        --re-button-disabled-gradient: linear-gradient(135deg, #5f5678 0%, #4a4363 100%);
        --re-input-bg: rgba(20, 17, 35, 0.88);
        --re-input-border: rgba(181, 143, 255, 0.55);
        --re-turn-log-color: #cfbff0;
        --re-choice-bg: rgba(44, 33, 68, 0.92);
        --re-choice-border: rgba(181, 143, 255, 0.5);
        --re-gear-color: #f3e8ff;
      }

      html[data-re-theme='light'] {
        --re-bg-main: #eaf1ff;
        --re-bg-glow-a: rgba(90, 133, 255, 0.24);
        --re-bg-glow-b: rgba(91, 191, 170, 0.22);
        --re-text-main: #1a2f47;
        --re-text-muted: #4d6382;
        --re-game-surface: linear-gradient(160deg, #ffffff 0%, #eef4ff 58%, #e6efff 100%);
        --re-game-surface-border: rgba(112, 145, 205, 0.44);
        --re-game-prob-surface: rgba(255, 255, 255, 0.84);
        --re-game-prob-border: rgba(126, 154, 214, 0.45);
        --re-player-found-surface: linear-gradient(145deg, #edf6ff 0%, #dcecff 100%);
        --re-player-found-border: rgba(99, 141, 215, 0.5);
        --re-button-gradient: linear-gradient(135deg, #5f86ff 0%, #53b3d3 100%);
        --re-button-text: #ffffff;
        --re-button-disabled-gradient: linear-gradient(135deg, #b9c5de 0%, #a7b8d5 100%);
        --re-input-bg: rgba(255, 255, 255, 0.95);
        --re-input-border: rgba(95, 134, 255, 0.42);
        --re-turn-log-color: #1e4d8d;
        --re-choice-bg: rgba(235, 243, 255, 0.92);
        --re-choice-border: rgba(111, 142, 202, 0.55);
        --re-gear-color: #2f4f7a;
      }

      body {
        margin: 0;
        overflow: hidden !important;
        min-height: 100vh;
        background:
          radial-gradient(circle at 16% 12%, var(--re-bg-glow-a) 0%, transparent 35%),
          radial-gradient(circle at 92% 88%, var(--re-bg-glow-b) 0%, transparent 40%),
          var(--re-bg-main) !important;
        background-attachment: fixed !important;
        font-family: 'Segoe UI', 'Roboto', sans-serif !important;
        color: var(--re-text-main);
      }

      .game_gear,
      .ya-share2__container {
        display: none !important;
      }

      .game_div {
        width: min(1000px, calc((100vw - 24px) / var(--re-game-reduce-factor))) !important;
        max-width: min(1000px, calc((100vw - 24px) / var(--re-game-reduce-factor))) !important;
        min-width: 320px !important;
        height: calc((100vh - 20px) / var(--re-game-reduce-factor)) !important;
        min-height: calc((100vh - 20px) / var(--re-game-reduce-factor)) !important;
        margin: 10px auto !important;
        background: var(--re-game-surface) !important;
        border-radius: 28px !important;
        border: 1px solid var(--re-game-surface-border) !important;
        box-shadow: 0 22px 45px rgba(0, 0, 0, 0.45) !important;
        color: var(--re-text-main) !important;
        padding: 28px 28px 24px !important;
      }

      .game_his_score,
      .game_my_score,
      .game_round,
      .game_countdown,
      .game_score {
        color: var(--re-text-muted) !important;
      }

      .game_turn_order,
      .game_turn_log {
        color: var(--re-turn-log-color) !important;
        font-weight: 700;
      }

      .game_prob {
        background: var(--re-game-prob-surface) !important;
        border: 1px solid var(--re-game-prob-border) !important;
        border-radius: 18px !important;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
        left: 24px !important;
        right: 24px !important;
        top: 84px !important;
        bottom: 76px !important;
        padding: 18px 20px 50px 20px !important;
      }

      .game_prob_title {
        position: relative;
        z-index: 4;
        margin: 10px 0 14px !important;
      }

      .game_answer {
        display: flex;
        align-items: center;
        gap: 10px;
        left: 24px !important;
        right: 24px !important;
        bottom: 16px !important;
      }

      .game_my_result,
      .game_his_result {
        position: absolute !important;
        width: 236px;
        min-height: 34px;
        display: flex;
        align-items: center;
        justify-content: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: 12px;
        line-height: 1.2;
        font-weight: 700;
        padding: 6px 10px;
        border-radius: 10px;
        border: 1px solid rgba(171, 150, 211, 0.4);
        background: rgba(34, 28, 54, 0.66);
        color: var(--re-text-main) !important;
        box-sizing: border-box;
      }

      .game_my_result {
        left: 16px !important;
        right: auto !important;
        bottom: 92px !important;
        text-align: center;
      }

      .game_his_result {
        right: 16px !important;
        left: auto !important;
        bottom: 92px !important;
        text-align: center;
      }

      .game_my_result.re-status-correct,
      .game_his_result.re-status-correct {
        background: rgba(34, 92, 52, 0.74);
        border-color: rgba(124, 255, 173, 0.88);
        color: #92ffc0 !important;
      }

      .game_my_result.re-status-wrong,
      .game_his_result.re-status-wrong {
        background: rgba(120, 34, 51, 0.74);
        border-color: rgba(255, 142, 165, 0.88);
        color: #ff9ab0 !important;
      }

      .game_player_found {
        background: var(--re-player-found-surface) !important;
        border: 1px solid var(--re-player-found-border) !important;
        border-radius: 16px !important;
        color: var(--re-text-main) !important;
      }

      .game_turn_bet,
      .game_answer_send,
      .game_find_player,
      .game_hist_back,
      .game_high_back {
        background: var(--re-button-gradient) !important;
        border: 1px solid rgba(255, 255, 255, 0.18) !important;
        color: var(--re-button-text) !important;
        border-radius: 14px !important;
        padding: 11px 18px !important;
        font-size: 15px !important;
        font-weight: 700 !important;
        letter-spacing: 0.02em;
        box-shadow:
          0 10px 20px rgba(79, 56, 147, 0.40),
          inset 0 1px 0 rgba(255, 255, 255, 0.28);
        transition:
          transform 0.18s ease,
          box-shadow 0.18s ease,
          filter 0.18s ease;
      }

      .game_turn_bet:hover,
      .game_answer_send:hover,
      .game_find_player:hover,
      .game_hist_back:hover,
      .game_high_back:hover {
        transform: translateY(-1px);
        box-shadow:
          0 12px 24px rgba(79, 56, 147, 0.5),
          inset 0 1px 0 rgba(255, 255, 255, 0.34);
        filter: brightness(1.04);
      }

      .game_turn_bet:active,
      .game_answer_send:active,
      .game_find_player:active,
      .game_hist_back:active,
      .game_high_back:active {
        transform: translateY(0);
      }

      .game_turn_bet:disabled,
      .game_answer_send:disabled {
        background: var(--re-button-disabled-gradient) !important;
        color: #d3c8e8 !important;
        opacity: 0.72 !important;
        box-shadow: none !important;
      }

      .game_answer_inp {
        flex: 1;
        background: var(--re-input-bg) !important;
        border: 1px solid var(--re-input-border) !important;
        color: var(--re-text-main) !important;
        border-radius: 12px !important;
        padding: 10px 12px !important;
        outline: none !important;
        min-width: 230px;
      }

      .game_answer_inp:focus {
        border-color: #d1b7ff !important;
        box-shadow: 0 0 0 3px rgba(181, 143, 255, 0.25) !important;
      }

      .re-choice-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 34px;
        height: 30px;
        margin: 0 4px;
        padding: 0 8px;
        border: 1px solid var(--re-choice-border);
        border-radius: 8px;
        background: var(--re-choice-bg);
        color: var(--re-text-main);
        font-weight: 700;
        cursor: pointer;
        transition: background-color 0.2s ease, border-color 0.2s ease, transform 0.1s ease;
      }

      .re-choice-button:hover {
        transform: translateY(-1px);
        border-color: rgba(219, 196, 255, 0.75);
      }

      .re-choice-button.is-selected {
        background: rgba(50, 168, 92, 0.86);
        border-color: rgba(151, 255, 187, 0.9);
        color: #f4fff8;
      }

      .re-choice-button.is-excluded {
        background: rgba(182, 63, 84, 0.86);
        border-color: rgba(255, 156, 177, 0.9);
        color: #fff6f8;
      }

      .re-highlight-word {
        background: rgba(255, 235, 120, 0.3);
        color: #ffea8c;
        font-weight: 700;
        padding: 1px 2px;
        border-radius: 4px;
        border-bottom: 1px solid #ffd966;
      }

      html[data-re-theme='light'] .re-highlight-word {
        background: rgba(255, 210, 60, 0.3);
        color: #8b5e00;
        border-bottom-color: #e6a800;
      }

      .game_countdown.re-timer-warning {
        color: #ffb347 !important;
        font-weight: 800;
        animation: pulse-warning 1s infinite;
      }

      .game_countdown.re-timer-critical {
        color: #ff6b6b !important;
        font-weight: 900;
        animation: pulse-critical 0.5s infinite;
      }

      @keyframes pulse-warning {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.7; }
      }

      @keyframes pulse-critical {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.6; transform: scale(1.05); }
      }

      .game_hist_back,
      .game_high_back {
        margin: 0 !important;
        z-index: 2;
      }

      .game_hist_back {
        left: 20px !important;
        bottom: 20px !important;
      }

      .game_high_back {
        top: 20px !important;
        left: 20px !important;
      }

      .game_hist_list,
      .game_high_list {
        padding-bottom: 52px;
      }

      .game_hist_ans_r { background: rgba(99, 179, 111, 0.22) !important; }
      .game_hist_ans_w { background: rgba(222, 100, 129, 0.20) !important; }
      .game_hist_score_p { color: #7ee3a0 !important; }
      .game_hist_score_m { color: #ff94a9 !important; }
      .game_hist_ans_diff { color: inherit !important; }

      select[name="subject"],
      select[class*="subject"]:not(.re-subject-select) {
        display: none !important;
      }

      @media (max-width: 900px) {
        .game_div {
          min-width: 0 !important;
          width: calc((100vw - 20px) / var(--re-game-reduce-factor)) !important;
          max-width: calc((100vw - 20px) / var(--re-game-reduce-factor)) !important;
          height: calc((100vh - 12px) / var(--re-game-reduce-factor)) !important;
          min-height: calc((100vh - 12px) / var(--re-game-reduce-factor)) !important;
          margin-top: 10px !important;
          margin-bottom: 2px !important;
          border-radius: 20px !important;
          padding: 20px 14px 18px !important;
        }

        .game_prob {
          left: 14px !important;
          right: 14px !important;
          top: 74px !important;
          bottom: 84px !important;
          padding: 14px 14px 50px 14px !important;
        }

        .game_answer {
          flex-direction: column;
          align-items: stretch;
          left: 14px !important;
          right: 14px !important;
          bottom: 12px !important;
        }

        .game_answer_inp {
          min-width: 0;
          width: 100%;
          margin-bottom: 10px;
        }

        .game_my_result,
        .game_his_result {
          left: 14px !important;
          right: 14px !important;
          width: auto;
          max-width: none;
          white-space: nowrap;
          text-align: center;
        }

        .game_my_result {
          bottom: 142px !important;
        }

        .game_his_result {
          bottom: 106px !important;
        }
      }
    `);
  }

  class MenuController {
    constructor(gameInstance) {
      this.game = gameInstance;
      this.currentView = VIEW.MAIN;
      this.historyData = null;
      this.highscoreData = null;
      this.waitingFor = null;
      this.menuButtons = [];
      this.menuButtonsMap = new Map();

      this.createStyles();
      this.createDOM();
      this.bindEvents();
      this.registerDefaultButtons();
      this.renderMainMenu();
      this.addConnectionIndicator();
    }

    createStyles() {
      injectStyle('re_helper_drawer_styles', `
        .ReshEge_Helper_menu_toggle {
          position: fixed;
          right: 0;
          top: 50%;
          transform: translateY(-50%);
          z-index: 99997;
          border: none;
          border-radius: 16px 0 0 16px;
          background: linear-gradient(135deg, #b58fff 0%, #7f68ff 100%);
          color: white;
          padding: 14px 10px;
          writing-mode: vertical-rl;
          text-orientation: mixed;
          font-size: 15px;
          font-weight: 800;
          letter-spacing: 0.04em;
          cursor: pointer;
          box-shadow: -12px 14px 24px rgba(30, 18, 54, 0.45);
          transition: transform 0.28s ease, box-shadow 0.28s ease, opacity 0.18s ease;
        }

        .ReshEge_Helper_menu_toggle:hover {
          box-shadow: -14px 20px 28px rgba(30, 18, 54, 0.55);
        }

        .ReshEge_Helper_menu_toggle.is-open {
          transform: translateY(-50%) translateX(calc(-1 * var(--re-drawer-width) - 28px));
        }

        .ReshEge_Helper_menu_drawer {
          position: fixed;
          right: 0;
          top: 0;
          height: 100vh;
          width: var(--re-drawer-width);
          z-index: 99996;
          background: linear-gradient(170deg, #251f39 0%, #1b162a 100%);
          border-left: 1px solid rgba(181, 143, 255, 0.3);
          box-shadow: -24px 0 38px rgba(0, 0, 0, 0.42);
          transform: translateX(100%);
          transition: transform 0.28s ease;
          padding: 20px 14px 18px;
          overflow-y: auto;
          font-family: 'Segoe UI', sans-serif;
          color: #f7efff;
        }

        .ReshEge_Helper_menu_drawer.is-open {
          transform: translateX(0);
        }

        .ReshEge_Helper_view_header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-bottom: 14px;
          position: sticky;
          top: -1px;
          z-index: 3;
          background: linear-gradient(170deg, #251f39 0%, #1b162a 100%);
          padding: 4px 0 8px;
        }

        .ReshEge_Helper_drawer_title {
          margin: 0;
          font-size: 22px;
          font-weight: 800;
          color: #f0e4ff;
        }

        .ReshEge_Helper_close_button {
          width: 34px;
          height: 34px;
          border: 1px solid rgba(181, 143, 255, 0.4);
          border-radius: 10px;
          background: rgba(54, 42, 82, 0.9);
          color: #fff;
          font-size: 22px;
          line-height: 1;
          cursor: pointer;
        }

        .ReshEge_Helper_close_button:hover {
          filter: brightness(1.08);
        }

        .ReshEge_Helper_menu_button {
          display: flex;
          align-items: center;
          gap: 10px;
          width: 100%;
          padding: 13px 15px;
          margin-bottom: 10px;
          border: 1px solid rgba(187, 155, 255, 0.28);
          border-radius: 13px;
          background: linear-gradient(145deg, #3f305f 0%, #2f2548 100%);
          font-size: 15px;
          font-weight: 700;
          color: #f6efff;
          text-align: left;
          cursor: pointer;
          transition: transform 0.16s ease, filter 0.16s ease, box-shadow 0.16s ease;
          box-shadow: 0 6px 12px rgba(0, 0, 0, 0.2);
        }

        .ReshEge_Helper_menu_button:hover {
          transform: translateY(-1px);
          filter: brightness(1.06);
          box-shadow: 0 8px 16px rgba(0, 0, 0, 0.28);
        }

        .ReshEge_Helper_menu_button:focus-visible,
        .ReshEge_Helper_close_button:focus-visible {
          outline: 2px solid #e2cfff;
          outline-offset: 1px;
        }

        .ReshEge_Helper_menu_button_icon {
          font-size: 18px;
          width: 18px;
          text-align: center;
        }

        .auto-answer-on {
          background: linear-gradient(145deg, #2e7d5e 0%, #1d6e4a 100%) !important;
          border-color: rgba(106, 242, 155, 0.45) !important;
        }

        .auto-answer-off {
          background: linear-gradient(145deg, #9e424b 0%, #7d2d36 100%) !important;
          border-color: rgba(255, 144, 165, 0.45) !important;
        }

        html[data-re-theme='light'] .auto-answer-on {
          background: linear-gradient(145deg, #2a9d6e 0%, #1f855a 100%) !important;
          border-color: rgba(26, 163, 87, 0.4) !important;
          color: #ffffff;
        }

        html[data-re-theme='light'] .auto-answer-off {
          background: linear-gradient(145deg, #d65b6b 0%, #b43b4e 100%) !important;
          border-color: rgba(214, 91, 107, 0.5) !important;
          color: #ffffff;
        }

        .leaderboard-table {
          width: 100%;
          border-collapse: separate;
          border-spacing: 0;
          margin: 8px 0 12px;
          font-size: 14px;
          border-radius: 12px;
          overflow: hidden;
          background: rgba(31, 25, 48, 0.6);
        }

        .leaderboard-table th {
          text-align: left;
          padding: 10px 8px;
          background: rgba(141, 105, 209, 0.28);
          color: #f8f0ff;
          font-weight: 800;
          border-bottom: 1px solid rgba(193, 164, 255, 0.45);
        }

        .leaderboard-table td {
          padding: 9px 8px;
          border-bottom: 1px solid rgba(147, 115, 207, 0.25);
          color: #f6ecff;
        }

        .leaderboard-table td,
        .leaderboard-table td * {
          color: #f6ecff !important;
        }

        .leaderboard-table tr:nth-child(2n) {
          background: rgba(255, 255, 255, 0.03);
        }

        .leaderboard-table tr:last-child td {
          border-bottom: none;
        }

        .leaderboard-table .highlight {
          background: rgba(181, 143, 255, 0.24);
          font-weight: 700;
        }

        .history-summary {
          background: rgba(64, 46, 94, 0.72);
          border: 1px solid rgba(181, 143, 255, 0.28);
          padding: 11px 12px;
          border-radius: 12px;
          margin-bottom: 14px;
          font-weight: 700;
          color: #f0e6ff;
        }

        .match-item {
          background: rgba(51, 39, 76, 0.68);
          border-radius: 12px;
          padding: 10px 12px;
          margin-bottom: 10px;
          border-left: 3px solid #bb9bff;
        }

        .match-header {
          display: flex;
          flex-wrap: wrap;
          justify-content: space-between;
          align-items: baseline;
          gap: 6px;
          margin-bottom: 6px;
        }

        .match-time {
          font-size: 12px;
          color: #beaddb;
        }

        .match-opponent {
          font-weight: 700;
          color: #ecdfff;
        }

        .match-score {
          font-weight: 800;
          color: #9ef6bc;
        }

        .match-score.negative {
          color: #ff9cb0;
        }

        .errors-toggle {
          display: inline-block;
          margin-top: 6px;
          padding: 4px 10px;
          background: rgba(125, 93, 189, 0.55);
          border: 1px solid rgba(197, 171, 255, 0.4);
          border-radius: 20px;
          font-size: 12px;
          font-weight: 700;
          color: #f5edff;
          cursor: pointer;
          user-select: none;
        }

        .errors-list {
          margin-top: 8px;
          padding: 8px 0 0 10px;
          border-top: 1px dashed rgba(178, 145, 245, 0.5);
          display: none;
        }

        .errors-list.show {
          display: block;
        }

        .error-item {
          font-size: 12px;
          padding: 5px 0;
          border-bottom: 1px solid rgba(178, 145, 245, 0.2);
        }

        .error-item:last-child {
          border-bottom: none;
        }

        .error-link {
          color: #dec8ff;
          text-decoration: none;
          font-weight: 700;
          margin-right: 6px;
        }

        .error-link:hover {
          text-decoration: underline;
        }

        .error-detail {
          color: #d2c2ea;
        }

        #re_connection_indicator {
          position: fixed;
          bottom: 18px;
          left: 18px;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background-color: #40d98a;
          box-shadow: 0 0 10px currentColor;
          z-index: 100000;
          transition: background-color 0.28s ease;
        }

        #re_ping_display {
          font-family: 'Segoe UI', monospace;
        }

        .menu-footer {
          margin-top: 20px;
          padding-top: 12px;
          border-top: 1px solid rgba(181, 143, 255, 0.2);
          text-align: center;
          font-size: 12px;
          color: var(--re-text-muted);
        }

        html[data-re-theme='light'] .ReshEge_Helper_menu_toggle {
          background: linear-gradient(135deg, #5f86ff 0%, #53b3d3 100%);
          color: #ffffff;
          box-shadow: -10px 14px 24px rgba(61, 102, 163, 0.35);
        }

        html[data-re-theme='light'] .ReshEge_Helper_menu_drawer {
          background: linear-gradient(170deg, #f8fbff 0%, #edf4ff 100%);
          border-left-color: rgba(102, 134, 187, 0.35);
          color: #223956;
          box-shadow: -20px 0 36px rgba(34, 66, 113, 0.18);
        }

        html[data-re-theme='light'] .ReshEge_Helper_view_header {
          background: linear-gradient(170deg, #f8fbff 0%, #edf4ff 100%);
        }

        html[data-re-theme='light'] .ReshEge_Helper_drawer_title {
          color: #1c3656;
        }

        html[data-re-theme='light'] .ReshEge_Helper_close_button {
          border-color: rgba(95, 134, 255, 0.45);
          background: rgba(227, 238, 255, 0.92);
          color: #2a4a77;
        }

        html[data-re-theme='light'] .ReshEge_Helper_menu_button {
          background: linear-gradient(145deg, #f1f7ff 0%, #dfeaff 100%);
          border-color: rgba(95, 134, 255, 0.36);
          color: #204067;
          box-shadow: 0 6px 12px rgba(45, 86, 146, 0.12);
        }

        html[data-re-theme='light'] .leaderboard-table {
          background: rgba(255, 255, 255, 0.84);
        }

        html[data-re-theme='light'] .leaderboard-table th {
          background: rgba(95, 134, 255, 0.20);
          color: #1e3c62;
          border-bottom-color: rgba(95, 134, 255, 0.32);
        }

        html[data-re-theme='light'] .leaderboard-table td,
        html[data-re-theme='light'] .leaderboard-table td * {
          color: #28466b !important;
        }

        html[data-re-theme='light'] .leaderboard-table tr:nth-child(2n) {
          background: rgba(88, 124, 183, 0.08);
        }

        html[data-re-theme='light'] .leaderboard-table .highlight {
          background: rgba(95, 134, 255, 0.20);
        }

        html[data-re-theme='light'] .history-summary {
          background: rgba(242, 248, 255, 0.9);
          border-color: rgba(95, 134, 255, 0.3);
          color: #2b476a;
        }

        html[data-re-theme='light'] .match-item {
          background: rgba(248, 252, 255, 0.88);
          border-left-color: #6b94ef;
        }

        html[data-re-theme='light'] .match-time { color: #58739a; }
        html[data-re-theme='light'] .match-opponent { color: #1f3e63; }
        html[data-re-theme='light'] .match-score { color: #23964f; }
        html[data-re-theme='light'] .match-score.negative { color: #d04a69; }

        html[data-re-theme='light'] .errors-toggle {
          background: rgba(95, 134, 255, 0.16);
          border-color: rgba(95, 134, 255, 0.38);
          color: #21436a;
        }

        html[data-re-theme='light'] .errors-list {
          border-top-color: rgba(95, 134, 255, 0.33);
        }

        html[data-re-theme='light'] .error-item {
          border-bottom-color: rgba(95, 134, 255, 0.18);
        }

        html[data-re-theme='light'] .error-link { color: #2f59a2; }
        html[data-re-theme='light'] .error-detail { color: #456489; }

        html[data-re-theme='light'] .game_my_result,
        html[data-re-theme='light'] .game_his_result {
          background: rgba(236, 244, 255, 0.92);
          border: 1px solid rgba(104, 140, 206, 0.34);
          color: #27466a !important;
        }

        html[data-re-theme='light'] .game_my_result.re-status-correct,
        html[data-re-theme='light'] .game_his_result.re-status-correct {
          background: rgba(199, 245, 214, 0.95);
          border-color: rgba(54, 148, 89, 0.58);
          color: #1f7b44 !important;
        }

        html[data-re-theme='light'] .game_my_result.re-status-wrong,
        html[data-re-theme='light'] .game_his_result.re-status-wrong {
          background: rgba(255, 226, 232, 0.96);
          border-color: rgba(203, 72, 103, 0.5);
          color: #b73b58 !important;
        }

        @media (max-width: 760px) {
          .ReshEge_Helper_menu_drawer {
            width: calc(100vw - 12px);
          }

          .ReshEge_Helper_menu_toggle.is-open {
            opacity: 0;
            pointer-events: none;
            transform: translateY(-50%);
          }
        }

        .bet-button {
          display: inline-block;
          width: 60px;
          margin: 6px;
          padding: 12px 0;
          background: rgba(100, 80, 150, 0.4);
          border: 2px solid rgba(181, 143, 255, 0.5);
          border-radius: 12px;
          font-size: 18px;
          font-weight: bold;
          color: #f0e4ff;
          cursor: pointer;
          text-align: center;
          transition: all 0.15s;
        }

        .bet-button.selected {
          background: #2e8b57;
          border-color: #7cfc00;
          color: white;
          box-shadow: 0 0 12px #7cfc00;
        }

        .bet-button:hover {
          filter: brightness(1.1);
        }

        .highlight-input {
          width: 100%;
          padding: 12px;
          margin: 15px 0;
          background: var(--re-input-bg);
          border: 1px solid var(--re-input-border);
          border-radius: 12px;
          color: var(--re-text-main);
          font-size: 14px;
        }

        .toggle-button {
          padding: 12px 24px;
          margin-right: 10px;
          background: var(--re-button-gradient);
          border: none;
          border-radius: 12px;
          color: white;
          font-weight: bold;
          cursor: pointer;
        }

        .toggle-button.off {
          background: var(--re-button-disabled-gradient);
        }
      `);
    }

    createDOM() {
      this.toggleBtn = document.createElement('button');
      this.toggleBtn.type = 'button';
      this.toggleBtn.className = 'ReshEge_Helper_menu_toggle';
      this.toggleBtn.textContent = 'МЕНЮ';

      this.drawer = document.createElement('aside');
      this.drawer.className = 'ReshEge_Helper_menu_drawer';

      this.contentDiv = document.createElement('div');
      this.drawer.appendChild(this.contentDiv);

      document.body.appendChild(this.toggleBtn);
      document.body.appendChild(this.drawer);
    }

    addConnectionIndicator() {
      const indicator = document.createElement('div');
      indicator.id = 're_connection_indicator';
      document.body.appendChild(indicator);
      resetPingTimer();
    }

    bindEvents() {
      this.toggleBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        this.toggleDrawer();
      });

      document.addEventListener('click', (event) => {
        if (!this.drawer.classList.contains('is-open')) return;
        const clickInsideDrawer = this.drawer.contains(event.target);
        const clickOnToggle = this.toggleBtn.contains(event.target);
        if (!clickInsideDrawer && !clickOnToggle) {
          this.closeDrawer();
        }
      });

      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && this.drawer.classList.contains('is-open')) {
          this.closeDrawer();
        }
      });
    }

    registerMenuButton(buttonConfig) {
      if (!buttonConfig || typeof buttonConfig !== 'object') return false;
      if (typeof buttonConfig.id !== 'string' || !buttonConfig.id.trim()) return false;
      if (typeof buttonConfig.label !== 'string' || !buttonConfig.label.trim()) return false;
      if (typeof buttonConfig.onClick !== 'function') return false;
      if (this.menuButtonsMap.has(buttonConfig.id)) return false;

      const normalizedButton = {
        id: buttonConfig.id,
        label: buttonConfig.label,
        icon: typeof buttonConfig.icon === 'string' ? buttonConfig.icon : '•',
        onClick: buttonConfig.onClick,
        className: buttonConfig.className || ''
      };

      this.menuButtons.push(normalizedButton);
      this.menuButtonsMap.set(normalizedButton.id, normalizedButton);
      return true;
    }

    updateThemeToggleButton() {
      const themeButton = this.menuButtonsMap.get('re_theme_toggle');
      if (!themeButton) return;
      themeButton.label = currentTheme === THEME.DARK ? 'Тема: тёмная' : 'Тема: светлая';
      themeButton.icon = currentTheme === THEME.DARK ? '🌙' : '☀️';
    }

    updateAutoAnswerButton() {
      const autoButton = this.menuButtonsMap.get('re_auto_answer');
      if (!autoButton) return;
      autoButton.label = autoAnswerEnabled ? 'Автоответчик: ВКЛ' : 'Автоответчик: ВЫКЛ';
      autoButton.icon = autoAnswerEnabled ? '🟢' : '🔴';
      autoButton.className = autoAnswerEnabled ? 'auto-answer-on' : 'auto-answer-off';
    }

    registerDefaultButtons() {
      this.registerMenuButton({
        id: 're_leaderboard_btn',
        label: 'Таблица лидеров',
        icon: '🏆',
        onClick: () => this.showLeaderboard()
      });

      this.registerMenuButton({
        id: 're_history_btn',
        label: 'История матчей',
        icon: '🧾',
        onClick: () => this.showHistory()
      });

      this.registerMenuButton({
        id: 're_auto_answer',
        label: 'Автоответчик',
        icon: '🔴',
        className: 'auto-answer-off',
        onClick: () => {
          toggleAutoAnswer();
          this.updateAutoAnswerButton();
          this.renderMainMenu();
        }
      });

      this.registerMenuButton({
        id: 're_auto_bet',
        label: 'Автоставка',
        icon: '🎲',
        onClick: () => this.showAutoBetPanel()
      });

      this.registerMenuButton({
        id: 're_auto_highlight',
        label: 'Автовыделение',
        icon: '🔍',
        onClick: () => this.showAutoHighlightPanel()
      });

      this.registerMenuButton({
        id: 're_theme_toggle',
        label: 'Тема',
        icon: '🌓',
        onClick: () => {
          toggleTheme();
          this.updateThemeToggleButton();
          this.renderMainMenu();
        }
      });

      this.updateThemeToggleButton();
      this.updateAutoAnswerButton();
    }

    toggleDrawer() {
      if (this.drawer.classList.contains('is-open')) {
        this.closeDrawer();
      } else {
        this.openDrawer();
      }
    }

    openDrawer() {
      this.drawer.classList.add('is-open');
      this.toggleBtn.classList.add('is-open');
    }

    closeDrawer() {
      this.drawer.classList.remove('is-open');
      this.toggleBtn.classList.remove('is-open');
    }

    renderView(title, bodyHtml, options = {}) {
      const {
        showCloseButton = true,
        closeReturnsToMain = true,
        showFooter = false
      } = options;
      const safeTitle = escapeHtml(title);
      const footerHtml = showFooter ? '<div class="menu-footer"><a href="https://github.com/Danex-Exe" target="_blank" rel="noopener noreferrer" style="color: inherit; text-decoration: none;">by Danex-Exe</a></div>' : '';
      this.contentDiv.innerHTML = `
        <div class="ReshEge_Helper_view_header">
          <h3 class="ReshEge_Helper_drawer_title">${safeTitle}</h3>
          ${showCloseButton ? '<button class="ReshEge_Helper_close_button" type="button" id="re_close_btn" aria-label="Закрыть">×</button>' : ''}
        </div>
        <div>${bodyHtml}</div>
        ${footerHtml}
      `;

      const closeBtn = this.contentDiv.querySelector('#re_close_btn');
      if (closeBtn) {
        closeBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          if (closeReturnsToMain) {
            this.renderMainMenu();
          } else {
            this.closeDrawer();
          }
        });
      }
    }

    renderMainMenu() {
      this.currentView = VIEW.MAIN;
      this.updateThemeToggleButton();
      this.updateAutoAnswerButton();

      const buttonsHtml = this.menuButtons.map((button) => {
        return `
          <button class="ReshEge_Helper_menu_button ${button.className || ''}" type="button" data-menu-action="${escapeHtml(button.id)}">
            <span class="ReshEge_Helper_menu_button_icon">${escapeHtml(button.icon)}</span>
            <span>${escapeHtml(button.label)}</span>
          </button>
        `;
      }).join('');

      this.renderView(`${SCRIPT_META.title} ${SCRIPT_META.version}`, buttonsHtml, { showCloseButton: false, showFooter: true });

      this.contentDiv.querySelectorAll('[data-menu-action]').forEach((buttonElement) => {
        buttonElement.addEventListener('click', (event) => {
          event.stopPropagation();
          const actionId = buttonElement.getAttribute('data-menu-action');
          const menuButton = this.menuButtonsMap.get(actionId);
          if (!menuButton) return;
          try {
            menuButton.onClick({ menu: this, game: this.game });
          } catch (error) {
            console.error('[ReshEge-Helper] Ошибка кнопки меню:', error);
          }
        });
      });
    }

    showAutoBetPanel() {
      this.currentView = VIEW.AUTO_BET;
      this.renderAutoBetPanel();
    }

    renderAutoBetPanel() {
      const betOptions = [10, 20, 30, 40, 50];
      const betButtonsHtml = betOptions.map(bet => {
        const selected = autoBetEnabled && autoBetValue === bet ? 'selected' : '';
        return `<div class="bet-button ${selected}" data-bet="${bet}">${bet}</div>`;
      }).join('');

      const bodyHtml = `
        <div style="padding: 10px;">
          <p style="margin-bottom: 12px;">Выберите ставку для автоставки. Если ставка выбрана, она будет автоматически делаться при вашем ходе.</p>
          <div style="display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin: 20px 0;">
            ${betButtonsHtml}
          </div>
          <p style="font-size: 12px; color: var(--re-text-muted);">Нажмите на ставку, чтобы включить автоставку. Повторное нажатие на выбранную ставку отключит автоставку.</p>
        </div>
      `;

      this.renderView('🎲 Автоставка', bodyHtml, { closeReturnsToMain: true });

      this.contentDiv.querySelectorAll('.bet-button').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const betValue = parseInt(e.currentTarget.dataset.bet, 10);
          if (autoBetEnabled && autoBetValue === betValue) {
            autoBetEnabled = false;
          } else {
            autoBetEnabled = true;
            autoBetValue = betValue;
          }
          saveAutoBetPreference();
          this.renderAutoBetPanel();
        });
      });
    }

    showAutoHighlightPanel() {
      this.currentView = VIEW.AUTO_HIGHLIGHT;
      this.renderAutoHighlightPanel();
    }

    renderAutoHighlightPanel() {
      const wordsString = highlightWords.join(', ');
      const toggleText = autoHighlightEnabled ? 'Выключить' : 'Включить';
      const toggleClass = autoHighlightEnabled ? '' : 'off';

      const bodyHtml = `
        <div style="padding: 10px;">
          <p>Введите слова через запятую, которые нужно подсвечивать в тексте задания:</p>
          <input type="text" id="highlight-words-input" class="highlight-input" placeholder="например: имя, фамилия, год" value="${escapeHtml(wordsString)}">
          <div style="display: flex; margin-top: 20px;">
            <button id="toggle-highlight" class="toggle-button ${toggleClass}">${toggleText}</button>
            <button id="save-words" class="toggle-button">Сохранить список</button>
          </div>
          <p style="font-size: 12px; margin-top: 20px;">Подсветка работает только когда отображается текст задания.</p>
        </div>
      `;

      this.renderView('🔍 Автовыделение', bodyHtml, { closeReturnsToMain: true });

      document.getElementById('toggle-highlight').addEventListener('click', (e) => {
        e.stopPropagation();
        autoHighlightEnabled = !autoHighlightEnabled;
        saveAutoHighlightPreference();
        if (autoHighlightEnabled && highlightWords.length) {
          applyHighlightToProblem(highlightWords);
        } else {
          clearHighlights();
        }
        this.renderAutoHighlightPanel();
      });

      document.getElementById('save-words').addEventListener('click', (e) => {
        e.stopPropagation();
        const input = document.getElementById('highlight-words-input');
        const raw = input.value;
        const words = raw.split(',').map(w => w.trim()).filter(w => w.length > 0);
        highlightWords = words;
        saveAutoHighlightPreference();
        if (autoHighlightEnabled) {
          if (words.length) {
            applyHighlightToProblem(words);
          } else {
            clearHighlights();
          }
        }
        this.renderAutoHighlightPanel();
      });
    }

    requestData(action, waitingType) {
      if (!this.game || typeof this.game.send !== 'function') return;
      this.waitingFor = waitingType;
      this.game.send({ action });
    }

    handleSocketMessage(resp) {
      if (!resp || !resp.function || !this.waitingFor) return false;

      const waitingHistory = this.waitingFor === VIEW.HISTORY && resp.function === 'show_history';
      const waitingLeaderboard = this.waitingFor === VIEW.LEADERBOARD && resp.function === 'show_highscore';

      if (!waitingHistory && !waitingLeaderboard) return false;

      this.waitingFor = null;

      if (waitingHistory) {
        this.historyData = resp;
        if (this.currentView === VIEW.HISTORY) this.renderHistory();
      }

      if (waitingLeaderboard) {
        this.highscoreData = resp;
        if (this.currentView === VIEW.LEADERBOARD) this.renderHighscore();
      }

      return true;
    }

    showLeaderboard() {
      this.currentView = VIEW.LEADERBOARD;
      if (this.highscoreData) {
        this.renderHighscore();
        return;
      }
      this.renderView('🏆 Таблица лидеров', '<p>Загрузка...</p>', { closeReturnsToMain: true });
      this.requestData('get_highscore', VIEW.LEADERBOARD);
    }

    showHistory() {
      this.currentView = VIEW.HISTORY;
      if (this.historyData) {
        this.renderHistory();
        return;
      }
      this.renderView('🧾 История матчей', '<p>Загрузка...</p>', { closeReturnsToMain: true });
      this.requestData('get_history', VIEW.HISTORY);
    }

    renderHighscore() {
      const rows = safeArray(this.highscoreData?.scores).map((item) => {
        const rowClass = item?.bold ? 'highlight' : '';
        const number = escapeHtml(item?.num ?? '');
        const name = escapeHtml(item?.name ?? '');
        const score = escapeHtml(item?.score ?? '');
        return `
          <tr class="${rowClass}">
            <td>${number}</td>
            <td>${name}</td>
            <td style="text-align:right;">${score}</td>
          </tr>
        `;
      }).join('');

      const bodyHtml = `
        <table class="leaderboard-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Игрок</th>
              <th>Очки</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="3">Нет данных</td></tr>'}</tbody>
        </table>
      `;

      this.renderView('🏆 Таблица лидеров', bodyHtml, { closeReturnsToMain: true });
    }

    buildErrorsHtml(gameItem, gameIndex) {
      const wrongAnswers = safeArray(gameItem?.problems).filter((problem) => problem?.result === 0);
      const errorsCount = wrongAnswers.length;
      const totalProblems = safeArray(gameItem?.problems).length;

      if (errorsCount === 0) {
        return '<div style="font-size:12px; color:#c3b5dd; margin-top:6px;">без ошибок</div>';
      }

      const errorItems = wrongAnswers.map((error) => {
        const subj = escapeHtml(error?.subj ?? '');
        const probId = escapeHtml(error?.prob_id ?? '');
        const subject = escapeHtml(error?.subject ?? '');
        const answer = escapeHtml(error?.answer ?? '');
        const scoreDiffRaw = Number(error?.score_diff ?? 0);
        const scoreDiff = `${scoreDiffRaw > 0 ? '+' : ''}${scoreDiffRaw}`;
        return `
          <div class="error-item">
            <a href="https://${subj}-ege.sdamgia.ru/problem?id=${probId}" target="_blank" rel="noopener noreferrer" class="error-link">#${probId}</a>
            <span class="error-detail">${subject} · ответ: ${answer} · ${escapeHtml(scoreDiff)}</span>
          </div>
        `;
      }).join('');

      return `
        <div class="errors-toggle" data-game-idx="${gameIndex}">ошибки ${errorsCount}/${totalProblems}</div>
        <div class="errors-list" id="errors-${gameIndex}">${errorItems}</div>
      `;
    }

    async renderHistory() {
      const games = safeArray(this.historyData?.games);
      const totalGames = this.historyData?.count ?? games.length;
      const totalScore = this.game?.score_total ?? '—';

      const leaderboardData = await getLeaderboardData();

      const matchesHtml = games.map((match, index) => {
        const score = Number(match?.score ?? 0);
        const scoreClass = score >= 0 ? '' : 'negative';
        const scoreText = `${score >= 0 ? '+' : ''}${score}`;
        let opponentName = getOpponentDisplayName(match);

        const opponentId = match?.coplayer_id || match?.opponent_id || match?.coplayerId;
        if (opponentId && leaderboardData) {
          const rankInfo = getOpponentRankInfo(opponentId, leaderboardData);
          if (rankInfo) {
            opponentName = `Топ-${rankInfo.rank} ${opponentName} (${rankInfo.score} очк.)`;
          }
        }

        return `
          <div class="match-item">
            <div class="match-header">
              <span class="match-time">${escapeHtml(match?.beginning ?? '')}</span>
              <span class="match-opponent">соперник: ${escapeHtml(opponentName)}</span>
              <span class="match-score ${scoreClass}">${escapeHtml(scoreText)}</span>
            </div>
            ${this.buildErrorsHtml(match, index)}
          </div>
        `;
      }).join('');

      const bodyHtml = `
        <div class="history-summary">Сыграно игр: ${escapeHtml(totalGames)}, общий счёт: ${escapeHtml(totalScore)}</div>
        <div id="re_history_container">${matchesHtml || '<p>Матчи пока отсутствуют.</p>'}</div>
      `;

      this.renderView('🧾 История матчей', bodyHtml, { closeReturnsToMain: true });

      this.contentDiv.querySelectorAll('.errors-toggle').forEach((toggle) => {
        toggle.addEventListener('click', (event) => {
          event.stopPropagation();
          const gameIndex = toggle.getAttribute('data-game-idx');
          const list = this.contentDiv.querySelector(`#errors-${gameIndex}`);
          if (list) list.classList.toggle('show');
        });
      });
    }
  }

  function addExternalMenuButton(buttonConfig) {
    queuedExternalButtons.push(buttonConfig);
    if (!menuUI) return;
    const added = menuUI.registerMenuButton(buttonConfig);
    if (added && menuUI.currentView === VIEW.MAIN) {
      menuUI.renderMainMenu();
    }
  }

  function exposePublicApi() {
    window.ReshEgeHelper = Object.assign(window.ReshEgeHelper || {}, {
      version: SCRIPT_META.version,
      addMenuButton: addExternalMenuButton,
      getTheme: () => currentTheme,
      setTheme: (theme) => applyTheme(theme, true),
      toggleTheme: () => toggleTheme()
    });
  }

  async function init() {
    currentTheme = loadThemePreference();
    applyTheme(currentTheme, false);
    answerCache = loadAnswerCache();
    autoAnswerEnabled = loadAutoAnswerPreference();
    loadAutoBetPreference();
    loadAutoHighlightPreference();
    selectedSubject = loadSelectedSubject();
    exposePublicApi();
    applySiteStyles();

    const gameInstance = await waitForGame();
    game = gameInstance;

    menuUI = new MenuController(gameInstance);

    queuedExternalButtons.forEach((buttonConfig) => {
      menuUI.registerMenuButton(buttonConfig);
    });

    menuUI.renderMainMenu();

    bindGlobalAnswerHotkeys();
    patchGameSend(gameInstance);
    patchGameMessageHandler(gameInstance);
    unlockAnswerButton();
    observeTimer();

    const observer = new MutationObserver(() => {
      injectSubjectSelect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    injectSubjectSelect();

    console.log(`[${SCRIPT_META.title}] Инициализировано (${SCRIPT_META.version}).`);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();