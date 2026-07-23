// audio.js — Web Audio engine for Jam-Meet.
// Two responsibilities:
//   1. synthDemoStems(): render playable 4-bar demo loops (drums/bass/keys/lead/…)
//      from a song's key + BPM so the app can demo itself with zero uploads.
//   2. Mixer: a multitrack transport with per-track gain/mute/solo, analyser-based
//      VU metering, synced start, loop, seek, master volume and a metronome.

let _ctx = null
export function getCtx() {
  if (!_ctx) {
    const AC = window.AudioContext || window.webkitAudioContext
    _ctx = new AC()
  }
  return _ctx
}

/* ------------------------------------------------------------------ */
/* Music theory helpers                                                */
/* ------------------------------------------------------------------ */

const NOTE_SEMI = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6,
  Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
}
const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
}
// One chord per bar over 4 bars. Degrees are 0-indexed into the scale.
const PROGRESSIONS = {
  major: [0, 5, 3, 4], // I  vi IV V
  minor: [0, 5, 2, 6], // i  VI III VII
}

function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12)
}

function parseKey(keyStr) {
  // "C major", "F# minor" … tolerate odd input.
  const [root = 'C', scale = 'major'] = String(keyStr || 'C major').split(/\s+/)
  return {
    rootSemi: NOTE_SEMI[root] ?? 0,
    scale: SCALES[scale] ? scale : 'major',
  }
}

function chordForBar(bar, rootSemi, scaleName) {
  const scale = SCALES[scaleName]
  const degree = PROGRESSIONS[scaleName][bar % 4]
  const note = (i) => {
    const d = degree + i
    const oct = Math.floor(d / 7)
    return rootSemi + scale[d % 7] + 12 * oct
  }
  // triad: root, third, fifth (as semitone offsets from song root octave)
  return [note(0), note(2), note(4)]
}

/* ------------------------------------------------------------------ */
/* Demo stem synthesis                                                 */
/* ------------------------------------------------------------------ */

export const DEMO_TRACK_NAMES = ['Drums', 'Bass', 'Keys', 'Lead', 'Pads', 'Perc']

function kindForName(name) {
  const n = String(name).toLowerCase()
  if (/(drum|kit|beat)/.test(n)) return 'drums'
  if (/bass/.test(n)) return 'bass'
  if (/pad|string|synth/.test(n)) return 'pads'
  if (/lead|melody|solo|gtr|guitar|vox|vocal/.test(n)) return 'lead'
  if (/perc|shaker|conga|tamb/.test(n)) return 'perc'
  return 'keys'
}

function whiteNoiseBuffer(ctx, seconds = 1) {
  const buf = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  return buf
}

function env(ctx, node, t, { a = 0.005, peak = 1, d = 0.2, end = 0.0001 }) {
  node.gain.setValueAtTime(0.0001, t)
  node.gain.linearRampToValueAtTime(peak, t + a)
  node.gain.exponentialRampToValueAtTime(end, t + a + d)
}

/**
 * Synthesize one demo stem as an AudioBuffer (4 bars, loop-friendly length).
 */
