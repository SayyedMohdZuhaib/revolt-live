// Minimal client: mic → 16kHz PCM → WS; play back 24kHz PCM from server.
let ws;
let audioCtx;
let micStream;
let processor;

const btnConnect = document.getElementById('connect');
//const btnMic = document.getElementById('mic');
const btnStop = document.getElementById('stop');
const txt = document.getElementById('text');
const sttDiv = document.getElementById('stt');
const logDiv = document.getElementById('log');
const statusPill = document.getElementById('status');

function log(line, cls='') {
  const p = document.createElement('div'); p.textContent = line;
  if (cls) p.className = cls; logDiv.appendChild(p); logDiv.scrollTop = logDiv.scrollHeight;
}

btnConnect.onclick = async () => {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    statusPill.textContent = 'connected';
    btnMic.disabled = false;
    txt.disabled = false;
    log('WS connected', 'ok');
  };
  ws.onclose = () => {
    statusPill.textContent = 'disconnected';
    btnMic.disabled = true; btnStop.disabled = true; txt.disabled = true;
    log('WS closed');
  };
  ws.onerror = (e) => log('WS error', 'bad');
  ws.onmessage = (ev) => handleServer(JSON.parse(ev.data));
  if (!audioCtx) audioCtx = new AudioContext({ sampleRate: 48000 });
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
  const src = audioCtx.createMediaStreamSource(micStream);

  // Use ScriptProcessor to pull 48kHz Float32, downsample to 16kHz Int16
  const bufSize = 2048;
  processor = audioCtx.createScriptProcessor(bufSize, 1, 1);
  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0); // Float32 48kHz
    const pcm16 = floatTo16BitPCM(downsampleTo16k(input, audioCtx.sampleRate));
    ws?.send(JSON.stringify({ type: 'audio', data: b64FromInt16(pcm16) }));
  };
  src.connect(processor);
  processor.connect(audioCtx.destination); // or audioCtx.createGain() if you want it silent
  btnMic.disabled = true; btnStop.disabled = false;
  log('Mic streaming…');
};

//async () => {
  // if (!audioCtx) audioCtx = new AudioContext({ sampleRate: 48000 });
  // micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
  // const src = audioCtx.createMediaStreamSource(micStream);

  // // Use ScriptProcessor to pull 48kHz Float32, downsample to 16kHz Int16
  // const bufSize = 2048;
  // processor = audioCtx.createScriptProcessor(bufSize, 1, 1);
  // processor.onaudioprocess = (e) => {
  //   const input = e.inputBuffer.getChannelData(0); // Float32 48kHz
  //   const pcm16 = floatTo16BitPCM(downsampleTo16k(input, audioCtx.sampleRate));
  //   ws?.send(JSON.stringify({ type: 'audio', data: b64FromInt16(pcm16) }));
  // };
  // src.connect(processor);
  // processor.connect(audioCtx.destination); // or audioCtx.createGain() if you want it silent
  // btnMic.disabled = true; btnStop.disabled = false;
  // log('Mic streaming…');
//};

btnStop.onclick = async () => {
  if (processor) { try { processor.disconnect(); } catch {} processor = null; }
  if (micStream) micStream.getTracks().forEach(t => t.stop());
  ws?.send(JSON.stringify({ type: 'audio_end' }));
  btnMic.disabled = false; btnStop.disabled = true;
  log('Mic stopped');
};

txt.onkeydown = (e) => {
  if (e.key === 'Enter' && txt.value.trim()) {
    ws?.send(JSON.stringify({ type: 'text', text: txt.value.trim() }));
    txt.value = '';
  }
};

// ---- Handle server → client events (audio + transcriptions + turns)
let playCtx;
let playQueue = [];
let playing = false;

function handleServer(msg) {
  if (msg.type === 'audio') {
    // msg.data is base64 of 16-bit PCM mono @ 24kHz
    const int16 = int16FromB64(msg.data);
    playQueue.push(int16);
    if (!playing) drainQueue();
  } else if (msg.type === 'turn_complete') {
    // turn is done; nothing special required
  } else if (msg.type === 'interrupted') {
    // stop playback immediately
    playQueue = [];
  } else if (msg.type === 'input_stt') {
    sttDiv.textContent = 'You: ' + msg.text;
  } else if (msg.type === 'output_stt') {
    sttDiv.textContent = 'Rev: ' + msg.text;
  } else if (msg.type === 'error') {
    log('Server error: ' + msg.message, 'bad');
  }
}

async function drainQueue() {
  playing = true;
  if (!playCtx) playCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
  while (playQueue.length) {
    const chunk = playQueue.shift();
    const f32 = float32FromInt16(chunk);
    const buffer = playCtx.createBuffer(1, f32.length, 24000);
    buffer.copyToChannel(f32, 0);
    const src = playCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(playCtx.destination);
    await startAndWait(src, buffer.duration);
  }
  playing = false;
}

function startAndWait(src, dur) {
  return new Promise((res) => {
    src.onended = () => res();
    src.start();
    setTimeout(() => {}, dur * 1000); // ensures scheduling
  });
}

// ---- Audio helpers
function downsampleTo16k(f32, inRate) {
  const outRate = 16000;
  const ratio = inRate / outRate;
  const newLen = Math.floor(f32.length / ratio);
  const out = new Float32Array(newLen);
  let o = 0;
  for (let i = 0; i < newLen; i++) {
    const idx = Math.floor(i * ratio);
    out[o++] = f32[idx];
  }
  return out;
}
function floatTo16BitPCM(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return out;
}
function b64FromInt16(int16) {
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function int16FromB64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}
function float32FromInt16(int16) {
  const f32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) f32[i] = Math.max(-1, Math.min(1, int16[i] / 0x7fff));
  return f32;
}
