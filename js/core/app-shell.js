// ==========================================================================
// FILE: js/core/app-shell.js (JAPAR PUBLIK v5.5 - PARSER FIRESTORE, PENGELOLA TEMA
//       OTOMATIS JAM LOKAL WIB, SAPAAN WAKTU DINAMIS, & ROUTER 5-HALAMAN KONTEKSTUAL)
// ==========================================================================

import { picuGetarSentuh } from '../utils/math-engine.js';

export const FirestoreParser = {
    parseFirestoreValue: function(valObj) {
        if (!valObj || typeof valObj !== 'object') return null;
        if ('stringValue' in valObj) return String(valObj.stringValue);
        if ('booleanValue' in valObj) return Boolean(valObj.booleanValue);
        if ('integerValue' in valObj) return Number(valObj.integerValue);
        if ('doubleValue' in valObj) return Number(valObj.doubleValue);
        if ('nullValue' in valObj) return null;
        if ('timestampValue' in valObj) {
            const t = Date.parse(valObj.timestampValue);
            return isNaN(t) ? 0 : t;
        }
        if ('mapValue' in valObj) {
            return this.parseFirestoreFields(valObj.mapValue?.fields || {});
        }
        if ('arrayValue' in valObj) {
            const arr = valObj.arrayValue?.values;
            return Array.isArray(arr) ? arr.map((v) => this.parseFirestoreValue(v)) : [];
        }
        return null;
    },

    parseFirestoreFields: function(fieldsMap) {
        const out = {};
        if (!fieldsMap || typeof fieldsMap !== 'object') return out;
        for (const [k, v] of Object.entries(fieldsMap)) {
            out[k] = this.parseFirestoreValue(v);
        }
        return out;
    }
};
window.FirestoreParser = FirestoreParser;

// ==========================================================================
// PENGELOLA MODE TAMPILAN (OTOMATIS JAM LOKAL / SIANG / MALAM) & SAPAAN DINAMIS
// ==========================================================================
const THEME_STORAGE_KEY = 'japar_theme_mode_v1';

const SVG_ICON_AUTO = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3v18"/><path d="M12 3a9 9 0 0 1 0 18" fill="currentColor" fill-opacity="0.35"/></svg>`;
const SVG_ICON_LIGHT = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;
const SVG_ICON_DARK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;