async function renderDemoStem(kind, { rootSemi, scale, bpm, beatsPerBar }) {
  const sr = 44100
  const spb = 60 / bpm
  const bars = 4
  const dur = bars * beatsPerBar * spb
  const off = new OfflineAudioContext(2, Math.round(dur * sr), sr)
  const out = off.createGain()
  out.connect(off.destination)
  const noise = whiteNoiseBuffer(off, 1.5)

  const playNoise = (t, { hp = null, lp = null, bp = null, gain = 0.5, decay = 0.1 }) => {
    const src = off.createBufferSource()
    src.buffer = noise
    let node = src
    if (hp) { const f = off.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp; node.connect(f); node = f }
    if (bp) { const f = off.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = bp; f.Q.value = 0.8; node.connect(f); node = f }
    if (lp) { const f = off.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; node.connect(f); node = f }
    const g = off.createGain()
    node.connect(g); g.connect(out)
    env(off, g, t, { a: 0.001, peak: gain, d: decay })
    src.start(t); src.stop(Math.min(t + decay + 0.05, dur))
  }
  const playTone = (t, freq, { type = 'sine', gain = 0.3, a = 0.005, d = 0.25, glideTo = null, glideTime = 0.1, lp = null, detune = 0 }) => {
    const osc = off.createOscillator()
    osc.type = type
    osc.frequency.setValueAtTime(freq, t)
    osc.detune.value = detune
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t + glideTime)
    let node = osc
    if (lp) { const f = off.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; node.connect(f); node = f }
    const g = off.createGain()
    node.connect(g); g.connect(out)
    env(off, g, t, { a, peak: gain, d })
    osc.start(t); osc.stop(Math.min(t + a + d + 0.05, dur))
  }

  const totalBeats = bars * beatsPerBar
  const backbeats = beatsPerBar >= 4 ? [1, 3] : [1] // snare on 2 & 4 (0-indexed)

  for (let bar = 0; bar < bars; bar++) {
    const barT = bar * beatsPerBar * spb
    const chord = chordForBar(bar, rootSemi, scale)

    if (kind === 'drums') {
      for (let b = 0; b < beatsPerBar; b++) {
        const t = barT + b * spb
        // kick: sine drop 140→45 Hz
        playTone(t, 140, { type: 'sine', gain: 0.9, a: 0.002, d: 0.22, glideTo: 45, glideTime: 0.09 })
        if (backbeats.includes(b)) playNoise(t, { bp: 1900, gain: 0.55, decay: 0.16 }) // snare
        // hats: 8ths
        playNoise(t, { hp: 8000, gain: 0.16, decay: 0.03 })
        playNoise(t + spb / 2, { hp: 8000, gain: 0.1, decay: 0.025 })
      }
    }

    if (kind === 'bass') {
      const rootMidi = 36 + chord[0] // C2-based
      const fifthMidi = rootMidi + 7
      for (let e = 0; e < beatsPerBar * 2; e++) {
        const t = barT + (e * spb) / 2
        const midi = e % 4 === 2 ? fifthMidi : rootMidi
        playTone(t, midiToFreq(midi), { type: 'sawtooth', gain: 0.4, a: 0.004, d: spb * 0.42, lp: 520 })
      }
    }

    if (kind === 'keys') {
      // quarter-note triad stabs
      for (let b = 0; b < beatsPerBar; b++) {
        const t = barT + b * spb
        chord.forEach((semi, i) => {
          playTone(t, midiToFreq(60 + semi), { type: 'triangle', gain: 0.14, a: 0.01, d: spb * 0.6, detune: i * 4 - 4 })
        })
      }
    }

    if (kind === 'pads') {
      chord.forEach((semi, i) => {
        playTone(barT, midiToFreq(60 + semi), {
          type: 'sawtooth', gain: 0.09, a: spb * 0.8, d: beatsPerBar * spb * 0.9, lp: 1200, detune: i * 6 - 6,
        })
      })
    }

    if (kind === 'lead') {
      const penta = [0, 2, 4, 7, 9]
      for (let e = 0; e < beatsPerBar * 2; e++) {
        if (e % 4 === 3) continue // breathing room
        const t = barT + (e * spb) / 2
        const step = penta[(bar * 7 + e * 3) % penta.length]
        playTone(t, midiToFreq(72 + rootSemi + step), { type: 'square', gain: 0.11, a: 0.008, d: spb * 0.4, lp: 2400 })
      }
    }

    if (kind === 'perc') {
      for (let s = 0; s < beatsPerBar * 4; s++) {
        const t = barT + (s * spb) / 4
        playNoise(t, { hp: 6000, gain: s % 4 === 0 ? 0.14 : 0.06, decay: 0.03 })
      }
    }
  }

  return off.startRendering()
}

/**
 * Render buffers for a set of demo stems.
 * @param stems  array of { id, name }
 * @param song   { key: "C major", bpm, sig: "4/4" }
 * @returns Map of stem id -> AudioBuffer
 */
