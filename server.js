#!/usr/bin/env node
// ============================================================
// AXIOM SENTINEL — Serveur 24/7
// Tourne en continu même quand le PC est éteint (sur un VPS)
// Usage: node server.js
// Dashboard: http://localhost:3000
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, 'axiom-state.json');
const DEXSCREENER_BOOST = 'https://api.dexscreener.com/token-boosts/latest/v1';
const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex';
const COINGECKO_SOL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';

// ---- STATE ----
const DEFAULTS = {
  mode: 'demo',
  portfolio: 2.0,
  startingPortfolio: 2.0,
  positions: [],
  history: [],
  xp: 0, level: 1,
  totalTrades: 0, wins: 0, losses: 0,
  bestTrade: 0, worstTrade: 0,
  portfolioHistory: [2.0],
  timeLabels: [new Date().toLocaleTimeString('fr-FR')],
  signalWeights: { rsi: 1.0, volume: 1.0, ema: 1.0, liquidity: 1.0 },
  signalsEnabled: { rsi: true, volume: true, ema: true, liquidity: true },
  settings: { posSize: 15, slippage: 15, tp: 15, sl: 8, risk: 'balanced' },
  achievements: [],
  rugAvoided: 0, tokensScanned: 0,
  scannerTokens: [],
  learningLogs: [],
  botCreatedAt: Date.now(),
  learn: null,
  maxPositions: 5,
  adaptivePosSize: 15,
  minPosSize: 0.1,
  tradeableBalance: 2.0
};

let S = loadState();
let solUsdPrice = 0;

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const merged = { ...DEFAULTS };
      for (const k of Object.keys(DEFAULTS)) {
        if (parsed[k] !== undefined && parsed[k] !== null) {
          if (typeof DEFAULTS[k] === 'object' && !Array.isArray(DEFAULTS[k]) && DEFAULTS[k] !== null) {
            merged[k] = { ...DEFAULTS[k], ...parsed[k] };
          } else {
            merged[k] = parsed[k];
          }
        }
      }
      return merged;
    }
  } catch(e) { console.warn('State load error:', e.message); }
  return { ...DEFAULTS };
}

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(S, null, 2)); }
  catch(e) { console.warn('State save error:', e.message); }
}

function log(icon, text) {
  const entry = { icon, text, time: Date.now() };
  S.learningLogs.unshift(entry);
  if (S.learningLogs.length > 100) S.learningLogs.pop();
  console.log(`[${new Date().toLocaleTimeString('fr-FR')}] ${icon} ${text}`);
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function fmt(n) { return parseFloat(n).toFixed(4); }

// ---- FETCH HELPERS ----
async function fetchJSON(url, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return await r.json();
  } catch(e) {
    clearTimeout(timer);
    return null;
  }
}

// ---- SOL PRICE ----
async function fetchSolPrice() {
  const d = await fetchJSON(COINGECKO_SOL);
  if (d?.solana?.usd) solUsdPrice = d.solana.usd;
}