export const JaparThemeManager = {
    _currentPref: 'auto',
    _resolvedTheme: 'dark',
    _autoTimer: null,
    _isDropdownOpen: false,

    init: function() {
        let savedPref = 'auto';
        try {
            const raw = localStorage.getItem(THEME_STORAGE_KEY);
            if (raw === 'light' || raw === 'dark' || raw === 'auto') {
                savedPref = raw;
            }
        } catch (e) {}

        this._currentPref = savedPref;
        this._setupAutoTimeWatcher();
        this.applyThemePreference(this._currentPref, false);
        this.updateDynamicTimeGreeting();
        this._bindDropdownEvents();
    },

    updateDynamicTimeGreeting: function() {
        const eyebrowEl = document.getElementById('dynamicGreetingEyebrow');
        const titleEl = document.getElementById('dynamicGreetingTitle');
        const hr = new Date().getHours();

        let waktuSapaan = 'SELAMAT MALAM';
        let pesanUtama = 'Temukan Hidangan Hangat & Kuliner Pilihan di Sekitar Pare';

        if (hr >= 4 && hr < 11) {
            waktuSapaan = 'SELAMAT PAGI';
            pesanUtama = 'Awali Hari dengan Sarapan & Minuman Segar dari Dapur Pare';
        } else if (hr >= 11 && hr < 15) {
            waktuSapaan = 'SELAMAT SIANG';
            pesanUtama = 'Pilihan Hidangan Makan Siang & Minuman Segar di Sekitar Pare';
        } else if (hr >= 15 && hr < 18) {
            waktuSapaan = 'SELAMAT SORE';
            pesanUtama = 'Nikmati Kopi, Camilan Sore, & Kuliner Lokal di Sekitar Pare';
        }

        if (eyebrowEl) {
            eyebrowEl.textContent = `${waktuSapaan} • JARINGAN KULINER PARE`;
        }
        if (titleEl) {
            titleEl.textContent = pesanUtama;
        }
    },

    _detectLocalTimeTheme: function() {
        const hr = new Date().getHours();
        return (hr >= 6 && hr < 18) ? 'light' : 'dark';
    },

    _setupAutoTimeWatcher: function() {
        if (this._autoTimer) clearInterval(this._autoTimer);
        this._autoTimer = setInterval(() => {
            this.updateDynamicTimeGreeting();
            if (this._currentPref === 'auto') {
                this.applyThemePreference('auto', false);
            }
        }, 60 * 1000);

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                this.updateDynamicTimeGreeting();
                if (this._currentPref === 'auto') {
                    this.applyThemePreference('auto', false);
                }
            }
        });
    },

    applyThemePreference: function(pref, persist = true) {
        const cleanPref = (pref === 'light' || pref === 'dark') ? pref : 'auto';
        this._currentPref = cleanPref;

        if (persist) {
            try {
                localStorage.setItem(THEME_STORAGE_KEY, cleanPref);
            } catch (e) {}
        }

        const resolved = cleanPref === 'auto' ? this._detectLocalTimeTheme() : cleanPref;
        this._resolvedTheme = resolved;

        const root = document.documentElement;
        if (root) {
            root.setAttribute('data-theme-pref', cleanPref);
            root.setAttribute('data-theme', resolved);
        }

        const metaTheme = document.getElementById('metaThemeColor');
        if (metaTheme) {
            metaTheme.setAttribute('content', resolved === 'light' ? '#EEF1F5' : '#11141A');
        }

        this._syncDropdownUI();
    },

    _syncDropdownUI: function() {
        const isAutoNight = this._currentPref === 'auto' && this._resolvedTheme === 'dark';
        const labelMap = {
            'auto': 'Auto',
            'light': 'Siang',
            'dark': 'Malam'
        };
        const svgMap = {
            'auto': isAutoNight ? SVG_ICON_DARK : SVG_ICON_AUTO,
            'light': SVG_ICON_LIGHT,
            'dark': SVG_ICON_DARK
        };

        const activeLabelEl = document.getElementById('themeDropdownActiveLabel');
        const activeSvgWrapEl = document.getElementById('themeDropdownActiveSvgWrap');

        if (activeLabelEl) {
            activeLabelEl.textContent = labelMap[this._currentPref] || 'Auto';
        }
        if (activeSvgWrapEl) {
            activeSvgWrapEl.innerHTML = svgMap[this._currentPref] || SVG_ICON_AUTO;
        }

        document.querySelectorAll('.theme-dropdown-item').forEach(item => {
            const choice = item.getAttribute('data-theme-choice');
            item.classList.toggle('active', choice === this._currentPref);
        });
    },

    toggleDropdown: function(forceState) {
        const wrapper = document.getElementById('themeDropdownWrapper');
        const menu = document.getElementById('themeDropdownMenu');
        const btn = document.getElementById('btnThemeDropdownToggle');
        if (!wrapper || !menu || !btn) return;

        const nextState = typeof forceState === 'boolean' ? forceState : !this._isDropdownOpen;
        this._isDropdownOpen = nextState;

        wrapper.classList.toggle('is-open', nextState);
        menu.classList.toggle('hidden', !nextState);
        btn.setAttribute('aria-expanded', nextState ? 'true' : 'false');
    },

    _bindDropdownEvents: function() {
        const btnToggle = document.getElementById('btnThemeDropdownToggle');
        const wrapper = document.getElementById('themeDropdownWrapper');

        if (btnToggle) {
            btnToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                picuGetarSentuh(10);
                this.toggleDropdown();
            });
        }

        document.querySelectorAll('.theme-dropdown-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                picuGetarSentuh(12);
                const choice = item.getAttribute('data-theme-choice') || 'auto';
                this.applyThemePreference(choice, true);
                this.toggleDropdown(false);
            });
        });

        document.addEventListener('click', (e) => {
            if (this._isDropdownOpen && wrapper && !wrapper.contains(e.target)) {
                this.toggleDropdown(false);
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this._isDropdownOpen) {
                this.toggleDropdown(false);
            }
        });
    }
};
window.JaparThemeManager = JaparThemeManager;

