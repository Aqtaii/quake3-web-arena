/**
 * Quake III Arena — "Floor is Lava" Game Mode (Zemin Lavdır!)
 * 
 * - 30-second arcade countdown HUD (authentic Quake 3 style)
 * - Procedural molten lava texture with glowing crack fissures, bubbling surface & embers
 * - Elevation-aware player burn detection (climbing on boxes/platforms keeps you safe)
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
    let lavaCanvas = null;
    let lavaCtx = null;

    let audioCtx = null;
    let emberParticles = [];
    let lavaBubbles = [];
    let noiseSeed = 0;
    let crustPattern = null;

    const COUNTDOWN_SECONDS = 30;

    // Safe platform heights per map (lava stops safely before reaching these heights)
    const MAP_LAVA_SETTINGS = {
        'q3dm1':      { startZ: -50, maxZ: -4, floorZ: -24, safeDescription: 'Kutuların ve merdivenlerin üstüne çık!' },
        'q3dm7':      { startZ: -220, maxZ: -120, floorZ: -190, safeDescription: 'Üst platformlara tırman!' },
        'q3dm17':     { startZ: -350, maxZ: -140, floorZ: -300, safeDescription: 'Platformlarda kal, boşluğa düşme!' },
        'q3tourney2': { startZ: -50, maxZ: -4, floorZ: -24, safeDescription: 'Basamakların üstüne çık!' }
    };

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

    // Procedural cracked magma rock crust texture
    function createCrustTexture() {
        const offCanvas = document.createElement('canvas');
        offCanvas.width = 256;
        offCanvas.height = 256;
        const offCtx = offCanvas.getContext('2d');

        // Deep basalt crust background
        offCtx.fillStyle = '#1e0501';
        offCtx.fillRect(0, 0, 256, 256);

        // Crust rock plates
        for (let i = 0; i < 40; i++) {
            const rx = Math.random() * 256;
            const ry = Math.random() * 256;
            const rSize = 18 + Math.random() * 32;
            offCtx.beginPath();
            offCtx.arc(rx, ry, rSize, 0, Math.PI * 2);
            offCtx.fillStyle = Math.random() > 0.4 ? '#2d0903' : '#140300';
            offCtx.fill();
        }

        // Molten glowing fissure cracks
        offCtx.lineWidth = 2.5;
        offCtx.strokeStyle = '#ff6a00';
        offCtx.shadowColor = '#ffaa00';
        offCtx.shadowBlur = 6;
        for (let i = 0; i < 18; i++) {
            let x = Math.random() * 256;
            let y = Math.random() * 256;
            offCtx.beginPath();
            offCtx.moveTo(x, y);
            for (let seg = 0; seg < 4; seg++) {
                x += (Math.random() - 0.5) * 50;
                y += (Math.random() - 0.5) * 50;
                offCtx.lineTo(x, y);
            }
            offCtx.stroke();
        }

        // Hot yellow core fissure lines
        offCtx.lineWidth = 1;
        offCtx.strokeStyle = '#fffb77';
        offCtx.shadowColor = '#ffff00';
        offCtx.shadowBlur = 3;
        for (let i = 0; i < 12; i++) {
            let x = Math.random() * 256;
            let y = Math.random() * 256;
            offCtx.beginPath();
            offCtx.moveTo(x, y);
            for (let seg = 0; seg < 3; seg++) {
                x += (Math.random() - 0.5) * 35;
                y += (Math.random() - 0.5) * 35;
                offCtx.lineTo(x, y);
            }
            offCtx.stroke();
        }

        return offCanvas;
    }

    function createHud() {
        if (hudEl) return;
        const viewportWrap = document.getElementById('viewport-wrap');
        if (!viewportWrap) return;

        // Overlay Canvas for Rising Molten Lava
        lavaCanvas = document.createElement('canvas');
        lavaCanvas.id = 'lava-fx-canvas';
        lavaCanvas.className = 'lava-fx-canvas';
        viewportWrap.appendChild(lavaCanvas);
        lavaCtx = lavaCanvas.getContext('2d');

        // Burn Damage Screen Overlay
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
                    <span class="lava-sec" id="lava-timer-sec">30</span>
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

        crustPattern = createCrustTexture();
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);
    }

    function resizeCanvas() {
        if (!lavaCanvas) return;
        const rect = lavaCanvas.getBoundingClientRect();
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        lavaCanvas.width = Math.round(rect.width * dpr) || 1024;
        lavaCanvas.height = Math.round(rect.height * dpr) || 768;
    }

    function initEmbers() {
        emberParticles = [];
        for (let i = 0; i < 45; i++) {
            emberParticles.push({
                x: Math.random(),
                y: Math.random(),
                size: 2 + Math.random() * 4,
                speedY: 0.18 + Math.random() * 0.35,
                driftX: (Math.random() - 0.5) * 0.12,
                alpha: 0.3 + Math.random() * 0.7
            });
        }
        lavaBubbles = [];
        for (let i = 0; i < 8; i++) {
            lavaBubbles.push({
                x: Math.random(),
                radius: 2,
                maxRadius: 6 + Math.random() * 10,
                progress: Math.random()
            });
        }
    }

    function drawMoltenLava(progress, isSubmerged) {
        if (!lavaCtx || !lavaCanvas) return;
        const w = lavaCanvas.width;
        const h = lavaCanvas.height;
        lavaCtx.clearRect(0, 0, w, h);

        noiseSeed += 0.022;

        if (progress <= 0) return;

        // Lava height on screen: rises from bottom (reaches max ~26% of screen height)
        // Keeps user's view clear so crates and upper platforms remain clearly visible
        const maxScreenHeight = h * 0.26;
        const lavaScreenHeight = maxScreenHeight * Math.min(1.0, progress);
        const lavaTopY = h - lavaScreenHeight;

        // 1. Base molten magma gradient
        const grad = lavaCtx.createLinearGradient(0, lavaTopY, 0, h);
        grad.addColorStop(0, 'rgba(255, 130, 0, 0.96)');
        grad.addColorStop(0.2, 'rgba(240, 50, 0, 0.94)');
        grad.addColorStop(0.65, 'rgba(160, 15, 0, 0.96)');
        grad.addColorStop(1, 'rgba(75, 4, 0, 0.98)');

        // 2. Animated bubbling molten surface polygon
        lavaCtx.save();
        lavaCtx.beginPath();
        lavaCtx.moveTo(0, h);
        lavaCtx.lineTo(0, lavaTopY);

        const waveSegments = 32;
        const waveOffsets = [];
        for (let i = 0; i <= waveSegments; i++) {
            const x = (i / waveSegments) * w;
            const wave1 = Math.sin(x * 0.016 + noiseSeed * 2.8) * 6;
            const wave2 = Math.cos(x * 0.032 - noiseSeed * 1.9) * 4;
            const waveY = lavaTopY + wave1 + wave2;
            waveOffsets.push({ x, y: waveY });
            lavaCtx.lineTo(x, waveY);
        }
        lavaCtx.lineTo(w, h);
        lavaCtx.closePath();

        // Fill with magma gradient
        lavaCtx.fillStyle = grad;
        lavaCtx.fill();

        // 3. Tile scrolling cracked basalt/magma texture
        if (crustPattern) {
            lavaCtx.save();
            lavaCtx.clip(); // Clip to the lava body
            lavaCtx.globalAlpha = 0.42;
            lavaCtx.globalCompositeOperation = 'screen';
            const scrollX = (noiseSeed * 30) % 256;
            const pat = lavaCtx.createPattern(crustPattern, 'repeat');
            if (pat) {
                lavaCtx.translate(-scrollX, 0);
                lavaCtx.fillStyle = pat;
                lavaCtx.fillRect(scrollX, lavaTopY - 20, w + 256, h - lavaTopY + 40);
            }
            lavaCtx.restore();
        }
        lavaCtx.restore();

        // 4. Glowing molten crest line (bright yellow/white magma edge)
        lavaCtx.beginPath();
        for (let i = 0; i <= waveSegments; i++) {
            const pt = waveOffsets[i];
            if (i === 0) lavaCtx.moveTo(pt.x, pt.y);
            else lavaCtx.lineTo(pt.x, pt.y);
        }
        lavaCtx.strokeStyle = 'rgba(255, 245, 170, 0.95)';
        lavaCtx.lineWidth = 4;
        lavaCtx.shadowColor = '#ffcc00';
        lavaCtx.shadowBlur = 10;
        lavaCtx.stroke();
        lavaCtx.shadowBlur = 0;

        // 5. Molten bubbles expanding on surface
        for (const b of lavaBubbles) {
            b.progress += 0.018;
            if (b.progress > 1.0) {
                b.progress = 0;
                b.x = Math.random();
                b.maxRadius = 6 + Math.random() * 10;
            }
            const bx = b.x * w;
            const waveY = lavaTopY + Math.sin(bx * 0.016 + noiseSeed * 2.8) * 6;
            const curR = b.maxRadius * Math.sin(b.progress * Math.PI);

            lavaCtx.beginPath();
            lavaCtx.arc(bx, waveY, Math.max(1, curR), 0, Math.PI * 2);
            lavaCtx.fillStyle = 'rgba(255, 210, 50, 0.85)';
            lavaCtx.shadowColor = '#ff6600';
            lavaCtx.shadowBlur = 8;
            lavaCtx.fill();
        }
        lavaCtx.shadowBlur = 0;

        // 6. Floating burning heat embers
        for (const p of emberParticles) {
            p.y -= p.speedY * 0.016;
            p.x += p.driftX * 0.016;
            if (p.y < 0.15) {
                p.y = 1.0;
                p.x = Math.random();
            }

            const px = p.x * w;
            const py = (lavaTopY - 25) + p.y * (h - lavaTopY + 25);
            if (py > h) continue;

            lavaCtx.beginPath();
            lavaCtx.arc(px, py, p.size, 0, Math.PI * 2);
            lavaCtx.fillStyle = `rgba(255, ${Math.floor(130 + Math.random() * 80)}, 30, ${p.alpha})`;
            lavaCtx.shadowColor = '#ff6600';
            lavaCtx.shadowBlur = 8;
            lavaCtx.fill();
        }
        lavaCtx.shadowBlur = 0;
    }

    let lastBeepSec = -1;

    function updateLavaMode(gameStatus, sendConsoleCommand) {
        if (!isLavaModeActive) {
            if (hudEl) hudEl.hidden = true;
            if (burnOverlayEl) burnOverlayEl.classList.remove('active');
            if (lavaCtx && lavaCanvas) lavaCtx.clearRect(0, 0, lavaCanvas.width, lavaCanvas.height);
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
            initEmbers();
            const mapSettings = MAP_LAVA_SETTINGS[gameStatus.map] || MAP_LAVA_SETTINGS['q3dm1'];
            lavaCurrentZ = mapSettings.startZ;
            lavaTargetZ = mapSettings.maxZ;
        }

        hudEl.hidden = false;

        const elapsedSec = (now - matchStartTime) / 1000;
        const remainingCountdown = Math.max(0, COUNTDOWN_SECONDS - elapsedSec);
        const currentSecInt = Math.ceil(remainingCountdown);

        // =====================================================================
        // Phase 1: 30-Second Arcade Countdown
        // =====================================================================
        if (remainingCountdown > 0) {
            timerSecEl.textContent = currentSecInt < 10 ? `0${currentSecInt}` : currentSecInt;
            const pct = (remainingCountdown / COUNTDOWN_SECONDS) * 100;
            barFillEl.style.width = `${pct}%`;

            if (currentSecInt <= 5) {
                hudEl.classList.add('urgent');
                if (currentSecInt !== lastBeepSec) {
                    lastBeepSec = currentSecInt;
                    // Ascending pitch during last 5 seconds (5: 800Hz, 1: 1100Hz)
                    const freq = 800 + (5 - currentSecInt) * 75;
                    playBeep(freq, 0.09, 'sawtooth');
                }
            } else if (currentSecInt === 10 && currentSecInt !== lastBeepSec) {
                lastBeepSec = currentSecInt;
                playBeep(650, 0.16);
            }

            drawMoltenLava(0, false);
            burnOverlayEl.classList.remove('active');
            return;
        }

        // =====================================================================
        // Phase 2: Lava Active & Slowly Rising
        // =====================================================================
        if (!hasLavaStarted) {
            hasLavaStarted = true;
            playSiren();
            hudEl.classList.add('lava-active');
            titleEl.textContent = '🔥 DİKKAT: ZEMİN LAV OLDU! 🔥';
            titleEl.style.color = '#ff3300';
            const mapSettings = MAP_LAVA_SETTINGS[gameStatus.map] || MAP_LAVA_SETTINGS['q3dm1'];
            subtextEl.textContent = mapSettings.safeDescription;
        }

        // Rise lava gradually over 15 seconds to target max safe height
        const lavaRiseDuration = 15.0;
        const lavaTime = elapsedSec - COUNTDOWN_SECONDS;
        const riseProgress = Math.min(1.0, lavaTime / lavaRiseDuration);
        const mapSettings = MAP_LAVA_SETTINGS[gameStatus.map] || MAP_LAVA_SETTINGS['q3dm1'];
        lavaCurrentZ = mapSettings.startZ + (mapSettings.maxZ - mapSettings.startZ) * riseProgress;

        timerSecEl.textContent = 'LAV';
        barFillEl.style.width = '100%';
        barFillEl.style.background = 'linear-gradient(90deg, #ff2200, #ff8800)';

        // Elevation detection: safe when standing on crates, stairs, or upper ramps
        const playerZ = gameStatus.origin ? gameStatus.origin[2] : 999;
        const isTouchingLava = playerZ <= (lavaCurrentZ + 8);

        drawMoltenLava(riseProgress, isTouchingLava);

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
        if (!enabled) {
            if (hudEl) hudEl.hidden = true;
            if (burnOverlayEl) burnOverlayEl.classList.remove('active');
            if (lavaCtx && lavaCanvas) lavaCtx.clearRect(0, 0, lavaCanvas.width, lavaCanvas.height);
        }
    }

    function isEnabled() {
        return isLavaModeActive;
    }

    globalThis.Q3Lava = Object.freeze({
        setEnabled,
        isEnabled,
        update: updateLavaMode
    });
})();