// ---- DEXSCREENER ----
async function fetchDexScreenerTokens() {
  try {
    const boosts = await fetchJSON(DEXSCREENER_BOOST);
    if (!Array.isArray(boosts) || !boosts.length) { generateSimTokens(); return; }

    const solBoosts = boosts.filter(b => b.chainId === 'solana').slice(0, 30);
    if (!solBoosts.length) { generateSimTokens(); return; }

    const tokens = [];
    const batches = [];
    for (let i = 0; i < solBoosts.length; i += 5) {
      batches.push(solBoosts.slice(i, i + 5));
    }

    for (const batch of batches) {
      const addrs = batch.map(b => b.tokenAddress).join(',');
      try {
        const d = await fetchJSON(`${DEXSCREENER_API}/tokens/${addrs}`);
        if (d?.pairs) {
          for (const p of d.pairs) {
            if (!p.chainId || p.chainId !== 'solana') continue;
            if ((p.liquidity?.usd || 0) < 5000 || (p.volume?.h24 || 0) < 3000) continue;
            tokens.push({
              name: p.baseToken?.symbol || '?',
              pair: (p.baseToken?.symbol || '?') + '/' + (p.quoteToken?.symbol || 'SOL'),
              address: p.baseToken?.address || '',
              quoteAddress: p.quoteToken?.address || '',
              price: parseFloat(p.priceUsd || 0),
              priceNative: parseFloat(p.priceNative || 0),
              change5m: p.priceChange?.m5 || 0,
              change1h: p.priceChange?.h1 || 0,
              change24h: p.priceChange?.h24 || 0,
              volume: p.volume?.h24 || 0,
              liquidity: p.liquidity?.usd || 0,
              pairAge: p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3600000 : 999,
              txns: p.txns?.h24 || { buys: 0, sells: 0 }
            });
          }
        }
      } catch(e) {}
    }

    if (tokens.length > 0) {
      // Deduplicate
      const seen = new Set();
      S.scannerTokens = tokens.filter(t => {
        if (seen.has(t.name)) return false;
        seen.add(t.name);
        return true;
      });
      S.scannerTokens.forEach(t => { t.signals = computeSignals(t); });
      S.scannerTokens.sort((a, b) => b.signals.composite - a.signals.composite);
      S.tokensScanned += S.scannerTokens.length;
    } else {
      generateSimTokens();
    }
  } catch(e) {
    generateSimTokens();
  }
}

function generateSimTokens() {
  const names = ['BONK','WIF','JTO','PYTH','JUP','RAY','ORCA','DRIFT','TENSOR','POPCAT','MEW','BOME','MYRO','SLERF','KMNO'];
  S.scannerTokens = names.map(name => {
    const price = Math.random() * 5;
    const token = {
      name, pair: name + '/SOL', address: '', quoteAddress: '',
      price, priceNative: price / 150,
      change5m: (Math.random() - .45) * 12, change1h: (Math.random() - .45) * 25, change24h: (Math.random() - .4) * 50,
      volume: 5000 + Math.random() * 300000,
      liquidity: 8000 + Math.random() * 150000,
      pairAge: .5 + Math.random() * 48,
      txns: { buys: Math.floor(Math.random() * 500), sells: Math.floor(Math.random() * 500) }
    };
    token.signals = computeSignals(token);
    return token;
  });
  S.scannerTokens.sort((a, b) => b.signals.composite - a.signals.composite);
}

