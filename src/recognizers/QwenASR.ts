import { Recognizer } from "./recognizer";
import {
    info,
    error,
    debug,
    warn
} from '@tauri-apps/plugin-log';

export class QwenASR extends Recognizer {
    private ws: WebSocket | null = null;
    private apiKey: string;
    private mediaRecorder: MediaRecorder | null = null;
    private audioContext: AudioContext | null = null;
    private audioProcessor: ScriptProcessorNode | null = null;
    private audioSource: MediaStreamAudioSourceNode | null = null;
    private resultCallback: ((result: string, final: boolean) => void) | null = null;
    private isConnecting: boolean = false;
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 5;
    private enableServerVad: boolean = true;
    private currentTranscript: string = "";
    private sessionConfigured: boolean = false;

    constructor(lang: string, apiKey: string) {
        super(lang);
        this.apiKey = apiKey;
    }

    async start() {
        if (this.running) {
            info("[QWEN-ASR] Already running");
            return;
        }

        if (!this.apiKey || this.apiKey.trim() === "") {
            error("[QWEN-ASR] API key is required");
            return;
        }

        this.running = true;
        info("[QWEN-ASR] Starting recognition...");

        try {
            await this.connectWebSocket();
            await this.startAudioCapture();
        } catch (e) {
            error("[QWEN-ASR] Error starting recognition: " + e);
            this.running = false;
        }
    }

    stop() {
        info("[QWEN-ASR] Stopping recognition...");
        this.running = false;
        this.sessionConfigured = false;
        this.stopAudioCapture();
        this.closeWebSocket();
    }

    set_lang(lang: string) {
        debug("[QWEN-ASR] Language set to " + lang);
        this.language = lang;
        
        // Restart with new language
        if (this.running) {
            this.stop();
            setTimeout(() => {
                this.start();
            }, 500);
        }
    }

    status(): boolean {
        return this.running;
    }

    onResult(callback: (result: string, final: boolean) => void) {
        this.resultCallback = callback;
    }

