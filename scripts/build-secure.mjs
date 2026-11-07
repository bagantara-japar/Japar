// ==========================================================================
// FILE: scripts/build-secure.mjs (JAPAR PUBLIK COMPILER v4.8 - DUAL-NODE SHARDING)
// FUNGSI:
//   1. Enkripsi Konfigurasi (JAPAR_PUBLIC_NODES, firebaseConfigNode1, firebaseConfigNode2,
//      firebaseConfig & cloudinaryConfig) -> RC4 + XOR Byte Array Vault
//   2. Bundling 5 Modul JS Publik -> Single-IIFE Closure (dist/js/japar-publik.min.js)
//      tanpa merusak binding event DOM (window/document native)
//   3. AST + RC4 String Array Obfuscation + Terser Minification
//   4. Kompilasi dist/index.html, dist/service-worker.js, & dist/css/theme.css
// ==========================================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

function loadOptionalModule(modName) {
    const searchPaths = [
        ROOT_DIR,
        path.join(ROOT_DIR, 'node_modules'),
        '/usr/share/nodejs',
        '/usr/local/lib/node_modules',
        '/usr/lib/nodejs'
    ];
    for (const base of searchPaths) {
        try {
            const req = createRequire(path.join(base, 'noop.js'));
            return req(modName);
        } catch (e) {}
    }
    return null;
}

const acorn = loadOptionalModule('acorn');
const terser = loadOptionalModule('terser');

function buildRuntimeConfig() {
    const firebaseConfigNode1 = {
        apiKey: "AIzaSyBOCoI-PzDg89AZmAWjryioJj1hIBPuLso",
        authDomain: "japar-b1c5d.firebaseapp.com",
        databaseURL: "https://japar-b1c5d-default-rtdb.asia-southeast1.firebasedatabase.app",
        projectId: "japar-b1c5d",
        storageBucket: "japar-b1c5d.firebasestorage.app",
        messagingSenderId: "332026051029",
        appId: "1:332026051029:web:281bc141eb6ff58f9f255c"
    };

    const firebaseConfigNode2 = {
        apiKey: "AIzaSyD1YmNrYAwTOcBGSozKKDztUr8fC0C-lKQ",
        authDomain: "japar-2.firebaseapp.com",
        databaseURL: "https://japar-2-default-rtdb.asia-southeast1.firebasedatabase.app",
        projectId: "japar-2",
        storageBucket: "japar-2.firebasestorage.app",
        messagingSenderId: "805858048959",
        appId: "1:805858048959:web:2f017343aba69c89d67f0a"
    };

    const JAPAR_PUBLIC_NODES = [
        { id: "N1", projectId: firebaseConfigNode1.projectId, databaseURL: firebaseConfigNode1.databaseURL, apiKey: firebaseConfigNode1.apiKey },
        { id: "N2", projectId: firebaseConfigNode2.projectId, databaseURL: firebaseConfigNode2.databaseURL, apiKey: firebaseConfigNode2.apiKey }
    ];

    const firebaseConfig = firebaseConfigNode1;

    const cloudinaryConfig = {
        cloudName: "odo6kdaz",
        uploadPreset: "my-archivestory",
        uploadEndpoint: "https://api.cloudinary.com/v1_1/odo6kdaz/image/upload",
        deliveryBaseUrl: "https://res.cloudinary.com/odo6kdaz/image/upload/f_auto,q_auto,w_400/"
    };

    const JAPAR_GAS_MAPS_URL = "https://script.google.com/macros/s/AKfycbwEDdv6dBZ878K93thmk5MgdfqZieEHA_wLXprJfe29EZ5lghRsoP-APysm2HcrK6q8/exec";

    const configPublicMerchant = {
        projectId: firebaseConfig.projectId,
        databaseURL: firebaseConfig.databaseURL,
        gasMapsUrl: JAPAR_GAS_MAPS_URL,
        defaultCenter: { lat: -7.768049, lng: 112.196514 },
        maxRadiusKm: 20.0
    };

    return {
        firebaseConfigNode1,
        firebaseConfigNode2,
        JAPAR_PUBLIC_NODES,
        firebaseConfig,
        cloudinaryConfig,
        JAPAR_GAS_MAPS_URL,
        configPublicMerchant
    };
}

