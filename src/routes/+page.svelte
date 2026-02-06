<script lang="ts">
    import { onMount, onDestroy, tick } from "svelte";

    let transcript = $state("");
    let interimTranscript = $state(""); // Real-time interim results
    let currentParagraph = $state(""); // Buffer for continuous speech
    let lastCommitTime = 0;
    let isRecording = $state(false);
    let isTestMode = $state(false);
    let timerInterval: any = $state(null);
    let elapsedSeconds = $state(0);

    let isLoading = $state(false);
    let result = $state<{
        score: {
            structure: number;
            sentence: number;
            delivery: number;
            explaining_data: number;
            pace: number;
            overall: number;
        };
        feedback: string;
        structured_summary: string;
        improved_text?: string;
        questions?: string[];
    } | null>(null);

    // History Interface & State
    interface HistoryItem {
        id: string;
        date: string;
        title: string;
        transcript: string;
        score: {
            structure: number;
            sentence: number;
            delivery: number;
            explaining_data: number;
            pace: number;
            overall: number;
        };
        feedback: string;
        structured_summary: string;
        improved_text?: string;
        questions?: string[];
        wpm: number;
    }
    let history: HistoryItem[] = $state([]);

    let resultSection: HTMLElement | undefined = $state();
    let wpm = $state(0);
    let errorMsg = $state("");

    // Audio Visualizer State
    let audioContext: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let microphone: MediaStreamAudioSourceNode | null = null;
    let animationFrameId: number | null = null;

    let audioLevel = $state(0);
    let pitchCanvas: HTMLCanvasElement | undefined = $state();
    let pitchHistory: number[] = $state([]);

    const MAX_PITCH_HISTORY = 100; // Graph width
    // bgLayer removed in Canvas Refactor

    // Audio Feature Stats
    let pitchVariance = 0;
    let volumeMax = 0;
    let volumeMin = 1;
    let volumeSum = 0;
    let volumeCount = 0;
    let pauseCount = 0;
    let pauseTotalDuration = 0; // ms
    let lastAudioTime = 0;
    let isPaused = false;
    let pauseStartTime = 0;
    let lastMaxBin = 0;

    const SILENCE_THRESHOLD = 0.02; // Adjust as needed
    const PAUSE_MIN_DURATION = 300; // ms

    // Speech Recognition State
    let recognition: any = null;
    let recognitionActive = false;

    onMount(() => {
        // Initialize Speech Recognition
        const SpeechRecognition =
            (window as any).SpeechRecognition ||
            (window as any).webkitSpeechRecognition;
        if (SpeechRecognition) {
            recognition = new SpeechRecognition();
            recognition.continuous = true;
            recognition.interimResults = true;
            recognition.lang = "ja-JP";

            recognition.onresult = (event: any) => {
                // SOFTWARE MUTE SYNC:
                // Only accept results if the visualizer detects audio.
                if (audioLevel < 0.02) return;

                if (audioLevel < 0.02) return;

                let newFinalChunk = "";
                interimTranscript = ""; // Reset interim on new result batch

                // Loop through results
                for (let i = event.resultIndex; i < event.results.length; ++i) {
                    if (event.results[i].isFinal) {
                        newFinalChunk += event.results[i][0].transcript;
                    } else {
                        interimTranscript += event.results[i][0].transcript;
                    }
                }

                if (newFinalChunk) {
                    // Normalize: remove spacing because JA doesn't need it usually, but let's be safe
                    // For Japanese, usually no space.
                    currentParagraph += newFinalChunk;
                }
            };

            recognition.onerror = (event: any) => {
                console.error("Speech recognition error", event.error);
                if (event.error === "not-allowed") {
                    errorMsg = "マイクアクセスが拒否されました。";
                    stopTimer();
                }
            };

            recognition.onend = () => {
                if (recognitionActive && isRecording) {
                    try {
                        recognition.start();
                    } catch (e) {
                        console.error("Failed to restart recognition", e);
                    }
                }
            };
        } else {
            errorMsg =
                "このブラウザは音声認識をサポートしていません。ChromeまたはEdgeをご利用ください。";
        }

        // Load History from localStorage
        const storedHistory = localStorage.getItem("presentation_history");
        if (storedHistory) {
            try {
                history = JSON.parse(storedHistory);
            } catch (e) {
                console.error("Failed to parse history", e);
            }
        }
    });

    // History Functions
    function saveToHistory(res: any) {
        const now = new Date();
        const newItem: HistoryItem = {
            id: crypto.randomUUID(),
            date: now.toLocaleString("ja-JP", {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
            }),
            title: res.title || "No Title",
            transcript: transcript,
            score: res.score,
            feedback: res.feedback,
            structured_summary: res.structured_summary,
            questions: res.questions || [],
            wpm: wpm,
        };
        const newHistory = [newItem, ...history];
        history = newHistory;
        localStorage.setItem(
            "presentation_history",
            JSON.stringify(newHistory),
        );
    }

    function deleteHistory(id: string) {
        if (!confirm("この履歴を削除しますか？")) return;
        const newHistory = history.filter((item) => item.id !== id);
        history = newHistory;
        localStorage.setItem(
            "presentation_history",
            JSON.stringify(newHistory),
        );
    }

    function loadHistory(item: HistoryItem) {
        transcript = item.transcript;
        result = {
            score: item.score,
            feedback: item.feedback,
            structured_summary:
                item.structured_summary || item.improved_text || "",
            questions: item.questions || [],
        };
        wpm = item.wpm;
        resultSection?.scrollIntoView({ behavior: "smooth" });
    }

    // Audio Visualizer Logic
    async function startAudioVisualizer() {
        if (!navigator.mediaDevices) {
            throw new Error("Media devices not supported");
        }

        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    autoGainControl: true,
                    echoCancellation: true,
                    noiseSuppression: true,
                },
            });
        } catch (e: any) {
            if (
                e.name === "NotAllowedError" ||
                e.name === "PermissionDeniedError"
            ) {
                errorMsg =
                    "マイクの使用が許可されていません。ブラウザのアドレスバーから許可設定を確認してください。";
            } else {
                errorMsg = "マイクの起動に失敗しました: " + e.message;
            }
            throw e; // Re-throw to stop further execution
        }

        audioContext = new (window.AudioContext ||
            (window as any).webkitAudioContext)();
        if (audioContext.state === "suspended") {
            await audioContext.resume();
        }

        analyser = audioContext.createAnalyser();
        microphone = audioContext.createMediaStreamSource(stream);

        microphone.connect(analyser);
        analyser.fftSize = 1024; // Increased for better frequency resolution

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        const timeDomainArray = new Uint8Array(bufferLength);

        const updateVisualizer = () => {
            if (!analyser) return;

            // Get data
            analyser.getByteFrequencyData(dataArray);
            analyser.getByteTimeDomainData(timeDomainArray);

            // 1. Calculate Volume (RMS)
            let sumSquares = 0;
            for (let i = 0; i < bufferLength; i++) {
                const normalized = (timeDomainArray[i] - 128) / 128;
                sumSquares += normalized * normalized;
            }
            const rms = Math.sqrt(sumSquares / bufferLength);
            // Boost sensitivity
            audioLevel = Math.min(rms * 15, 1);

            // 2. Calculate Pitch (Simple Peak Frequency)
            let maxBin = 0;
            let maxVal = -1;
            for (let i = 0; i < bufferLength; i++) {
                if (dataArray[i] > maxVal) {
                    maxVal = dataArray[i];
                    maxBin = i;
                }
            }

            // Normalize pitch (0-1) for visualization
            // Assuming human voice range falls roughly within first 100 bins for this FFT size/sample rate
            const normalizedPitch = Math.min(maxBin / 100, 1);

            if (isRecording || isTestMode) {
                // Update Pitch History
                if (audioLevel > SILENCE_THRESHOLD) {
                    pitchHistory.push(normalizedPitch);
                } else {
                    pitchHistory.push(0); // Flat line for silence
                }
                if (pitchHistory.length > MAX_PITCH_HISTORY) {
                    pitchHistory.shift();
                }

                // Draw Pitch Graph
                // Draw Pitch Graph
                if (pitchCanvas) {
                    const ctx = pitchCanvas.getContext("2d");
                    if (ctx) {
                        const width = pitchCanvas.width;
                        const height = pitchCanvas.height;

                        ctx.clearRect(0, 0, width, height);

                        // Draw Pitch Line
                        ctx.beginPath();
                        ctx.strokeStyle = "#88b0a9"; // Sage Green
                        ctx.lineWidth = 3;
                        ctx.lineCap = "round";
                        ctx.lineJoin = "round";

                        const step = width / MAX_PITCH_HISTORY;

                        // Start point
                        ctx.moveTo(0, height);

                        for (let i = 0; i < pitchHistory.length; i++) {
                            const x = i * step;
                            const val = pitchHistory[i];
                            const y =
                                height - (val * height * 0.8 + height * 0.1);

                            if (i === 0) {
                                ctx.moveTo(x, y);
                            } else {
                                // Simple smooth curve
                                const prevX = (i - 1) * step;
                                const prevY =
                                    height -
                                    (pitchHistory[i - 1] * height * 0.8 +
                                        height * 0.1);
                                ctx.quadraticCurveTo(prevX, prevY, x, y);
                            }
                        }
                        ctx.stroke();
                    }
                }

                // Canvas Update handled in separate loop

                if (isRecording) {
                    // Collect Stats (only during recording)
                    volumeSum += rms; // Use true RMS
                    volumeCount++;
                    if (rms > volumeMax) volumeMax = rms;
                    if (rms < volumeMin) volumeMin = rms;

                    // Detect Pauses
                    const now = Date.now();
                    if (rms < SILENCE_THRESHOLD) {
                        if (!isPaused) {
                            isPaused = true;
                            pauseStartTime = now;
                        }
                    } else {
                        if (isPaused) {
                            isPaused = false;
                            const duration = now - pauseStartTime;
                            if (duration >= PAUSE_MIN_DURATION) {
                                pauseCount++;
                                pauseTotalDuration += duration;
                            }
                        }
                    }

                    // 2-Second Silence Commit Logic
                    if (
                        isRecording &&
                        isPaused &&
                        currentParagraph.length > 0
                    ) {
                        const silenceDuration = now - pauseStartTime;
                        if (silenceDuration > 2000) {
                            // Commit the paragraph
                            transcript +=
                                (transcript ? "\n" : "") + currentParagraph;
                            currentParagraph = "";
                        }
                    }

                    // Simple Pitch Variance (Variance of Peak Frequency Bin)
                    if (rms > SILENCE_THRESHOLD) {
                        if (lastMaxBin > 0) {
                            pitchVariance += Math.abs(maxBin - lastMaxBin) / 10;
                        }
                        lastMaxBin = maxBin;
                    }
                } // End isRecording checks

                animationFrameId = requestAnimationFrame(updateVisualizer);
            }
        };

        updateVisualizer();
    }

    function stopAudioVisualizer() {
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
        if (microphone) {
            microphone.disconnect();
            microphone = null;
        }
        if (analyser) {
            analyser.disconnect();
            analyser = null;
        }
        if (audioContext) {
            audioContext.close();
            audioContext = null;
        }
        audioLevel = 0;
    }

    // Timer & Recording Logic
    async function toggleTimer() {
        if (isTestMode) {
            // If in test mode, switch to recording
            toggleTestMode(); // Turn off test mode
            // Wait a tik to ensure resources are clean? Actually startTimer will handle it.
            // But let's be safe and wait for next tick.
            await tick();
        }

        if (isRecording) {
            stopTimer();
            // Automatically start evaluation after stopping
            await tick(); // Wait for state update
            evaluate();
        } else {
            await startTimer();
        }
    }

    async function toggleTestMode() {
        if (isRecording) {
            alert("録音中はテストモードに切り替えられません。");
            return;
        }

        if (isTestMode) {
            isTestMode = false;
            stopAudioVisualizer();
        } else {
            try {
                // Set flag FIRST so the loop continues
                isTestMode = true;
                pitchHistory = [];
                errorMsg = "";
                await startAudioVisualizer();
            } catch (e: any) {
                isTestMode = false; // Revert on failure
                // errorMsg is already set by startAudioVisualizer
            }
        }
    }

    async function startTimer() {
        if (!recognition) {
            errorMsg = "音声認識がサポートされていません。";
            return;
        }

        try {
            // Set flag FIRST
            isRecording = true;
            elapsedSeconds = 0;

            transcript = "";
            result = null;
            errorMsg = "";

            // Reset Audio Stats
            pitchVariance = 0;
            volumeMax = 0;
            volumeMin = 1;
            volumeSum = 0;
            volumeCount = 0;
            pauseCount = 0;
            pauseTotalDuration = 0;
            isPaused = false;
            lastAudioTime = Date.now();
            lastMaxBin = 0;
            pitchHistory = [];

            recognitionActive = true;
            recognition.start();

            // Start visualizer after setting flags and recognition
            await startAudioVisualizer();

            timerInterval = setInterval(() => {
                elapsedSeconds++;
            }, 1000);
        } catch (err: any) {
            // errorMsg is already set by startAudioVisualizer if it failed
            if (!errorMsg) {
                // Only set if not already set by visualizer
                errorMsg = "録音の開始に失敗しました: " + err.message;
            }
            console.error(err);
            stopTimer(); // This will cleanup
        }
    }

    function stopTimer() {
        isRecording = false;
        clearInterval(timerInterval);
        stopAudioVisualizer();

        recognitionActive = false;
        if (recognition) {
            try {
                recognition.stop();
            } catch (e) {
                /* ignore */
            }
        }
    }

    function resetTimer() {
        stopTimer();
        elapsedSeconds = 0;
        result = null;
        errorMsg = "";
        transcript = "";
    }

    function formatTime(seconds: number) {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, "0")}`;
    }

    function calculateWPM() {
        if (elapsedSeconds === 0) return 0;
        const minutes = elapsedSeconds / 60;
        const charCount = transcript.replace(/\s+/g, "").length;
        return Math.round(charCount / minutes);
    }

    async function evaluate() {
        if (!transcript.trim()) {
            errorMsg = "音声が検出されませんでした。";
            return;
        }

        isLoading = true;
        errorMsg = "";
        result = null;

        wpm = calculateWPM();
        console.log("Starting evaluation for transcript:", transcript);

        // Prepare Audio Features
        const volumeAvg = volumeCount > 0 ? volumeSum / volumeCount : 0;
        const pauseAvgDuration =
            pauseCount > 0 ? pauseTotalDuration / pauseCount : 0;

        const audioFeatures = {
            pitchVariance, // Simplified placeholder, real pitch detection is complex
            volumeMax,
            volumeMin,
            volumeAvg,
            pauseCount,
            pauseAvgDuration,
        };

        try {
            console.log("Sending request to /api/evaluate...", {
                transcript,
                audioFeatures,
            });
            const response = await fetch("/api/evaluate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ transcript, audioFeatures }),
            });
            console.log("Received response status:", response.status);

            if (!response.ok) {
                if (response.status === 503 || response.status === 429) {
                    throw new Error(
                        "サーバーが混み合っています。少し時間を置いて再度お試しください。",
                    );
                }
                const err = await response.json();
                const detailedMsg = err.details
                    ? `${err.error}: ${err.details}`
                    : err.error || "評価に失敗しました";
                throw new Error(detailedMsg);
            }

            console.log("Parsing response JSON...");
            const data = await response.json();
            console.log("Parsed data:", data);

            result = data;

            // Save to history automatically
            saveToHistory(result);

            console.log("Result state updated:", result);
            await tick();
            resultSection?.scrollIntoView({ behavior: "smooth" });
        } catch (e: any) {
            console.error("Evaluation error caught:", e);
            errorMsg = e.message;
        } finally {
            console.log("Evaluation finished, isLoading set to false");
            isLoading = false;
        }
    }

    // Canvas Particle System
    let bgCanvas: HTMLCanvasElement | undefined = $state();
    let particles: Particle[] = [];
    // Shooting Star Palette (Single Color Harmony: White/Gold)
    const particleColors = [
        "#ffffff", // Pure White
        "#fafafa", // Neutral White
        "#fef3c7", // Amber 100 (Subtle Gold)
        "#fffbeb", // Amber 50
    ];

    class Particle {
        x: number;
        y: number;
        radius: number;
        color: string;
        vx: number;
        vy: number;
        baseRadius: number;

        constructor(canvasParams: { width: number; height: number }) {
            this.x = Math.random() * canvasParams.width;
            this.y = Math.random() * canvasParams.height;
            this.baseRadius = Math.random() * 1.5 + 0.5; // Fine stars
            this.radius = this.baseRadius;
            this.color =
                particleColors[
                    Math.floor(Math.random() * particleColors.length)
                ];
            // Base movement: Slow drift
            this.vx = (Math.random() - 0.5) * 0.1;
            this.vy = (Math.random() - 0.5) * 0.1;
        }

        update(width: number, height: number, intensity: number = 0) {
            // SHOOTING STAR LOGIC:
            // When intensity is high, boost velocity significantly

            // SHOOTING STAR LOGIC (SMOOTH LINEAR):
            // When intensity is high, boost velocity significantly
            const boost = intensity * 20; // Stronger smooth boost

            // Apply boost strictly to existing velocity vector (NO RANDOM JITTER)
            // This creates clean, straight lines instead of "bug-like" movement
            this.x += this.vx * (1 + boost);
            this.y += this.vy * (1 + boost);

            // Wrap
            if (this.x < 0) this.x = width;
            if (this.x > width) this.x = 0;
            if (this.y < 0) this.y = height;
            if (this.y > height) this.y = 0;

            // Brighten/Enlarge on voice
            this.radius = this.baseRadius + intensity * 1.5;
        }

        draw(ctx: CanvasRenderingContext2D, intensity: number = 0) {
            ctx.beginPath();

            // Draw Trail if moving fast (Shooting Star Effect)
            if (intensity > 0.1) {
                const tailLength = intensity * 30; // Length varies with voice
                // Draw a line opposite to velocity
                ctx.moveTo(this.x, this.y);
                ctx.lineTo(
                    this.x - this.vx * tailLength * 2,
                    this.y - this.vy * tailLength * 2,
                );
                ctx.lineWidth = this.radius;
                ctx.strokeStyle = this.color;
                ctx.stroke();
            }

            // Draw Head
            ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
            ctx.fillStyle = this.color;

            // Intense bright flash on voice
            const alpha = 0.4 + intensity * 2;
            ctx.globalAlpha = Math.min(alpha, 1);

            // Strong Glow for Stars
            ctx.shadowBlur = 10 + intensity * 20;
            ctx.shadowColor = "white";
            ctx.fill();

            ctx.closePath();
            ctx.shadowBlur = 0;
            ctx.globalAlpha = 1;
        }
    }

    function initParticles() {
        if (!bgCanvas) return;
        particles = [];
        const particleCount = 100; // Optimized count
        for (let i = 0; i < particleCount; i++) {
            particles.push(
                new Particle({
                    width: bgCanvas.width,
                    height: bgCanvas.height,
                }),
            );
        }
    }

    function animateParticles() {
        if (!bgCanvas) return;
        const ctx = bgCanvas.getContext("2d");
        if (!ctx) return;

        // Resize if needed
        if (
            bgCanvas.width !== window.innerWidth ||
            bgCanvas.height !== window.innerHeight
        ) {
            bgCanvas.width = window.innerWidth;
            bgCanvas.height = window.innerHeight;
            initParticles(); // Re-init on resize
        }

        ctx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);

        // Get Audio Intensity (re-use from audioLevel if available, or 0)
        // Note: activeAudioLevel needs to be available. Using component state `audioLevel`.

        particles.forEach((p) => {
            p.update(bgCanvas!.width, bgCanvas!.height, audioLevel);
            p.draw(ctx, audioLevel);
        });

        requestAnimationFrame(animateParticles);
    }

    onMount(() => {
        // Start animation loop immediately
        animateParticles();

        // Initialize particles after canvas is bound
        if (bgCanvas) {
            bgCanvas.width = window.innerWidth;
            bgCanvas.height = window.innerHeight;
            initParticles();
        }
        window.addEventListener("resize", () => {
            if (bgCanvas) {
                bgCanvas.width = window.innerWidth;
                bgCanvas.height = window.innerHeight;
                initParticles();
            }
        });
    });

    onDestroy(() => {
        if (timerInterval) clearInterval(timerInterval);
        stopAudioVisualizer();
        if (recognition) recognition.stop();
    });
</script>

<!-- Canvas Background -->
<canvas bind:this={bgCanvas} class="bg-canvas"></canvas>

<div class="container">
    <h1>Vocalog AI</h1>
    <p>
        マイクに向かってプレゼンを行ってください。リアルタイムで文字起こしされ、AIが評価します。
    </p>

    <div class="editor-section">
        <!-- Visualizer & Timer Section -->
        <div class="controls-top">
            <!-- Audio Monitor -->
            <div class="audio-monitor">
                <!-- Input Level Gauge -->
                <div class="input-gauge-wrapper">
                    <div class="monitor-label">INPUT MONITOR</div>
                    <div class="input-gauge-track">
                        <div
                            class="input-gauge-bar"
                            style="width: {audioLevel * 100}%"
                        ></div>
                    </div>
                </div>

                <!-- Pitch Graph Display -->
                <div class="pitch-graph-wrapper">
                    <canvas bind:this={pitchCanvas} width="100" height="40"
                    ></canvas>
                    <div class="monitor-label">Pitch Monitor</div>
                </div>
            </div>

            <div class="timer">{formatTime(elapsedSeconds)}</div>
        </div>

        <div class="action-buttons">
            <button
                onclick={toggleTimer}
                class={isRecording ? "stop-btn" : "start-btn"}
                disabled={isLoading}
            >
                {isRecording ? "■ 録音停止" : "● 録音開始"}
            </button>

            {#if !isRecording && !result && !isLoading && !transcript}
                <button
                    onclick={toggleTestMode}
                    class="test-btn {isTestMode ? 'active' : ''}"
                >
                    {isTestMode ? "■ テスト終了" : "♪ マイクテスト"}
                </button>
            {/if}

            {#if isLoading}
                <div class="loading-overlay">
                    <div class="loading-content">
                        <div class="loading-spinner"></div>
                        <div class="loading-text">AIがプレゼンを分析中...</div>
                        <div class="loading-sub">
                            構成・話し方・個性を評価しています
                        </div>
                    </div>
                </div>
            {/if}

            {#if !isRecording && elapsedSeconds > 0 && !isLoading}
                <button onclick={resetTimer} class="reset-btn"
                    >またはリセット</button
                >
            {/if}
        </div>

        {#if errorMsg}
            <p class="error">{errorMsg}</p>
        {/if}

        <!-- Transcript Display -->
        <div class="transcript-box">
            {#if !transcript && !isRecording}
                <span class="placeholder"
                    >録音を開始すると、ここに文字起こしが表示されます...</span
                >
            {:else}
                {transcript}
                <span class="current-paragraph">{currentParagraph}</span>
                <span class="interim">{interimTranscript}</span>
            {/if}
            {#if isRecording}
                <span class="cursor">|</span>
            {/if}
        </div>
        <div class="meta-info">
            <span>現在の文字数: {transcript.length}</span>
        </div>
    </div>

    {#if result}
        <div class="result-card" bind:this={resultSection}>
            <h2>評価結果</h2>

            <div class="stats-grid">
                <div class="stat-item overall-card">
                    <span class="label">総合スコア</span>
                    <span class="value score-overall"
                        >{result.score.overall}</span
                    >
                </div>

                <!-- 5 Principles -->
                <div class="stat-item">
                    <span class="label">構成 (Structure)</span>
                    <span class="value">{result.score.structure}</span>
                </div>
                <div class="stat-item">
                    <span class="label">文章のキレ (Sentence)</span>
                    <span class="value">{result.score.sentence}</span>
                </div>
                <div class="stat-item">
                    <span class="label">デリバリー (Delivery)</span>
                    <span class="value">{result.score.delivery}</span>
                </div>
                <div class="stat-item">
                    <span class="label">説明力 (Explaining)</span>
                    <span class="value">{result.score.explaining_data}</span>
                </div>
                <div class="stat-item">
                    <span class="label">話速 (Pace)</span>
                    <span class="value">{result.score.pace}</span>
                </div>

                <!-- WPM Info -->
                <div class="stat-item wpm-card">
                    <span class="label">WPM (文字/分)</span>
                    <span class="value">{wpm}</span>
                    <span class="sub"
                        >{wpm > 300
                            ? "早口気味"
                            : wpm < 200
                              ? "ゆっくり"
                              : "適正範囲"}</span
                    >
                </div>
            </div>

            <div class="feedback-section">
                <h3>アドバイス</h3>
                <p>{result.feedback}</p>
            </div>

            <div class="improved-section">
                <h3>あなたのプレゼンの骨子（AI要約）</h3>
                <div class="improved-text">
                    {result.structured_summary}
                </div>
            </div>

            {#if result.questions && result.questions.length > 0}
                <div class="questions-section">
                    <h3>想定質問：これを聞かれるかも！</h3>
                    <ul>
                        {#each result.questions as question}
                            <li>{question}</li>
                        {/each}
                    </ul>
                </div>
            {/if}
        </div>
    {/if}

    <!-- History Section -->
    {#if history.length > 0}
        <div class="history-section">
            <h2>過去の練習履歴</h2>
            <div class="history-list">
                {#each history as item}
                    <div
                        class="history-card"
                        onclick={() => loadHistory(item)}
                        onkeydown={(e) =>
                            (e.key === "Enter" || e.key === " ") &&
                            loadHistory(item)}
                        role="button"
                        tabindex="0"
                    >
                        <div class="history-header">
                            <span class="history-date">{item.date}</span>
                            <button
                                class="delete-btn"
                                onclick={(e) => {
                                    e.stopPropagation();
                                    deleteHistory(item.id);
                                }}
                                aria-label="削除">×</button
                            >
                        </div>
                        <div class="history-title">{item.title}</div>
                        <div class="history-score">
                            Score: {item.score.overall}
                        </div>
                    </div>
                {/each}
            </div>
        </div>
    {/if}
</div>

<svelte:head>
    <title>Vocalog AI - 声と星空のプレゼンコーチ</title>
    <meta
        name="description"
        content="1分間のスピーチで、構成・話し方・個性をAIが即座に分析。「星空」のような美しいビジュアルと共に、あなたのプレゼンをコーチングします。"
    />

    <!-- OGP -->
    <meta property="og:title" content="Vocalog AI - 声と星空のプレゼンコーチ" />
    <meta
        property="og:description"
        content="1分間のスピーチで、構成・話し方・個性をAIが即座に分析。"
    />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="https://vocalog-ai.vercel.app" />
    <!-- Placeholder -->
    <meta property="og:image" content="/ogp-image.png" />

    <!-- Twitter -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="Vocalog AI" />
    <meta
        name="twitter:description"
        content="1分間のスピーチで、構成・話し方・個性をAIが即座に分析。"
    />
</svelte:head>

<style>
    @import url("https://fonts.googleapis.com/css2?family=Outfit:wght@200;300;400;500;700&display=swap");

    :global(:root) {
        /* Night Theme Variables */
        --bg-color: #0f172a; /* Slate 900 (Deep Night) */
        --text-color: #f1f5f9; /* Slate 100 */
        --primary-color: #bef264; /* Lime 400 (Firefly Glow) */
        --accent-color: #fde047; /* Yellow 300 (Light) */
        --accent-light: #fef08a; /* Yellow 200 */

        --bg-accent-opacity: 0.1;
    }

    :global(body) {
        font-family: "Outfit", "Helvetica Neue", Arial, sans-serif;
        /* background-color: var(--bg-color); */
        color: var(--text-color);
        margin: 0;
        transition: background-color 0.5s ease;
        position: relative;
        overflow-x: hidden;
    }

    /* Interactive Background Canvas */
    .bg-canvas {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        z-index: -1; /* Behind everything */
        pointer-events: none;
        /* Deep Night Radial Gradient */
        background: radial-gradient(circle at center, #1e293b 0%, #020617 100%);
    }

    @keyframes float {
        0% {
            transform: translate(0, 0) rotate(0deg);
        }
        50% {
            transform: translate(30px, -20px) rotate(5deg);
        }
        100% {
            transform: translate(-20px, 10px) rotate(-5deg);
        }
    }

    /* Active state overlay (Warm Orange Glow Boost) */
    /* Active state overlay REMOVED per user request (Stop Gradient) */

    .container {
        max-width: 800px;
        margin: 0 auto;
        padding: 40px 20px;
        position: relative;
    }

    h1 {
        text-align: center;
        color: var(--text-color);
        font-weight: 800; /* Extra Bold */
        font-size: 4.5rem; /* Much Larger */
        letter-spacing: -0.02em; /* Tighter for modern look */
        margin-bottom: 20px;
        text-shadow: 0 0 30px rgba(190, 242, 100, 0.3); /* Integrated Glow */
        background: linear-gradient(to right, #ffffff, #bef264);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        display: inline-block; /* For gradient text */
        width: 100%;
    }

    /* .evaluate-btn unused styles removed */

    .editor-section {
        background: rgba(15, 23, 42, 0.6); /* Dark Glass */
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border-radius: 24px;
        padding: 40px;
        box-shadow: 0 10px 40px -10px rgba(0, 0, 0, 0.5); /* Stronger shadow */
        border: 1px solid rgba(255, 255, 255, 0.1);
        margin-bottom: 30px;
        transition:
            transform 0.3s ease,
            box-shadow 0.3s ease;
        display: flex;
        flex-direction: column;
        align-items: center;
        color: white; /* Ensure text is white */
    }

    .editor-section:hover {
        transform: translateY(-2px);
        box-shadow: 0 15px 50px -10px rgba(0, 0, 0, 0.6);
        border-color: rgba(255, 255, 255, 0.2);
    }

    .controls-top {
        width: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        margin-bottom: 20px;
        gap: 25px;
    }

    /* .recording-section unused styles removed */

    .action-buttons {
        display: flex;
        gap: 15px;
        margin-bottom: 25px;
        flex-wrap: wrap;
        justify-content: center;
    }

    button {
        padding: 12px 24px;
        border: none;
        border-radius: 50px;
        cursor: pointer;
        font-weight: 600;
        font-size: 16px;
        transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
        box-shadow: 0 5px 15px rgba(0, 0, 0, 0.05);
    }

    .start-btn {
        background: #ef4444; /* Red 500 */
        color: white;
        padding-left: 32px;
        padding-right: 32px;
        box-shadow: 0 0 15px rgba(239, 68, 68, 0.4); /* Red Glow */
    }

    .stop-btn {
        background: rgba(255, 255, 255, 0.1); /* Dark Semi-transparent */
        color: white;
        border: 1px solid rgba(255, 255, 255, 0.2);
        padding-left: 32px;
        padding-right: 32px;
    }

    .stop-btn:hover {
        background: rgba(255, 255, 255, 0.2);
    }

    .test-btn {
        background: rgba(255, 255, 255, 0.05);
        color: #94a3b8;
        border: 1px solid rgba(255, 255, 255, 0.1);
        padding-left: 20px;
        padding-right: 20px;
        font-weight: 400;
        font-size: 0.9rem;
    }

    .test-btn.active {
        background: rgba(34, 211, 238, 0.1); /* Cyan tint */
        color: #22d3ee;
        border-color: rgba(34, 211, 238, 0.3);
        box-shadow: 0 0 10px rgba(34, 211, 238, 0.2);
    }

    .reset-btn {
        background: transparent;
        color: #94a3b8;
        box-shadow: none;
        text-decoration: underline;
        font-size: 0.9rem;
    }

    .audio-monitor {
        display: flex;
        gap: 30px;
        align-items: center;
        background: rgba(255, 255, 255, 0.05); /* More subtle background */
        padding: 20px 30px;
        border-radius: 20px;
        border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .monitor-label {
        font-size: 0.75rem;
        color: rgba(255, 255, 255, 0.7); /* Brighter label */
        margin-bottom: 4px;
        letter-spacing: 0.05em;
    }

    /* High Visibility Input Gauge */
    .input-gauge-wrapper {
        width: 100%;
        margin-bottom: 10px;
    }

    .input-gauge-track {
        height: 6px;
        background: rgba(0, 0, 0, 0.6); /* Darker track for contrast */
        border-radius: 3px;
        overflow: hidden;
    }

    .input-gauge-bar {
        height: 100%;
        background: #22d3ee; /* Bright Cyan/Green for visibility */
        box-shadow: 0 0 10px #22d3ee; /* Glow for visibility */
        transition: width 0.05s ease;
    }

    canvas {
        background: transparent;
    }

    .interim {
        color: rgba(255, 255, 255, 0.5); /* Dimmed text for interim */
    }
    .current-paragraph {
        color: rgba(255, 255, 255, 0.9);
    }

    .transcript-box {
        width: 100%;
        background: rgba(255, 255, 255, 0.05); /* Dark Glass */
        padding: 24px;
        border-radius: 16px;
        min-height: 120px;
        max-height: 400px;
        overflow-y: auto;
        white-space: pre-wrap;
        line-height: 1.8;
        color: var(--text-color);
        border: 1px solid rgba(255, 255, 255, 0.1);
        font-size: 0.95rem;
    }

    .placeholder {
        color: rgba(255, 255, 255, 0.4);
        font-style: italic;
    }

    .meta-info {
        width: 100%;
        text-align: right;
        font-size: 11px;
        color: rgba(255, 255, 255, 0.4);
        margin-top: 10px;
    }

    .error {
        color: #ef4444; /* Red 500 */
        font-size: 0.9rem;
        background: rgba(239, 68, 68, 0.1);
        padding: 10px;
        border-radius: 8px;
        text-align: center;
        margin-top: 10px;
        border: 1px solid rgba(239, 68, 68, 0.2);
    }

    /* Loading Overlay */
    .loading-overlay {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(15, 23, 42, 0.7); /* Dark Dim */
        backdrop-filter: blur(4px);
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 24px;
        z-index: 50;
    }

    .loading-content {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 15px;
        background: rgba(30, 41, 59, 0.8); /* Slate 800 Glass */
        padding: 30px 50px;
        border-radius: 20px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
    }

    .loading-spinner {
        width: 40px;
        height: 40px;
        border: 3px solid rgba(190, 242, 100, 0.3); /* Base Lime */
        border-top-color: var(--primary-color);
        border-radius: 50%;
        animation: spin 1s cubic-bezier(0.55, 0.055, 0.675, 0.19) infinite;
    }

    @keyframes spin {
        0% {
            transform: rotate(0deg);
        }
        100% {
            transform: rotate(360deg);
        }
    }

    .loading-text {
        color: var(--primary-color);
        font-weight: bold;
        font-size: 1.1rem;
        letter-spacing: 0.05em;
        animation: pulse 2s infinite;
    }

    .loading-sub {
        font-size: 0.8rem;
        color: rgba(255, 255, 255, 0.6);
    }

    @keyframes pulse {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.6;
        }
    }

    /* Result UI */
    .result-card {
        background: rgba(15, 23, 42, 0.6); /* Dark Glass */
        backdrop-filter: blur(12px);
        padding: 40px;
        border-radius: 24px;
        box-shadow: 0 10px 40px -10px rgba(0, 0, 0, 0.5);
        border: 1px solid rgba(255, 255, 255, 0.1);
        margin-bottom: 30px;
        animation: slideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes slideUp {
        from {
            opacity: 0;
            transform: translateY(40px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }

    /* .total-score and .score-circle removed as they are unused */

    .stats-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 15px;
        margin-bottom: 40px;
    }

    .stat-item {
        background: rgba(255, 255, 255, 0.05); /* Dark Glass */
        padding: 20px 15px;
        border-radius: 16px;
        text-align: center;
        display: flex;
        border: 1px solid rgba(255, 255, 255, 0.1);

        flex-direction: column;
        justify-content: center;
    }

    .stat-item .label {
        font-size: 11px;
        color: #64748b;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 8px;
    }

    .stat-item .value {
        font-size: 24px;
        font-weight: bold;
        color: var(--text-color);
    }

    .stat-item .score-overall {
        color: var(--primary-color);
        font-size: 32px;
    }

    .stat-item .sub {
        font-size: 11px;
        color: #94a3b8;
        margin-top: 4px;
    }

    h3 {
        color: var(--text-color);
        font-size: 1.1rem;
        border-bottom: none;
        margin-bottom: 20px;
        display: flex;
        align-items: center;
        gap: 12px;
    }

    h3::before {
        content: "";
        display: block;
        width: 6px;
        height: 24px;
        background: var(--accent-light);
        border-radius: 3px;
    }

    .feedback-section,
    .improved-section,
    .questions-section {
        margin-top: 40px;
    }

    .questions-section ul {
        background: rgba(255, 251, 235, 0.1); /* Dark Warm Glass */
        padding: 30px 40px;
        border-radius: 16px;
        border-left: 4px solid var(--accent-light);
        list-style-type: none;
        border: 1px solid rgba(255, 255, 255, 0.05);
    }

    .questions-section li {
        margin-bottom: 15px;
        line-height: 1.6;
        color: var(--accent-light); /* Light Yellow text for dark bg */

        position: relative;
        padding-left: 20px;
    }

    .questions-section li::before {
        content: "Q.";
        position: absolute;
        left: -5px;
        font-weight: bold;
        color: var(--accent-color);
        font-size: 0.9em;
    }

    .improved-text {
        background: rgba(240, 253, 250, 0.1); /* Dark Mint Glass */
        padding: 40px;
        border-radius: 16px;
        line-height: 2; /* More balanced spacing */
        border-left: 4px solid var(--primary-color);
        border: 1px solid rgba(255, 255, 255, 0.05);
        font-size: 1.05rem; /* Larger font */
        letter-spacing: 0.03em;
        color: var(--text-color);
        white-space: pre-wrap; /* Ensure newlines are rendered */
    }

    .history-section {
        margin-top: 80px;
        border-top: 1px dashed #cbd5e1;
        padding-top: 60px;
    }

    .history-section h2 {
        text-align: center;
        font-size: 1.2rem;
        color: #94a3b8;
        margin-bottom: 30px;
        font-weight: 400;
    }

    .history-list {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 25px;
    }

    .history-card {
        background: rgba(255, 255, 255, 0.05); /* Dark Glass */
        padding: 25px;
        border-radius: 20px;
        box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
        cursor: pointer;
        transition: all 0.2s ease;
        border: 1px solid rgba(255, 255, 255, 0.1);
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    .history-card:hover {
        transform: translateY(-5px);
        box-shadow: 0 15px 30px rgba(0, 0, 0, 0.05);
        border-color: var(--primary-color);
    }

    .history-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
    }

    .history-date {
        font-size: 11px;
        color: rgba(255, 255, 255, 0.6);
        background: rgba(255, 255, 255, 0.1);
        padding: 5px 12px;
        border-radius: 30px;
    }

    .delete-btn {
        background: none;
        border: none;
        color: #cbd5e1;
        font-size: 20px;
        padding: 5px;
        line-height: 1;
        cursor: pointer;
        transition: color 0.2s;
        box-shadow: none;
    }

    .delete-btn:hover {
        color: #ef4444;
        background: none;
        transform: none;
    }

    .history-title {
        font-weight: 600;
        font-size: 15px;
        color: var(--text-color);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-top: 5px;
    }

    .history-score {
        font-size: 13px;
        color: var(--primary-color);
        font-weight: 600;
        align-self: flex-start;
    }
</style>