    private async connectWebSocket(): Promise<void> {
        if (this.isConnecting || this.ws) {
            return;
        }

        this.isConnecting = true;

        return new Promise((resolve, reject) => {
            try {
                const MODEL = 'qwen3-asr-flash-realtime';
                const baseUrl = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
                // In browser environments, we cannot set custom HTTP headers on WebSocket.
                // However, we can use subprotocols that follow RFC 6455 naming rules.
                // We encode authentication info using valid subprotocol tokens.
                const url = `${baseUrl}?model=${MODEL}`;

                info(`[QWEN-ASR] Connecting to WebSocket...`);

                // Use valid subprotocol names that don't contain '=' or other invalid characters
                // Format the API key as a subprotocol: "authorization.bearer.<token>"
                const protocols = [
                    'realtime-v1',  // Changed from 'realtime=v1' to follow RFC 6455
                    `authorization.bearer.${this.apiKey}`
                ];

                this.ws = new WebSocket(url, protocols);

                this.ws.onopen = () => {
                    info("[QWEN-ASR] WebSocket connected");
                    this.isConnecting = false;
                    this.reconnectAttempts = 0;
                    
                    // Wait a bit before sending session config
                    setTimeout(() => {
                        this.sendSessionUpdate();
                    }, 100);
                    
                    resolve();
                };

                this.ws.onmessage = (event) => {
                    this.handleMessage(event.data);
                };

                this.ws.onerror = (err) => {
                    error("[QWEN-ASR] WebSocket error: " + JSON.stringify(err));
                    this.isConnecting = false;
                    reject(err);
                };

                this.ws.onclose = (event) => {
                    info(`[QWEN-ASR] WebSocket closed: ${event.code} - ${event.reason}`);
                    this.isConnecting = false;
                    this.ws = null;

                    if (this.running && this.reconnectAttempts < this.maxReconnectAttempts) {
                        this.reconnectAttempts++;
                        info(`[QWEN-ASR] Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
                        setTimeout(() => {
                            this.connectWebSocket();
                        }, 2000 * this.reconnectAttempts);
                    }
                };
            } catch (err) {
                error("[QWEN-ASR] Failed to create WebSocket: " + err);
                this.isConnecting = false;
                reject(err);
            }
        });
    }

    private closeWebSocket() {
        if (this.ws) {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.close(1000, 'Recognition stopped');
            }
            this.ws = null;
        }
    }

    private sendSessionUpdate() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            warn("[QWEN-ASR] WebSocket not ready for session update");
            return;
        }

        if (this.sessionConfigured) {
            debug("[QWEN-ASR] Session already configured");
            return;
        }

        // Map language codes to Qwen ASR supported languages
        let qwenLang = 'zh';
        if (this.language.startsWith('en')) {
            qwenLang = 'en';
        } else if (this.language.startsWith('ja')) {
            qwenLang = 'ja';
        } else if (this.language.startsWith('ko') || this.language.startsWith('kr')) {
            qwenLang = 'ko';
        } else if (this.language.startsWith('es')) {
            qwenLang = 'es';
        } else if (this.language.startsWith('fr')) {
            qwenLang = 'fr';
        } else if (this.language.startsWith('de')) {
            qwenLang = 'de';
        } else if (this.language.startsWith('zh')) {
            qwenLang = 'zh';
        }

        const sessionUpdate = {
            event_id: 'event_session_' + Date.now(),
            type: 'session.update',
            session: {
                modalities: ['text'],
                input_audio_format: 'pcm',
                sample_rate: 16000,
                input_audio_transcription: {
                    language: qwenLang
                },
                turn_detection: this.enableServerVad ? {
                    type: 'server_vad',
                    threshold: 0.2,
                    silence_duration_ms: 800
                } : null
            }
        };

        info("[QWEN-ASR] Sending session update with language: " + qwenLang);
        this.ws.send(JSON.stringify(sessionUpdate));
        this.sessionConfigured = true;
    }

    private handleMessage(data: string) {
        try {
            const message = JSON.parse(data);
            debug("[QWEN-ASR] Received event: " + message.type);

            if (message.type === 'conversation.item.input_audio_transcription.completed') {
                const transcript = message.transcript || '';
                info(`[QWEN-ASR] Final transcript: ${transcript}`);
                this.currentTranscript = transcript;
                
                if (this.resultCallback && transcript) {
                    this.resultCallback(transcript, true);
                }
            } else if (message.type === 'conversation.item.input_audio_transcription.delta') {
                const delta = message.delta || '';
                debug(`[QWEN-ASR] Transcript delta: ${delta}`);
                this.currentTranscript += delta;
                
                if (this.resultCallback && this.currentTranscript) {
                    this.resultCallback(this.currentTranscript, false);
                }
            } else if (message.type === 'error') {
                error(`[QWEN-ASR] Server error: ${JSON.stringify(message)}`);
            }
        } catch (e) {
            error("[QWEN-ASR] Failed to parse message: " + e);
        }
    }

    private async startAudioCapture() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    channelCount: 1,
                    sampleRate: 16000,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                } 
            });

            this.audioContext = new AudioContext({ sampleRate: 16000 });
            this.audioSource = this.audioContext.createMediaStreamSource(stream);
            
            // Use ScriptProcessorNode for audio processing
            const bufferSize = 4096;
            this.audioProcessor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
            
            this.audioProcessor.onaudioprocess = (e) => {
                if (!this.running || !this.ws || this.ws.readyState !== WebSocket.OPEN || !this.sessionConfigured) {
                    return;
                }

                const inputData = e.inputBuffer.getChannelData(0);
                const pcm16 = this.convertToPCM16(inputData);
                const base64Audio = this.arrayBufferToBase64(pcm16);

                const audioEvent = {
                    event_id: `event_audio_${Date.now()}_${Math.random()}`,
                    type: 'input_audio_buffer.append',
                    audio: base64Audio
                };

                try {
                    this.ws.send(JSON.stringify(audioEvent));
                } catch (e) {
                    error("[QWEN-ASR] Error sending audio: " + e);
                }
            };

            this.audioSource.connect(this.audioProcessor);
            this.audioProcessor.connect(this.audioContext.destination);

            info("[QWEN-ASR] Audio capture started");
        } catch (e) {
            error("[QWEN-ASR] Error starting audio capture: " + e);
            throw e;
        }
    }

    private stopAudioCapture() {
        if (this.audioProcessor) {
            this.audioProcessor.disconnect();
            this.audioProcessor = null;
        }
        if (this.audioSource) {
            this.audioSource.disconnect();
            this.audioSource = null;
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        if (this.mediaRecorder) {
            this.mediaRecorder.stop();
            this.mediaRecorder = null;
        }
        info("[QWEN-ASR] Audio capture stopped");
    }

    private convertToPCM16(float32Array: Float32Array): ArrayBuffer {
        const pcm16 = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            const s = Math.max(-1, Math.min(1, float32Array[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return pcm16.buffer;
    }

    private arrayBufferToBase64(buffer: ArrayBuffer): string {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }
}