function rc4XorEncryptBytes(plainTextStr, keyBytes, xorSeed) {
    const inputBytes = Buffer.from(plainTextStr, 'utf8');
    const S = new Uint8Array(256);
    for (let i = 0; i < 256; i++) S[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
        j = (j + S[i] + keyBytes[i % keyBytes.length]) & 0xff;
        const tmp = S[i]; S[i] = S[j]; S[j] = tmp;
    }
    let i = 0; j = 0;
    const out = [];
    for (let idx = 0; idx < inputBytes.length; idx++) {
        i = (i + 1) & 0xff;
        j = (j + S[i]) & 0xff;
        const tmp = S[i]; S[i] = S[j]; S[j] = tmp;
        const k = S[(S[i] + S[j]) & 0xff];
        const rollingXor = (xorSeed + ((idx * 31) & 0xff)) & 0xff;
        out.push((inputBytes[idx] ^ k ^ rollingXor) & 0xff);
    }
    return out;
}

function generateConfigVaultBlock(configObj) {
    const jsonStr = JSON.stringify(configObj);
    const keyBytes = Array.from(crypto.randomBytes(16));
    const xorSeed = crypto.randomInt(17, 241);
    const encryptedBytes = rc4XorEncryptBytes(jsonStr, keyBytes, xorSeed);

    return `
    const __JAPAR_PUBLIC_VAULT__ = [${encryptedBytes.join(',')}];
    const __JAPAR_VAULT_KEY__ = [${keyBytes.join(',')}];
    const __JAPAR_VAULT_SEED__ = ${xorSeed};
    const {
        firebaseConfigNode1,
        firebaseConfigNode2,
        JAPAR_PUBLIC_NODES,
        firebaseConfig,
        cloudinaryConfig,
        JAPAR_GAS_MAPS_URL,
        configPublicMerchant
    } = (function(_v, _k, _seed) {
        const _s = new Uint8Array(256);
        for (let _i = 0; _i < 256; _i++) _s[_i] = _i;
        let _j = 0;
        for (let _i = 0; _i < 256; _i++) {
            _j = (_j + _s[_i] + _k[_i % _k.length]) & 255;
            const _t = _s[_i]; _s[_i] = _s[_j]; _s[_j] = _t;
        }
        let _x = 0; _j = 0;
        const _out = new Uint8Array(_v.length);
        for (let _p = 0; _p < _v.length; _p++) {
            _x = (_x + 1) & 255;
            _j = (_j + _s[_x]) & 255;
            const _t = _s[_x]; _s[_x] = _s[_j]; _s[_j] = _t;
            const _ks = _s[(_s[_x] + _s[_j]) & 255];
            const _rx = (_seed + ((_p * 31) & 255)) & 255;
            _out[_p] = (_v[_p] ^ _ks ^ _rx) & 255;
            _v[_p] = 0;
        }
        _k.fill(0);
        return JSON.parse(new TextDecoder().decode(_out));
    })(__JAPAR_PUBLIC_VAULT__, __JAPAR_VAULT_KEY__, __JAPAR_VAULT_SEED__);
`;
}

const MODULES_ORDER = [
    'js/config/credentials.js',
    'js/utils/math-engine.js',
    'js/core/app-shell.js',
    'js/modules/location-service.js',
    'js/modules/catalog-order.js'
];

function stripImportsAndExportsRegexFallback(code) {
    return String(code || '')
        .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
        .replace(/^\s*import\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
        .replace(/^\s*export\s+default\s+/gm, '')
        .replace(/^\s*export\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/gm, '')
        .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '')
        .trim();
}

function stripImportsAndExports(code) {
    if (!acorn || typeof acorn.parse !== 'function') {
        return stripImportsAndExportsRegexFallback(code);
    }
    const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
    const edits = [];
    for (const node of ast.body) {
        if (node.type === 'ImportDeclaration') {
            edits.push({ start: node.start, end: node.end, replacement: '' });
        } else if (node.type === 'ExportNamedDeclaration') {
            if (node.declaration) {
                edits.push({ start: node.start, end: node.declaration.start, replacement: '' });
            } else {
                edits.push({ start: node.start, end: node.end, replacement: '' });
            }
        } else if (node.type === 'ExportDefaultDeclaration') {
            edits.push({ start: node.start, end: node.declaration.start, replacement: '' });
        }
    }
    edits.sort((a, b) => b.start - a.start);
    let out = code;
    for (const ed of edits) {
        out = out.slice(0, ed.start) + ed.replacement + out.slice(ed.end);
    }
    return out.trim();
}