// ---- SIGNALS ----
function computeSignals(token) {
  const changes = [token.change5m, token.change1h / 12, token.change24h / 288];
  const gains = changes.filter(x => x > 0);
  const losses = changes.filter(x => x < 0).map(Math.abs);
  const avgGain = gains.length ? gains.reduce((a, b) => a + b, 0) / gains.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0.01;
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  const rsiSignal = rsi < 20 ? 1.0 : rsi < 30 ? 0.85 : rsi < 40 ? 0.5 : rsi < 50 ? 0.15 : rsi < 60 ? -0.1 : rsi < 70 ? -0.3 : rsi < 80 ? -0.6 : -0.9;

  const buys = token.txns?.buys || 0;
  const sells = token.txns?.sells || 0;
  const totalTxns = buys + sells;
  const buyPressure = totalTxns > 0 ? buys / totalTxns : 0.5;
  const volLiqRatio = token.liquidity > 0 ? token.volume / token.liquidity : 0;
  const volAccel = volLiqRatio > 3 ? 1.0 : volLiqRatio > 1.5 ? 0.7 : volLiqRatio > 0.5 ? 0.4 : 0.1;
  const volumeSignal = (buyPressure > 0.65 ? 1.0 : buyPressure > 0.55 ? 0.6 : buyPressure > 0.5 ? 0.25 : buyPressure > 0.4 ? -0.2 : -0.5) * 0.6 + volAccel * 0.4;

  const alreadyPumped = token.change1h > 30 || token.change5m > 15;
  const fomopenalty = alreadyPumped ? -0.4 : 0;

  const m5 = token.change5m, m1h = token.change1h, m24h = token.change24h;
  const isDipBuy = m5 < 0 && m5 > -5 && m1h > 0 && m24h > 0;
  const isTrendCont = m5 > 0 && m1h > 0 && m5 > m1h / 12;
  const trendAlignment = isDipBuy ? 0.9 : isTrendCont ? 0.75 : (m5 > 0 && m1h > 0) ? 0.6 : (m5 > 0 || m1h > 0) ? 0.2 : -0.4;

  const liqScore = Math.min(1.0, Math.max(0.05, (Math.log10(Math.max(token.liquidity, 1000)) - 3) / 2.5));
  const isRugRisk = token.liquidity < 10000 || token.pairAge < 1 || (sells > buys * 3) || (token.change5m < -20) || (volLiqRatio > 10 && buyPressure < 0.3);

  const signalValues = [rsiSignal, volumeSignal, trendAlignment, liqScore];
  const positiveSignals = signalValues.filter(v => v > 0.3).length;
  const confidence = positiveSignals / signalValues.length;
  const volatility = Math.abs(token.change5m) + Math.abs(token.change1h / 12);

  const w = S.signalWeights, en = S.signalsEnabled;
  let totalW = 0, totalS = 0;
  if (en.rsi) { totalS += rsiSignal * w.rsi; totalW += w.rsi; }
  if (en.volume) { totalS += volumeSignal * w.volume; totalW += w.volume; }
  if (en.ema) { totalS += trendAlignment * w.ema; totalW += w.ema; }
  if (en.liquidity) { totalS += liqScore * w.liquidity; totalW += w.liquidity; }

  let composite = totalW > 0 ? totalS / totalW : 0;
  composite += fomopenalty;

  return {
    rsi: Math.round(rsi), buyPressure: (buyPressure * 100).toFixed(0),
    momentum5m: m5, momentum1h: m1h, momentum24h: m24h,
    liqScore, volAccel, confidence, volatility, composite,
    strength: composite > 0.6 ? 'strong' : composite > 0.3 ? 'medium' : 'weak',
    isRugRisk, alreadyPumped
  };
}

// ---- LEARNING ----
function ensureLearningState() {
  if (!S.learn) S.learn = {
    entryPatterns: [], exitPatterns: [], slippageLog: [],
    tpHitRate: { tp1: 0, tp2: 0, tp3: 0, trail: 0, sl: 0, stag: 0, dump: 0, manual: 0 },
    avgHoldWin: 0, avgHoldLoss: 0,
    optimalComposite: 0.6, optimalConfidence: 0.5,
    rsiZonePerf: { low: { w: 0, l: 0 }, mid: { w: 0, l: 0 }, high: { w: 0, l: 0 } },
    volZonePerf: { low: { w: 0, l: 0 }, mid: { w: 0, l: 0 }, high: { w: 0, l: 0 } },
    trendPerf: { aligned: { w: 0, l: 0 }, partial: { w: 0, l: 0 }, against: { w: 0, l: 0 } },
    liqPerf: { low: { w: 0, l: 0 }, mid: { w: 0, l: 0 }, high: { w: 0, l: 0 } },
    dynamicTP: S.settings.tp, dynamicSL: S.settings.sl, cycleCount: 0
  };
}