export async function synthDemoStems(stems, song) {
  const { rootSemi, scale } = parseKey(song.key)
  const beatsPerBar = parseInt(String(song.sig || '4/4').split('/')[0], 10) || 4
  const bpm = Number(song.bpm) || 100
  const buffers = new Map()
  for (const s of stems) {
    buffers.set(
      s.id,
      await renderDemoStem(kindForName(s.name), { rootSemi, scale, bpm, beatsPerBar })
    )
  }
  return buffers
}

/** Decode an uploaded audio file (fetched as ArrayBuffer) into an AudioBuffer. */
export async function decodeAudio(arrayBuffer) {
  const ctx = getCtx()
  return ctx.decodeAudioData(arrayBuffer.slice(0))
}

/* ------------------------------------------------------------------ */
/* Mixer                                                               */
/* ------------------------------------------------------------------ */

export class Mixer {
  constructor() {
    this.ctx = getCtx()
    this.master = this.ctx.createGain()
    this.masterAnalyser = this.ctx.createAnalyser()
    this.masterAnalyser.fftSize = 1024
    this.master.connect(this.masterAnalyser)
    this.masterAnalyser.connect(this.ctx.destination)

    this.tracks = [] // { id, name, buffer, gainNode, analyser, gain, muted, solo }
    this._sources = []
    this.playing = false
    this.offset = 0 // transport position when stopped / at last (re)start
    this.startCtxTime = 0
    this.duration = 0
    this.loop = true
    this.onPassComplete = null // fired every time the transport reaches the end

    // metronome
    this.metroOn = false
    this.bpm = 100
    this.beatsPerBar = 4
    this._nextBeatIdx = 0
    this._metroGain = this.ctx.createGain()
    this._metroGain.gain.value = 0.5
    this._metroGain.connect(this.master)

    this._timeData = new Float32Array(1024)
  }

  setTracks(defs) {
    this.stop()
    this.tracks.forEach((t) => {
      try { t.gainNode.disconnect(); t.analyser.disconnect() } catch { /* noop */ }
    })
    this.tracks = defs.map((d) => {
      const gainNode = this.ctx.createGain()
      const analyser = this.ctx.createAnalyser()
      analyser.fftSize = 1024
      gainNode.connect(analyser)
      analyser.connect(this.master)
      return {
        id: d.id,
        name: d.name,
        buffer: d.buffer,
        gainNode,
        analyser,
        gain: d.gain ?? 1,
        muted: false,
        solo: false,
      }
    })
    this.duration = this.tracks.reduce((m, t) => Math.max(m, t.buffer.duration), 0)
    this.offset = 0
    this._applyMix(true)
  }

  setTempo(bpm, beatsPerBar) {
    this.bpm = bpm
    this.beatsPerBar = beatsPerBar
  }

  _effectiveGain(t) {
    const anySolo = this.tracks.some((x) => x.solo)
    if (t.muted) return 0
    if (anySolo && !t.solo) return 0
    return t.gain
  }

  _applyMix(immediate = false) {
    const now = this.ctx.currentTime
    this.tracks.forEach((t) => {
      const v = this._effectiveGain(t)
      if (immediate) t.gainNode.gain.setValueAtTime(v, now)
      else t.gainNode.gain.setTargetAtTime(v, now, 0.012)
    })
  }