function buildSingleIifeBundleSource() {
    const runtimeConfig = buildRuntimeConfig();
    const moduleBodies = [];

    for (const relPath of MODULES_ORDER) {
        if (relPath === 'js/config/credentials.js') {
            moduleBodies.push(generateConfigVaultBlock(runtimeConfig));
            continue;
        }
        const raw = fs.readFileSync(path.join(ROOT_DIR, relPath), 'utf8');
        moduleBodies.push(stripImportsAndExports(raw));
    }

    return `(function() {
    "use strict";
    ${moduleBodies.join('\n\n')}
})();`;
}

function rc4TransformHex(str, key) {
    const s = new Uint8Array(256);
    for (let i = 0; i < 256; i++) s[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
        j = (j + s[i] + key.charCodeAt(i % key.length)) & 0xff;
        const t = s[i]; s[i] = s[j]; s[j] = t;
    }
    const utf8Bytes = Buffer.from(str, 'utf8');
    let i = 0; j = 0;
    const out = Buffer.alloc(utf8Bytes.length);
    for (let p = 0; p < utf8Bytes.length; p++) {
        i = (i + 1) & 0xff;
        j = (j + s[i]) & 0xff;
        const t = s[i]; s[i] = s[j]; s[j] = t;
        out[p] = utf8Bytes[p] ^ s[(s[i] + s[j]) & 0xff];
    }
    return out.toString('base64');
}

function applyAstRc4Obfuscation(sourceCode) {
    if (!acorn || typeof acorn.parse !== 'function') {
        return sourceCode;
    }
    const ast = acorn.parse(sourceCode, { ecmaVersion: 'latest', sourceType: 'script' });
    const keyPool = ['jpr9K2', 'x7VqP1', 'r4LmN8', 'z2WcF5', 'k8HtD3', 'p5JnY9'];
    const encryptedPool = [];
    const poolIndexMap = new Map();
    const replacements = [];

    function walk(node, parent) {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'Literal' && typeof node.value === 'string') {
            const val = node.value;
            const isDirective = val === 'use strict';
            const isPropKey = parent && parent.type === 'Property' && parent.key === node && !parent.computed;
            if (!isDirective && !isPropKey && val.length >= 3 && val.length <= 240) {
                const rc4Key = keyPool[(encryptedPool.length + val.length) % keyPool.length];
                const cacheKey = `${rc4Key}:${val}`;
                let idx = poolIndexMap.get(cacheKey);
                if (idx === undefined) {
                    idx = encryptedPool.length;
                    encryptedPool.push(rc4TransformHex(val, rc4Key));
                    poolIndexMap.set(cacheKey, idx);
                }
                const rawCall = `_0xJprDec(0x${idx.toString(16)},${JSON.stringify(rc4Key)})`;
                const prevChar = node.start > 0 ? sourceCode[node.start - 1] : '';
                const nextChar = node.end < sourceCode.length ? sourceCode[node.end] : '';
                const padL = /[A-Za-z0-9_$]/.test(prevChar) ? ' ' : '';
                const padR = /[A-Za-z0-9_$]/.test(nextChar) ? ' ' : '';
                replacements.push({ start: node.start, end: node.end, text: `${padL}${rawCall}${padR}` });
            }
        }
        for (const key of Object.keys(node)) {
            if (key === 'type' || key === 'start' || key === 'end') continue;
            const child = node[key];
            if (Array.isArray(child)) {
                child.forEach(c => { if (c && typeof c.type === 'string') walk(c, node); });
            } else if (child && typeof child.type === 'string') {
                walk(child, node);
            }
        }
    }
    walk(ast, null);

    replacements.sort((a, b) => b.start - a.start);
    let mutated = sourceCode;
    for (const r of replacements) {
        mutated = mutated.slice(0, r.start) + r.text + mutated.slice(r.end);
    }

    const header = `
const _0xJprArr = ${JSON.stringify(encryptedPool)};
const _0xJprCache = Object.create(null);
function _0xJprDec(_idx, _key) {
    const _ck = _idx + ":" + _key;
    if (_0xJprCache[_ck] !== undefined) return _0xJprCache[_ck];
    const _bin = atob(_0xJprArr[_idx]);
    const _s = new Uint8Array(256);
    for (let _i = 0; _i < 256; _i++) _s[_i] = _i;
    let _j = 0;
    for (let _i = 0; _i < 256; _i++) {
        _j = (_j + _s[_i] + _key.charCodeAt(_i % _key.length)) & 255;
        const _t = _s[_i]; _s[_i] = _s[_j]; _s[_j] = _t;
    }
    let _x = 0; _j = 0;
    const _out = new Uint8Array(_bin.length);
    for (let _p = 0; _p < _bin.length; _p++) {
        _x = (_x + 1) & 0xff;
        _j = (_j + _s[_x]) & 0xff;
        const _t = _s[_x]; _s[_x] = _s[_j]; _s[_j] = _t;
        _out[_p] = _bin.charCodeAt(_p) ^ _s[(_s[_x] + _s[_j]) & 0xff];
    }
    const _dec = new TextDecoder().decode(_out);
    _0xJprCache[_ck] = _dec;
    return _dec;
}
`;
    return header + '\n' + mutated;
}