function adaptWeights(trade) {
  ensureLearningState();
  const L = S.learn;
  const sig = trade.signals || {};
  const isWin = trade.pnlPercent > 0;
  const magnitude = Math.min(Math.abs(trade.pnlPercent) / 20, 1);
  const boost = (isWin ? 1 : -1) * 0.04 * (1 + magnitude);

  if (sig.rsi < 35 || sig.rsi > 65) S.signalWeights.rsi = clamp(S.signalWeights.rsi + boost, 0.3, 2.5);
  S.signalWeights.volume = clamp(S.signalWeights.volume + boost, 0.3, 2.5);
  S.signalWeights.ema = clamp(S.signalWeights.ema + boost * 0.8, 0.3, 2.5);
  S.signalWeights.liquidity = clamp(S.signalWeights.liquidity + boost * 0.5, 0.3, 2.5);

  // Zone tracking
  const rsiZone = sig.rsi < 35 ? 'low' : sig.rsi > 65 ? 'high' : 'mid';
  if (isWin) L.rsiZonePerf[rsiZone].w++; else L.rsiZonePerf[rsiZone].l++;

  const bp = parseFloat(sig.buyPressure) || 50;
  const volZone = bp > 60 ? 'high' : bp > 45 ? 'mid' : 'low';
  if (isWin) L.volZonePerf[volZone].w++; else L.volZonePerf[volZone].l++;

  const holdMs = trade.duration || 0;
  if (isWin) L.avgHoldWin = L.avgHoldWin ? L.avgHoldWin * 0.8 + holdMs * 0.2 : holdMs;
  else L.avgHoldLoss = L.avgHoldLoss ? L.avgHoldLoss * 0.8 + holdMs * 0.2 : holdMs;

  if (isWin && trade.pnlPercent > 5) {
    L.entryPatterns.push({ rsi: sig.rsi, bp, composite: sig.composite, confidence: sig.confidence });
    if (L.entryPatterns.length > 30) L.entryPatterns.shift();
  }

  if (S.totalTrades > 0 && S.totalTrades % 3 === 0) autoTuneTPSL();
  if (S.totalTrades > 4 && S.totalTrades % 5 === 0) autoTuneThresholds();

  log('🧠', `Trade #${S.totalTrades}: ${trade.token} ${isWin ? '+' : ''}${trade.pnlPercent.toFixed(2)}% (${trade.reason})`);
}

function autoTuneTPSL() {
  const L = S.learn;
  const recent = S.history.slice(0, Math.min(50, S.history.length));
  if (recent.length < 5) return;
  const slHits = recent.filter(h => h.reason === 'SL').length;
  if (slHits > recent.length * 0.5) L.dynamicSL = clamp(L.dynamicSL + 0.5, 5, 15);
  else if (slHits < recent.length * 0.15) L.dynamicSL = clamp(L.dynamicSL - 0.3, 5, 15);
  const wins = recent.filter(h => h.pnlPercent > 0);
  if (wins.length > 0) {
    const avgWin = wins.reduce((s, h) => s + h.pnlPercent, 0) / wins.length;
    if (avgWin > L.dynamicTP * 1.5) L.dynamicTP = clamp(L.dynamicTP + 1, 10, 60);
    else if (avgWin < L.dynamicTP * 0.5) L.dynamicTP = clamp(L.dynamicTP - 0.5, 10, 60);
  }
}

function autoTuneThresholds() {
  const L = S.learn;
  const recent = S.history.slice(0, 20);
  if (recent.length < 5) return;
  const winComps = recent.filter(h => h.pnlPercent > 0 && h.signals?.composite).map(h => h.signals.composite);
  const lossComps = recent.filter(h => h.pnlPercent < 0 && h.signals?.composite).map(h => h.signals.composite);
  if (winComps.length > 0) {
    const avgW = winComps.reduce((a, b) => a + b, 0) / winComps.length;
    const avgL = lossComps.length > 0 ? lossComps.reduce((a, b) => a + b, 0) / lossComps.length : 0;
    L.optimalComposite = clamp(L.optimalComposite * 0.5 + ((avgW + avgL) / 2) * 0.5, 0.35, 0.85);
  }
}