  setTrackGain(id, v) {
    const t = this.tracks.find((x) => x.id === id)
    if (!t) return
    t.gain = v
    this._applyMix()
  }
  toggleMute(id) {
    const t = this.tracks.find((x) => x.id === id)
    if (!t) return
    t.muted = !t.muted
    this._applyMix()
    return t.muted
  }
  toggleSolo(id) {
    const t = this.tracks.find((x) => x.id === id)
    if (!t) return
    t.solo = !t.solo
    this._applyMix()
    return t.solo
  }
  setMasterGain(v) {
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.012)
  }

  get position() {
    if (!this.playing) return this.offset
    return Math.min(this.offset + (this.ctx.currentTime - this.startCtxTime), this.duration)
  }

  async play() {
    if (this.playing || this.tracks.length === 0) return
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    const t0 = this.ctx.currentTime + 0.08 // small lead so every stem starts sample-synced
    this._sources = []
    this.tracks.forEach((t) => {
      if (this.offset >= t.buffer.duration) return // shorter stem already finished
      const src = this.ctx.createBufferSource()
      src.buffer = t.buffer
      src.connect(t.gainNode)
      src.start(t0, this.offset)
      this._sources.push(src)
    })
    this.startCtxTime = t0
    this.playing = true
    const spb = 60 / this.bpm
    this._nextBeatIdx = Math.ceil(this.offset / spb - 1e-6)
  }

  _stopSources() {
    this._sources.forEach((s) => { try { s.stop() } catch { /* already stopped */ } })
    this._sources = []
  }

  pause() {
    if (!this.playing) return
    this.offset = this.position
    this._stopSources()
    this.playing = false
  }

  stop() {
    this._stopSources()
    this.playing = false
    this.offset = 0
  }

  seek(t) {
    const wasPlaying = this.playing
    if (this.playing) {
      this._stopSources()
      this.playing = false
    }
    this.offset = Math.max(0, Math.min(t, this.duration))
    if (wasPlaying) this.play()
  }

  _click(ctxTime, accent) {
    const osc = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    osc.type = 'square'
    osc.frequency.value = accent ? 1568 : 1046
    osc.connect(g)
    g.connect(this._metroGain)
    g.gain.setValueAtTime(0.0001, ctxTime)
    g.gain.linearRampToValueAtTime(accent ? 0.5 : 0.28, ctxTime + 0.001)
    g.gain.exponentialRampToValueAtTime(0.0001, ctxTime + 0.045)
    osc.start(ctxTime)
    osc.stop(ctxTime + 0.06)
  }

  /**
   * Drive from requestAnimationFrame. Handles loop/pass detection and
   * metronome lookahead scheduling. Returns current transport position.
   */
  update() {
    if (!this.playing) return this.position
    const pos = this.position

    if (this.metroOn) {
      const spb = 60 / this.bpm
      const lookahead = 0.18
      while (this._nextBeatIdx * spb < pos + lookahead) {
        const beatTransportT = this._nextBeatIdx * spb
        if (beatTransportT >= this.duration) break
        const ctxT = this.startCtxTime + (beatTransportT - this.offset)
        if (ctxT >= this.ctx.currentTime - 0.02) {
          this._click(Math.max(ctxT, this.ctx.currentTime + 0.001), this._nextBeatIdx % this.beatsPerBar === 0)
        }
        this._nextBeatIdx++
      }
    }

    if (pos >= this.duration - 0.03) {
      if (this.onPassComplete) this.onPassComplete()
      if (this.loop) {
        this._stopSources()
        this.playing = false
        this.offset = 0
        this.play()
      } else {
        this.stop()
      }
    }
    return pos
  }

  /** RMS level 0..1 for one track's analyser (VU ballistics left to the UI). */
  trackLevel(id) {
    const t = this.tracks.find((x) => x.id === id)
    if (!t) return 0
    return this._rms(t.analyser)
  }
  masterLevel() {
    return this._rms(this.masterAnalyser)
  }
  _rms(analyser) {
    analyser.getFloatTimeDomainData(this._timeData)
    let sum = 0
    for (let i = 0; i < this._timeData.length; i++) sum += this._timeData[i] * this._timeData[i]
    const rms = Math.sqrt(sum / this._timeData.length)
    // map to a nice meter curve (~ -48dB floor)
    const db = 20 * Math.log10(rms + 1e-8)
    return Math.max(0, Math.min(1, (db + 48) / 48))
  }

  dispose() {
    this.stop()
    this.tracks.forEach((t) => {
      try { t.gainNode.disconnect(); t.analyser.disconnect() } catch { /* noop */ }
    })
    this.tracks = []
    try { this._metroGain.disconnect(); this.master.disconnect(); this.masterAnalyser.disconnect() } catch { /* noop */ }
  }
}

/** mm:ss.d timecode */
export function formatTime(sec) {
  if (!isFinite(sec)) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const d = Math.floor((sec % 1) * 10)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${d}`
}