async function runBuild() {
    console.log('[JAPAR PUBLIK BUILD] Memulai kompilasi produksi Dual-Node...');
    if (fs.existsSync(DIST_DIR)) {
        fs.rmSync(DIST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(path.join(DIST_DIR, 'js'), { recursive: true });
    fs.mkdirSync(path.join(DIST_DIR, 'css'), { recursive: true });
    fs.mkdirSync(path.join(DIST_DIR, 'assets'), { recursive: true });

    const iifeSource = buildSingleIifeBundleSource();
    const obfSource = applyAstRc4Obfuscation(iifeSource);
    let finalJs = obfSource;
    if (terser && typeof terser.minify === 'function') {
        const minRes = await terser.minify(obfSource, {
            compress: { passes: 2, drop_debugger: true },
            mangle: { toplevel: false },
            format: { comments: false }
        });
        if (minRes && minRes.code) {
            finalJs = minRes.code;
        }
    }
    if (acorn && typeof acorn.parse === 'function') {
        acorn.parse(finalJs, { ecmaVersion: 'latest', sourceType: 'script' });
    } else {
        new Function(finalJs);
    }
    fs.writeFileSync(path.join(DIST_DIR, 'js', 'japar-publik.min.js'), finalJs, 'utf8');

    const rawSw = fs.readFileSync(path.join(ROOT_DIR, 'service-worker.js'), 'utf8');
    let finalSw = rawSw;
    if (terser && typeof terser.minify === 'function') {
        const minSw = await terser.minify(rawSw, { compress: true, mangle: true, format: { comments: false } });
        if (minSw && minSw.code) finalSw = minSw.code;
    } else {
        finalSw = rawSw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s+/g, ' ').trim();
    }
    if (acorn && typeof acorn.parse === 'function') {
        acorn.parse(finalSw, { ecmaVersion: 'latest', sourceType: 'script' });
    }
    fs.writeFileSync(path.join(DIST_DIR, 'service-worker.js'), finalSw, 'utf8');

    const rawHtml = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8')
        .replace(/<script\s+type=["']module["']\s+src=["']\.\/app\.js["']\s*><\/script>/i, '<script src="./js/japar-publik.min.js" defer></script>')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/>\s+</g, '><')
        .replace(/\s{2,}/g, ' ')
        .trim();
    fs.writeFileSync(path.join(DIST_DIR, 'index.html'), rawHtml, 'utf8');

    const rawCss = fs.readFileSync(path.join(ROOT_DIR, 'css', 'theme.css'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\s+/g, ' ')
        .replace(/\s*([{}:;,>~])\s*/g, '$1')
        .replace(/;}/g, '}')
        .trim();
    fs.writeFileSync(path.join(DIST_DIR, 'css', 'theme.css'), rawCss, 'utf8');

    fs.copyFileSync(path.join(ROOT_DIR, 'manifest.json'), path.join(DIST_DIR, 'manifest.json'));
    for (const img of ['logo.png', 'icon-192.png', 'icon-512.png']) {
        const s = path.join(ROOT_DIR, 'assets', img);
        if (fs.existsSync(s)) {
            fs.copyFileSync(s, path.join(DIST_DIR, 'assets', img));
        }
    }
    console.log('[JAPAR PUBLIK BUILD] Selesai & Terverifikasi AST! Berkas siap di dist/');
}

runBuild().catch((err) => {
    console.error('[JAPAR PUBLIK BUILD ERROR]', err);
    process.exit(1);
});