// ---- TRADING ENGINE ----
function proposeTrade(token) {
  const maxPos = S.maxPositions || 5;
  if (S.positions.length >= maxPos) return;
  if (S.positions.find(p => p.token === token.name)) return;
  const recentLoss = S.history.find(h => h.token === token.name && h.pnlPercent < 0 && (Date.now() - h.timestamp) < 120000);
  if (recentLoss) return;

  const posPct = (S.adaptivePosSize || S.settings.posSize) / 100;
  const available = S.tradeableBalance || S.portfolio;
  if (available <= 0) return;

  const sig = token.signals;
  const sizeFactor = Math.min(1.0, 0.5 + sig.confidence * 0.5 + Math.max(0, (sig.composite - 0.6) * 0.5));
  let posSize = Math.min(available * posPct * sizeFactor, available * 0.95);
  if (posSize < (S.minPosSize || 0.1)) return;

  const slippage = token.liquidity > 100000 ? 0.5 : token.liquidity > 50000 ? 1.0 : token.liquidity > 20000 ? 1.5 : 2.0;
  const L = S.learn || {};
  const tp = L.dynamicTP || S.settings.tp;
  const sl = L.dynamicSL || S.settings.sl;
  const entryPrice = token.price * (1 + slippage / 100);

  const pos = {
    id: Date.now(), token: token.name, pair: token.pair, address: token.address,
    entryPrice, currentPrice: entryPrice, previousPrice: entryPrice,
    size: posSize, solAmount: posSize, entryTime: Date.now(),
    slippage, signals: { ...sig }, tp1: tp, sl,
    mode: 'demo', highestPrice: entryPrice, trailingActive: false, partialTaken: 0
  };

  S.positions.push(pos);
  S.portfolio -= posSize;
  log('⚔', `Position ouverte: ${token.name} — ${fmt(posSize)} SOL à $${token.price.toFixed(6)}`);
  saveState();
}

function updatePositions() {
  if (!S.positions.length) return;
  const toClose = [];

  for (const pos of S.positions) {
    // Demo: neutral random walk
    const tokenVol = (pos.signals.volatility || 5) * 0.003;
    const vol = (Math.random() - 0.5) * Math.max(0.02, tokenVol);
    pos.currentPrice *= (1 + vol);

    if (!pos.entryPrice || pos.entryPrice <= 0) continue;
    const pnl = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const holdMin = (Date.now() - pos.entryTime) / 60000;

    if (!pos.highestPrice || pos.currentPrice > pos.highestPrice) pos.highestPrice = pos.currentPrice;
    const highPnl = ((pos.highestPrice - pos.entryPrice) / pos.entryPrice) * 100;

    const tp1T = pos.tp1, tp2T = pos.tp1 * 2, tp3T = pos.tp1 * 3.3;

    if (pnl >= tp3T) { toClose.push({ pos, reason: 'TP3', pnl }); }
    else if (pnl >= tp2T && (pos.partialTaken || 0) < 2) {
      pos.partialTaken = 2; pos.trailingActive = true;
      const partial = pos.solAmount * 0.5;
      S.portfolio += partial + partial * (pnl / 100);
      pos.solAmount -= partial; pos.size = pos.solAmount;
    }
    else if (pnl >= tp1T && (pos.partialTaken || 0) < 1) {
      pos.partialTaken = 1; pos.trailingActive = true;
      const partial = pos.solAmount * 0.3;
      S.portfolio += partial + partial * (pnl / 100);
      pos.solAmount -= partial; pos.size = pos.solAmount;
      pos.sl = 2;
    }
    else if (pos.trailingActive && highPnl > tp1T) {
      const drawdown = highPnl - pnl;
      if (drawdown > Math.min(highPnl * 0.3, 10) && drawdown > 5) toClose.push({ pos, reason: 'Trail', pnl });
    }
    else if (pnl <= -pos.sl) { toClose.push({ pos, reason: 'SL', pnl }); }
    else if (holdMin > 10 && Math.abs(pnl) < 2 && !pos.trailingActive) {
      if ((pos.id + Math.floor(Date.now() / 60000)) % 3 === 0) toClose.push({ pos, reason: 'Stagnation', pnl });
    }
    else if (pnl < -pos.sl * 0.6 && pos.currentPrice < (pos.previousPrice || pos.currentPrice) * 0.96) {
      toClose.push({ pos, reason: 'Dump', pnl });
    }
    pos.previousPrice = pos.currentPrice;
  }

  for (const { pos, reason, pnl } of toClose) closeTrade(pos, reason, pnl);
}