// ==========================================================================
// ROUTER MULTI-HALAMAN MANDIRI DENGAN HISTORY API (pushState & popstate)
// Mendukung 5 Halaman: 'explore' | 'store' | 'checkout' | 'orders' | 'profile'
// ==========================================================================
const VALID_PAGES = ['explore', 'store', 'checkout', 'orders', 'profile'];

export const JaparPageRouter = {
    _currentPage: 'explore',
    _listeners: [],

    init: function() {
        try {
            window.history.replaceState({ japarPage: 'explore' }, '', window.location.pathname + window.location.search);
        } catch (e) {}

        window.addEventListener('popstate', (e) => {
            const targetPage = (e.state && VALID_PAGES.includes(e.state.japarPage))
                ? e.state.japarPage
                : 'explore';
            this._activatePageDOM(targetPage, e.state || {});
        });

        document.querySelectorAll('#publicBottomNav .bottom-nav-item').forEach(btn => {
            btn.addEventListener('click', () => {
                picuGetarSentuh(10);
                const page = btn.getAttribute('data-nav-page') || 'explore';
                this.navigateTo(page);
            });
        });

        this._activatePageDOM(this._currentPage, {});
    },

    getCurrentPage: function() {
        return this._currentPage;
    },

    onPageChanged: function(callback) {
        if (typeof callback === 'function') {
            this._listeners.push(callback);
        }
    },

    navigateTo: function(pageName, stateMeta = {}, replace = false) {
        const cleanPage = VALID_PAGES.includes(pageName) ? pageName : 'explore';
        if (cleanPage === this._currentPage && !stateMeta.force) {
            return;
        }

        const historyObj = { japarPage: cleanPage, ...(stateMeta || {}) };
        try {
            if (replace) {
                window.history.replaceState(historyObj, '', window.location.pathname + window.location.search);
            } else {
                window.history.pushState(historyObj, '', window.location.pathname + window.location.search);
            }
        } catch (e) {}

        this._activatePageDOM(cleanPage, historyObj);
    },

    _activatePageDOM: function(cleanPage, stateObj = {}) {
        this._currentPage = cleanPage;

        VALID_PAGES.forEach(p => {
            const sectionEl = document.getElementById(`page-${p}`);
            if (sectionEl) {
                const isTarget = (p === cleanPage);
                sectionEl.classList.toggle('hidden', !isTarget);
                sectionEl.classList.toggle('active-page', isTarget);
                if (isTarget) {
                    sectionEl.scrollTop = 0;
                }
            }
        });

        // Aturan Visibilitas Kontekstual Anti-Tumpuk (#publicBottomNav):
        // Tampil solid pada halaman utama ('explore', 'orders', 'profile')
        // Otomatis disembunyikan pada sub-halaman ('store', 'checkout')
        const bottomNavEl = document.getElementById('publicBottomNav');
        if (bottomNavEl) {
            const isSubPageWithoutBottomNav = (cleanPage === 'store' || cleanPage === 'checkout');
            bottomNavEl.classList.toggle('hidden', isSubPageWithoutBottomNav);
            bottomNavEl.classList.remove('is-nav-collapsed');
        }

        document.querySelectorAll('#publicBottomNav .bottom-nav-item').forEach(btn => {
            const navTarget = btn.getAttribute('data-nav-page');
            const isActive = (navTarget === cleanPage) || (cleanPage === 'store' && navTarget === 'explore');
            btn.classList.toggle('active', isActive);
        });

        this._listeners.forEach(fn => {
            try {
                fn(cleanPage, stateObj);
            } catch (e) {}
        });
    }
};
window.JaparPageRouter = JaparPageRouter;

(() => {
    const _boot = () => {
        JaparThemeManager.init();
        JaparPageRouter.init();
    };
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", _boot, { once: true });
    } else {
        _boot();
    }
})();
