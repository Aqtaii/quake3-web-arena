/**
 * Quake III Arena — "Floor is Lava" Game Mode (Zemin Lavdır!)
 * 
 * - 30-second arcade countdown HUD (authentic Quake 3 style)
 * - Elevation-aware player burn detection (climbing on boxes/platforms keeps you safe)
 * - Real 3D in-game lava surface rendered via WebGL2 depth buffer in quake3-host.js
 * - Host toggled from main menu/lobby
 */

(() => {
    'use strict';

    let isLavaModeActive = false;
    let matchStartTime = 0;
    let hasLavaStarted = false;
    let lavaCurrentZ = -999;
    let lavaTargetZ = 0;
    let lavaExposure = 0; // 0 to 100% heat exposure
    let lastFrameTime = 0;
    let lastBurnSoundTime = 0;

    let hudEl = null;
    let timerSecEl = null;
    let barFillEl = null;
    let titleEl = null;
    let subtextEl = null;
    let burnOverlayEl = null;

    let audioCtx = null;
    const COUNTDOWN_SECONDS = 10;

    // Safe platform heights per map (lava stops safely before reaching these heights)
    const MAP_LAVA_SETTINGS = {
        'q3dm1':      { startZ: -40, maxZ: -4, floorZ: -24, safeDescription: 'Kutuların ve merdivenlerin üstüne çık!' },
        'q3dm7':      { startZ: -500, maxZ: -415, floorZ: -489, safeDescription: 'Üst platformlara tırman!' },
        'q3dm17':     { startZ: -450, maxZ: -125, floorZ: -112, safeDescription: 'Platformlarda kal, boşluğa düşme!' },
        'q3tourney2': { startZ: -180, maxZ: -90, floorZ: -168, safeDescription: 'Basamakların üstüne çık!' }
    };

    function getMapSettings(mapName) {
        const clean = (mapName || '').toLowerCase().replace(/^maps\//, '').replace(/\.bsp$/, '');
        if (clean && MAP_LAVA_SETTINGS[clean]) {
            return MAP_LAVA_SETTINGS[clean];
        }
        return { startZ: -150, maxZ: -20, floorZ: -100, safeDescription: 'Yüksek yerlere ve basamaklara çık!' };
    }

    function getAudioContext() {
        if (!audioCtx && (window.AudioContext || window.webkitAudioContext)) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            audioCtx = new AudioCtx();
        }
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => {});
        }
        return audioCtx;
    }

    function playBeep(freq, duration, type = 'sine') {
        const ctx = getAudioContext();
        if (!ctx) return;
        try {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, ctx.currentTime);
            gain.gain.setValueAtTime(0.28, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + duration);
        } catch (_) {}
    }

    function playSiren() {
        const ctx = getAudioContext();
        if (!ctx) return;
        try {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(280, ctx.currentTime);
            osc.frequency.linearRampToValueAtTime(740, ctx.currentTime + 0.45);
            osc.frequency.linearRampToValueAtTime(280, ctx.currentTime + 0.9);
            osc.frequency.linearRampToValueAtTime(740, ctx.currentTime + 1.35);
            gain.gain.setValueAtTime(0.22, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.8);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 1.8);
        } catch (_) {}
    }

    function playSizzle() {
        const ctx = getAudioContext();
        if (!ctx) return;
        try {
            const bufferSize = Math.floor(ctx.sampleRate * 0.22);
            const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) {
                data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.4));
            }
            const noise = ctx.createBufferSource();
            noise.buffer = buffer;
            const filter = ctx.createBiquadFilter();
            filter.type = 'bandpass';
            filter.frequency.value = 2800;
            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0.35, ctx.currentTime);
            noise.connect(filter);
            filter.connect(gain);
            gain.connect(ctx.destination);
            noise.start();
        } catch (_) {}
    }

    function createHud() {
        if (hudEl) return;
        const viewportWrap = document.getElementById('viewport-wrap');
        if (!viewportWrap) return;

        // Burn Damage Screen Overlay (vignette fire when feet touch lava)
        burnOverlayEl = document.createElement('div');
        burnOverlayEl.id = 'lava-burn-overlay';
        burnOverlayEl.className = 'lava-burn-overlay';
        burnOverlayEl.innerHTML = `
            <div class="burn-indicator">🔥 AYAKLARIN YANIYOR! YUKARI ÇIK! 🔥</div>
        `;
        viewportWrap.appendChild(burnOverlayEl);

        // Top Arcade Timer HUD
        hudEl = document.createElement('div');
        hudEl.id = 'lava-hud';
        hudEl.className = 'lava-hud';
        hudEl.hidden = true;
        hudEl.innerHTML = `
            <div class="lava-timer-box">
                <div class="lava-title" id="lava-title">🌋 DİKKAT: ZEMİN LAV OLUYOR!</div>
                <div class="lava-timer-row">
                    <span class="lava-sec" id="lava-timer-sec">10</span>
                    <span class="lava-unit">SANİYE</span>
                </div>
                <div class="lava-bar-track">
                    <div class="lava-bar-fill" id="lava-bar-fill"></div>
                </div>
                <div class="lava-subtext" id="lava-subtext">Kutuların veya merdivenlerin üstüne çık!</div>
            </div>
        `;
        viewportWrap.appendChild(hudEl);

        timerSecEl = document.getElementById('lava-timer-sec');
        barFillEl = document.getElementById('lava-bar-fill');
        titleEl = document.getElementById('lava-title');
        subtextEl = document.getElementById('lava-subtext');
    }

    let lastBeepSec = -1;

    function updateLavaMode(gameStatus, sendConsoleCommand) {
        if (!isLavaModeActive) {
            if (hudEl) hudEl.hidden = true;
            if (burnOverlayEl) burnOverlayEl.classList.remove('active');
            lavaExposure = 0;
            return;
        }

        createHud();

        if (!gameStatus || !gameStatus.active) {
            hudEl.hidden = true;
            burnOverlayEl.classList.remove('active');
            matchStartTime = 0;
            hasLavaStarted = false;
            lavaExposure = 0;
            return;
        }

        const now = performance.now();
        const deltaSec = lastFrameTime > 0 ? Math.min(0.1, (now - lastFrameTime) / 1000) : 0.016;
        lastFrameTime = now;

        if (matchStartTime === 0) {
            matchStartTime = now;
            hasLavaStarted = false;
            lavaExposure = 0;
            const mapSettings = getMapSettings(gameStatus.map);
            lavaCurrentZ = mapSettings.startZ;
            lavaTargetZ = mapSettings.maxZ;
        }

        hudEl.hidden = false;

        const elapsedSec = (now - matchStartTime) / 1000;
        const remainingCountdown = Math.max(0, COUNTDOWN_SECONDS - elapsedSec);
        const currentSecInt = Math.ceil(remainingCountdown);

        // =====================================================================
        // Phase 1: 10-Second Arcade Countdown
        // =====================================================================
        if (remainingCountdown > 0) {
            timerSecEl.textContent = currentSecInt < 10 ? `0${currentSecInt}` : currentSecInt;
            const pct = (remainingCountdown / COUNTDOWN_SECONDS) * 100;
            barFillEl.style.width = `${pct}%`;

            if (currentSecInt <= 5) {
                hudEl.classList.add('urgent');
                if (currentSecInt !== lastBeepSec) {
                    lastBeepSec = currentSecInt;
                    const freq = 800 + (5 - currentSecInt) * 75;
                    playBeep(freq, 0.09, 'sawtooth');
                }
            } else if (currentSecInt === 10 && currentSecInt !== lastBeepSec) {
                lastBeepSec = currentSecInt;
                playBeep(650, 0.16);
            }

            burnOverlayEl.classList.remove('active');
            return;
        }

        // =====================================================================
        // Phase 2: 3D Lava Active & Slowly Rising in the Game
        // =====================================================================
        if (!hasLavaStarted) {
            hasLavaStarted = true;
            playSiren();
            hudEl.classList.add('lava-active');
            titleEl.textContent = '🔥 DİKKAT: ZEMİN LAV OLDU! 🔥';
            titleEl.style.color = '#ff3300';
            const mapSettings = getMapSettings(gameStatus.map);
            subtextEl.textContent = mapSettings.safeDescription;
        }

        // Rise 3D lava gradually over 15 seconds to target max safe height
        const lavaRiseDuration = 15.0;
        const lavaTime = elapsedSec - COUNTDOWN_SECONDS;
        const riseProgress = Math.min(1.0, lavaTime / lavaRiseDuration);
        const mapSettings = getMapSettings(gameStatus.map);
        lavaCurrentZ = mapSettings.startZ + (mapSettings.maxZ - mapSettings.startZ) * riseProgress;

        timerSecEl.textContent = 'LAV';
        barFillEl.style.width = '100%';
        barFillEl.style.background = 'linear-gradient(90deg, #ff2200, #ff8800)';

        // Elevation detection: safe when standing on crates, stairs, or upper ramps
        const playerZ = gameStatus.origin ? gameStatus.origin[2] : 999;
        const isTouchingLava = playerZ <= (lavaCurrentZ + 8);

        if (isTouchingLava) {
            // Build up burn heat exposure (+25% per second = ~4 seconds to kill)
            lavaExposure = Math.min(100, lavaExposure + deltaSec * 25);
            burnOverlayEl.classList.add('active');
            subtextEl.textContent = `🔥 AYAKLARIN YANIYOR! (%${Math.round(lavaExposure)}) KUTULARIN ÜSTÜNE ÇIK!`;
            subtextEl.style.color = '#ff3300';

            // Audio sizzle ticks every 650ms while in lava
            if (now - lastBurnSoundTime > 650) {
                lastBurnSoundTime = now;
                playSizzle();
            }

            // Burn death when exposure hits 100% or health is critically low
            if (lavaExposure >= 100 || (gameStatus.health && gameStatus.health <= 15)) {
                sendConsoleCommand('kill');
                lavaExposure = 0; // Reset exposure for respawn
            }
        } else {
            // Rapidly cool down when on a box or upper platform (-50% per second)
            lavaExposure = Math.max(0, lavaExposure - deltaSec * 50);
            burnOverlayEl.classList.remove('active');
            subtextEl.textContent = `🛡️ GÜVENDESİN · Lav seviyesi: ${Math.round(lavaCurrentZ)} (Zemine inme!)`;
            subtextEl.style.color = '#4ade80';
        }
    }

    function setEnabled(enabled) {
        isLavaModeActive = !!enabled;
        matchStartTime = 0;
        hasLavaStarted = false;
        lastBeepSec = -1;
        lavaExposure = 0;
        lastFrameTime = 0;
        lavaCurrentZ = -999;
        if (!enabled) {
            if (hudEl) hudEl.hidden = true;
            if (burnOverlayEl) burnOverlayEl.classList.remove('active');
        }
    }

    function isEnabled() {
        return isLavaModeActive;
    }

    function hasStarted() {
        return hasLavaStarted;
    }

    function getCurrentZ() {
        return lavaCurrentZ;
    }

    globalThis.Q3Lava = Object.freeze({
        setEnabled,
        isEnabled,
        hasStarted,
        getCurrentZ,
        update: updateLavaMode
    });
})();