function closeTrade(pos, reason, pnlPct) {
  const pnlSol = pos.solAmount * (pnlPct / 100);
  S.portfolio += pos.solAmount + pnlSol;

  const record = {
    token: pos.token, entryPrice: pos.entryPrice, exitPrice: pos.currentPrice,
    pnlPercent: pnlPct, pnlSol, reason,
    duration: Date.now() - pos.entryTime,
    signals: pos.signals, timestamp: Date.now(), mode: pos.mode
  };

  S.history.unshift(record);
  S.totalTrades++;
  if (pnlPct > 0) { S.wins++; S.xp += Math.floor(20 + pnlPct * 3); }
  else { S.losses++; S.xp += 10; }
  if (pnlPct > S.bestTrade) S.bestTrade = pnlPct;
  if (pnlPct < S.worstTrade) S.worstTrade = pnlPct;

  S.positions = S.positions.filter(p => p.id !== pos.id);
  adaptWeights(record);

  const emoji = pnlPct > 0 ? '✅' : '❌';
  log(emoji, `${pos.token}: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% (${reason}) — ${fmt(pnlSol)} SOL`);
  saveState();
}

// ---- MAIN LOOP ----
let tick = 0;
async function engineTick() {
  tick++;
  ensureLearningState();
  const L = S.learn;
  L.cycleCount++;

  // Update positions every tick
  updatePositions();

  // Evaluate trades every 3rd tick
  if (tick % 3 === 0) {
    const compositeThresh = L.optimalComposite || 0.6;
    const confThresh = L.optimalConfidence || 0.5;
    const candidates = S.scannerTokens.filter(t =>
      t.signals.strength === 'strong' && !t.signals.isRugRisk && !t.signals.alreadyPumped &&
      t.signals.composite >= compositeThresh && t.signals.confidence >= confThresh &&
      t.liquidity >= 10000 && t.volume >= 5000 && t.pairAge >= 1 &&
      !S.positions.find(p => p.token === t.name)
    );
    candidates.sort((a, b) => {
      const sa = a.signals.composite * a.signals.confidence * Math.min(1, a.liquidity / 50000);
      const sb = b.signals.composite * b.signals.confidence * Math.min(1, b.liquidity / 50000);
      return sb - sa;
    });
    if (candidates.length && S.positions.length < (S.maxPositions || 5)) {
      if (L.dynamicTP) S.settings.tp = L.dynamicTP;
      if (L.dynamicSL) S.settings.sl = L.dynamicSL;
      proposeTrade(candidates[0]);
    }
  }

  // Re-score tokens every 10 ticks
  if (tick % 10 === 0 && S.scannerTokens.length) {
    S.scannerTokens.forEach(t => { t.signals = computeSignals(t); });
    S.scannerTokens.sort((a, b) => b.signals.composite - a.signals.composite);
  }

  // Snapshot every 4 ticks
  if (tick % 4 === 0) {
    const total = S.portfolio + S.positions.reduce((s, p) => {
      const pnl = (p.currentPrice - p.entryPrice) / p.entryPrice;
      return s + p.solAmount * (1 + pnl);
    }, 0);
    S.portfolioHistory.push(parseFloat(total.toFixed(4)));
    S.timeLabels.push(new Date().toLocaleTimeString('fr-FR'));
    if (S.portfolioHistory.length > 500) { S.portfolioHistory.shift(); S.timeLabels.shift(); }
    saveState();
  }
}

// ---- HTTP SERVER (Dashboard) ----
const server = http.createServer((req, res) => {
  if (req.url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      ...S, solUsdPrice, uptime: Date.now() - S.botCreatedAt,
      engineTick: tick, scannerTokens: S.scannerTokens.slice(0, 20)
    }));
  } else if (req.url === '/' || req.url === '/index.html') {
    const htmlPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(htmlPath));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>AXIOM SENTINEL — Server Mode</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0d1020;color:#e8e0d0;font-family:monospace;padding:20px}
h1{color:#d4a542;margin-bottom:20px}pre{background:#1a1f3a;padding:15px;border-radius:8px;overflow-x:auto;margin:10px 0;border:1px solid rgba(212,165,66,.15)}
.win{color:#2ecc71}.loss{color:#e74c3c}.gold{color:#d4a542}</style></head><body>
<h1>⚔ AXIOM SENTINEL — Serveur 24/7</h1>
<p>Le moteur tourne en continu. API: <a href="/api/state" style="color:#d4a542">/api/state</a></p>
<div id="out"></div>
<script>
setInterval(async()=>{
  const d=await(await fetch('/api/state')).json();
  const wr=d.totalTrades>0?(d.wins/d.totalTrades*100).toFixed(0):0;
  const total=d.portfolio+d.positions.reduce((s,p)=>{const pnl=(p.currentPrice-p.entryPrice)/p.entryPrice;return s+p.solAmount*(1+pnl)},0);
  document.getElementById('out').innerHTML=\`
<pre>Portfolio: <span class="gold">\${total.toFixed(4)} SOL</span> ($\${(total*d.solUsdPrice).toFixed(2)})
PnL: <span class="\${total>d.startingPortfolio?'win':'loss'}">\${((total-d.startingPortfolio)/d.startingPortfolio*100).toFixed(2)}%</span>
Trades: \${d.totalTrades} | Wins: <span class="win">\${d.wins}</span> | Losses: <span class="loss">\${d.losses}</span> | WR: \${wr}%
Positions: \${d.positions.length}/\${d.maxPositions} | Tokens scannés: \${d.scannerTokens?.length||0}
Niveau: \${d.level} | XP: \${d.xp}
SOL/USD: $\${d.solUsdPrice?.toFixed(2)||'--'}
Tick: \${d.engineTick} | Uptime: \${Math.floor(d.uptime/3600000)}h\${Math.floor((d.uptime%3600000)/60000)}m</pre>
<h3 style="color:#d4a542;margin:15px 0 5px">Positions ouvertes</h3>
<pre>\${d.positions.length?d.positions.map(p=>{
  const pnl=((p.currentPrice-p.entryPrice)/p.entryPrice*100);
  return \`\${p.token}: <span class="\${pnl>=0?'win':'loss'}">\${pnl>=0?'+':''}\${pnl.toFixed(2)}%</span> | \${p.solAmount.toFixed(4)} SOL | \${Math.floor((Date.now()-p.entryTime)/60000)}min\`;
}).join('\\n'):'Aucune position'}</pre>
<h3 style="color:#d4a542;margin:15px 0 5px">Journal</h3>
<pre>\${(d.learningLogs||[]).slice(0,15).map(l=>\`\${l.icon} \${l.text}\`).join('\\n')}</pre>\`;
},3000);
</script></body></html>`);
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ---- START ----
async function start() {
  console.log('⚔ AXIOM SENTINEL — Serveur 24/7');
  console.log('================================');

  ensureLearningState();
  S.tradeableBalance = Math.max(0, S.portfolio - 0.015);

  await fetchSolPrice();
  console.log(`SOL/USD: $${solUsdPrice}`);

  await fetchDexScreenerTokens();
  console.log(`${S.scannerTokens.length} tokens chargés`);

  // Engine: tick every 2.5s
  setInterval(engineTick, 2500);

  // DexScreener refresh every 8s
  setInterval(fetchDexScreenerTokens, 8000);

  // SOL price every 20s
  setInterval(fetchSolPrice, 20000);

  // Save state every 30s
  setInterval(saveState, 30000);

  // Anti-sleep: self-ping every 10 min (empêche Render/Railway de couper le serveur)
  setInterval(() => {
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    fetch(`${url}/api/state`).catch(() => {});
  }, 600000);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Dashboard: http://localhost:${PORT}`);
    console.log(`API: http://localhost:${PORT}/api/state`);
    console.log('Le bot tourne 24/7. Ctrl+C pour arrêter.');
    log('🚀', 'Serveur 24/7 démarré — moteur actif');
  });
}

start().catch(e => { console.error('Fatal:', e); process.exit(1); });
