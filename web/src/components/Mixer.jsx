import { useEffect, useMemo, useRef, useState } from 'react'
import { stemUrl } from '../api.js'

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

const STEM_COLORS = {
  guitar: '#ff9f43',
  vocals: '#54a0ff',
  drums: '#c56cf0',
  bass: '#2ed573',
  piano: '#1e90ff',
  other: '#8b93a5',
  no_guitar: '#54a0ff',
}

// ~100 buckets/second (capped) so zoomed-in views stay detailed
function peakCount(duration) {
  return Math.min(60000, Math.max(2000, Math.round(duration * 100)))
}

function computePeaks(audioBuffer, buckets) {
  const ch0 = audioBuffer.getChannelData(0)
  const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : ch0
  const step = Math.floor(ch0.length / buckets) || 1
  const peaks = new Float32Array(buckets)
  for (let i = 0; i < buckets; i++) {
    let max = 0
    const start = i * step
    for (let j = 0; j < step; j += 4) { // sample every 4th frame: plenty for display
      const v = Math.abs(ch0[start + j] + ch1[start + j]) / 2
      if (v > max) max = v
    }
    peaks[i] = max
  }
  return peaks
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi))

// ---- practice-track editing: sample-accurate ops on decoded AudioBuffers ----
// Ops are stored with times in the timeline they were made against, so
// replaying the list from the original buffer reproduces every state exactly
// and undo is just "drop the last op and replay".
function applyOp(ctx, buf, op) {
  const sr = buf.sampleRate
  const fr = (t) => Math.round(clamp(t, 0, buf.duration) * sr)
  const nCh = buf.numberOfChannels
  const build = (len, fill) => {
    const out = ctx.createBuffer(nCh, Math.max(len, 1), sr)
    for (let c = 0; c < nCh; c++) fill(out.getChannelData(c), c)
    return out
  }
  if (op.kind === 'silence' || op.kind === 'fade') {
    const a = fr(op.start), b = fr(op.end)
    return build(buf.length, (data, c) => {
      data.set(buf.getChannelData(c))
      if (op.kind === 'silence') data.fill(0, a, b)
      else for (let i = a; i < b; i++) {
        const t = (i - a) / Math.max(b - a, 1)
        data[i] *= op.dir === 'in' ? t : 1 - t
      }
    })
  }
  if (op.kind === 'insert') {
    const at = fr(op.at)
    const insLen = op.channels[0].length
    return build(buf.length + insLen, (data, c) => {
      const ins = op.channels[Math.min(c, op.channels.length - 1)]
      data.set(buf.getChannelData(c).subarray(0, at), 0)
      data.set(ins, at)
      data.set(buf.getChannelData(c).subarray(at), at + ins.length)
    })
  }
  // trim keeps the section; delete removes it
  const a = fr(op.start), b = fr(op.end)
  const keep = op.kind === 'trim' ? [[a, b]] : [[0, a], [b, buf.length]]
  const len = keep.reduce((n, [x, y]) => n + (y - x), 0)
  return build(len, (data, c) => {
    let off = 0
    for (const [x, y] of keep) {
      data.set(buf.getChannelData(c).subarray(x, y), off)
      off += y - x
    }
  })
}

const foldBuffer = (ctx, original, ops) => ops.reduce((buf, op) => applyOp(ctx, buf, op), original)

// copy a time range out of a buffer as plain Float32Arrays (clipboard / riff repeat)
const copyChannels = (buf, start, end) => {
  const sr = buf.sampleRate
  const a = Math.round(clamp(start, 0, buf.duration) * sr)
  const b = Math.round(clamp(end, 0, buf.duration) * sr)
  return Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c).slice(a, b))
}

const repeatArray = (arr, n) => {
  const out = new Float32Array(arr.length * n)
  for (let i = 0; i < n; i++) out.set(arr, i * arr.length)
  return out
}

// minimal PCM16 WAV encoder — lets edited buffers become blob URLs the
// existing <audio> elements and waveform peaks can consume unchanged
function bufferToWav(buf) {
  const nCh = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate
  const bytes = 44 + len * nCh * 2
  const ab = new ArrayBuffer(bytes)
  const dv = new DataView(ab)
  const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); str(8, 'WAVE'); str(12, 'fmt ')
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, nCh, true)
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * nCh * 2, true)
  dv.setUint16(32, nCh * 2, true); dv.setUint16(34, 16, true)
  str(36, 'data'); dv.setUint32(40, len * nCh * 2, true)
  const chans = Array.from({ length: nCh }, (_, c) => buf.getChannelData(c))
  let off = 44
  for (let i = 0; i < len; i++) for (let c = 0; c < nCh; c++) {
    const v = Math.max(-1, Math.min(1, chans[c][i]))
    dv.setInt16(off, v < 0 ? v * 32768 : v * 32767, true)
    off += 2
  }
  return new Blob([ab], { type: 'audio/wav' })
}

// Static canvas waveform (drawn for the current zoom view) + moving cursor +
// draggable loop region. Pointer interactions:
//   drag on empty waveform -> create region
//   drag region body       -> move region
//   drag near region edge  -> resize
//   plain click            -> seek (clears an active region when outside it)
//   double click           -> clear region
//   wheel                  -> zoom around cursor (all stems share the view)
function Waveform({ url, ctx, color, position, duration, view, region, onRegionChange, onSeek, onZoom }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const [peaks, setPeaks] = useState(null) // null = loading, [] = failed
  const [size, setSize] = useState({ w: 0, h: 0 }) // CSS drives lane height
  const dragRef = useRef(null) // {mode, x0, t0, orig, moved}

  const viewStart = view.start
  const viewLen = view.len || duration

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await (await fetch(url)).arrayBuffer()
        const buf = await ctx.decodeAudioData(data)
        if (!cancelled) setPeaks(computePeaks(buf, peakCount(buf.duration)))
      } catch {
        if (!cancelled) setPeaks([])
      }
    })()
    return () => { cancelled = true }
  }, [url, ctx])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // non-passive wheel listener so the page doesn't scroll while zooming
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      if (duration) onZoom(e.deltaY < 0 ? 1.4 : 1 / 1.4, timeAt(e.clientX))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, viewStart, viewLen])

  // draw only the visible slice of the high-res peaks
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !size.w || !peaks || !viewLen) return
    const dpr = window.devicePixelRatio || 1
    const h = size.h || 64
    canvas.width = size.w * dpr
    canvas.height = h * dpr
    canvas.style.height = `${h}px`
    const g = canvas.getContext('2d')
    g.scale(dpr, dpr)
    g.clearRect(0, 0, size.w, h)
    const n = peaks.length
    const b0 = clamp(Math.floor((viewStart / duration) * n), 0, n - 1)
    const b1 = clamp(Math.ceil(((viewStart + viewLen) / duration) * n), b0 + 1, n)
    const visible = b1 - b0
    const barW = size.w / visible
    g.fillStyle = color
    for (let i = 0; i < visible; i++) {
      const amp = peaks[b0 + i] ? Math.max(peaks[b0 + i], 0.008) : 0.004
      const barH = amp * (h - 4)
      g.fillRect(i * barW, (h - barH) / 2, Math.max(barW - 0.5, 0.5), barH)
    }
  }, [peaks, size.w, size.h, color, viewStart, viewLen, duration])

  const timeAt = (clientX) => {
    const rect = wrapRef.current.getBoundingClientRect()
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1)
    return clamp(viewStart + ratio * viewLen, 0, duration)
  }
  // position of a time value inside the current view, as a percentage string
  const pctAt = (t) => `${clamp((t - viewStart) / viewLen, 0, 1) * 100}%`
  const minLen = () => Math.max(0.25, duration * 0.01)

  const onPointerDown = (e) => {
    if (!duration || e.button !== 0) return
    const t = timeAt(e.clientX)
    const rect = wrapRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    let mode = 'create'
    if (region) {
      const startPx = ((region.start - viewStart) / viewLen) * rect.width
      const endPx = ((region.end - viewStart) / viewLen) * rect.width
      if (Math.abs(x - startPx) <= 6) mode = 'start'
      else if (Math.abs(x - endPx) <= 6) mode = 'end'
      else if (t >= region.start && t <= region.end) mode = 'move'
    }
    dragRef.current = { mode, x0: e.clientX, t0: t, orig: region, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e) => {
    const d = dragRef.current
    if (!d || !duration) return
    if (Math.abs(e.clientX - d.x0) > 4) d.moved = true
    if (!d.moved) return
    const t = timeAt(e.clientX)
    if (d.mode === 'create') {
      onRegionChange({ start: Math.min(d.t0, t), end: Math.max(d.t0, t) })
    } else if (d.mode === 'start') {
      onRegionChange({ ...d.orig, start: Math.min(t, d.orig.end - minLen()) })
    } else if (d.mode === 'end') {
      onRegionChange({ ...d.orig, end: Math.max(t, d.orig.start + minLen()) })
    } else { // move
      const len = d.orig.end - d.orig.start
      const s = clamp(t - len / 2, 0, duration - len)
      onRegionChange({ start: s, end: s + len })
    }
  }

  const onPointerUp = (e) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d || d.moved) return
    const t = timeAt(e.clientX)
    // plain click seeks; clicking outside the active region also clears it —
    // otherwise the rAF tick would yank playback straight back into the loop
    if (region && (t < region.start || t > region.end)) onRegionChange(null)
    onSeek(t)
  }

  const cursorPct = duration ? clamp((position - viewStart) / viewLen, 0, 1) * 100 : 0

  return (
    <div
      ref={wrapRef}
      className="waveform"
      title="click: seek · click outside region or double-click: clear loop · drag: loop region · wheel: zoom"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={() => onRegionChange(null)}
    >
      {peaks === null && <span className="muted small wf-loading">analyzing…</span>}
      {peaks && peaks.length === 0 && <span className="muted small wf-loading">waveform unavailable</span>}
      <canvas ref={canvasRef} />
      {region && duration > 0 && (
        <>
          <div className="wf-dim" style={{ left: 0, width: pctAt(region.start) }} />
          <div className="wf-dim" style={{ left: pctAt(region.end), right: 0 }} />
          <div className="wf-region" style={{ left: pctAt(region.start), width: `${clamp((region.end - region.start) / viewLen, 0, 1) * 100}%` }} />
          <div className="wf-handle" style={{ left: pctAt(region.start) }} />
          <div className="wf-handle" style={{ left: pctAt(region.end) }} />
        </>
      )}
      <div className="wf-cursor" style={{ left: `${cursorPct}%` }} />
    </div>
  )
}

// The timeline in the practice bar: click/drag to seek, shows the played
// portion, the loop span, and the playhead. Seeking outside the active loop
// region clears it — same rule as clicking a waveform.
function ScrubBar({ duration, position, region, onSeek, onRegionChange }) {
  const ref = useRef(null)
  const draggingRef = useRef(false)
  const timeAt = (clientX) => {
    const r = ref.current.getBoundingClientRect()
    return clamp((clientX - r.left) / r.width, 0, 1) * duration
  }
  const seekTo = (t) => {
    if (region && (t < region.start || t > region.end)) onRegionChange(null)
    onSeek(t)
  }
  const pct = (t) => `${clamp(t / (duration || 1), 0, 1) * 100}%`
  return (
    <div
      ref={ref}
      className="scrub"
      title="click or drag to seek · ←/→ nudge 5s"
      tabIndex={0}
      onPointerDown={(e) => {
        if (!duration || e.button !== 0) return
        draggingRef.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        seekTo(timeAt(e.clientX))
      }}
      onPointerMove={(e) => { if (draggingRef.current) seekTo(timeAt(e.clientX)) }}
      onPointerUp={() => { draggingRef.current = false }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        seekTo(clamp(position + (e.key === 'ArrowRight' ? 5 : -5), 0, duration))
      }}
    >
      {region && (
        <div className="scrub-region" style={{ left: pct(region.start), width: pct(region.end - region.start) }} />
      )}
      <div className="scrub-played" style={{ width: pct(position) }} />
      <div className="scrub-knob" style={{ left: pct(position) }} />
    </div>
  )
}

export default function Mixer({ jobId, stems }) {
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState(1)
  const [loopRegion, setLoopRegion] = useState(null) // {start, end} seconds
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [view, setView] = useState({ start: 0, len: 0 }) // len 0 until duration known
  const [volumes, setVolumes] = useState(() =>
    Object.fromEntries(stems.map((s) => [s.name, s.name === 'guitar' ? 1 : 0.35])))
  const [muted, setMuted] = useState(() => Object.fromEntries(stems.map((s) => [s.name, false])))
  const [solo, setSolo] = useState(null)
  // the stem the practice session is about: gets the expanded lane and is the
  // target of the practice bar's solo toggle
  const [selected, setSelected] = useState(() =>
    stems.some((s) => s.name === 'guitar') ? 'guitar' : stems[0].name)
  // practice-track editing session on the selected stem
  const [editing, setEditing] = useState(false)
  const [editReady, setEditReady] = useState(false) // original buffer decoded
  const [editOps, setEditOps] = useState([]) // applied ops (replayed from original)
  const [redoOps, setRedoOps] = useState([])
  const [editedUrl, setEditedUrl] = useState(null) // blob URL of the current render
  const [clipboard, setClipboard] = useState(null) // {sampleRate, channels}
  const [editOrig, setEditOrig] = useState(null) // decoded original AudioBuffer
  const editedUrlRef = useRef(null)
  const editTokenRef = useRef(0) // guards the async decode on enter/exit

  const audioCtxRef = useRef(null)
  if (!audioCtxRef.current) audioCtxRef.current = new AudioContext()
  const gainNodesRef = useRef({})
  const elsRef = useRef([]) // audio elements, stems order; index 0 is the leader
  const rafRef = useRef(0)

  // refs mirror state for the long-lived rAF loop without restarting it
  const regionRef = useRef(loopRegion)
  regionRef.current = loopRegion
  const positionRef = useRef(position)
  positionRef.current = position
  const rateRef = useRef(rate)
  rateRef.current = rate
  const viewRef = useRef(view)
  viewRef.current = view

  const stemsKey = stems.map((s) => s.name).join(',')

  // a region IS the loop: looping is on exactly while a region exists, and
  // setting one jumps the playhead to its start if it sits outside, so
  // playback begins inside the loop
  const changeRegion = (r) => {
    const prev = regionRef.current
    setLoopRegion(r)
    if (r && (!prev || positionRef.current < r.start || positionRef.current > r.end)) {
      elsRef.current.forEach((el) => { el.currentTime = r.start })
      setPosition(r.start)
    }
  }

  const minViewLen = () => Math.max(1, duration / 200)

  // zoom by factor around a time position, keeping the view within the track
  const zoom = (factor, centerTime) => {
    if (!duration) return
    const v = viewRef.current
    const newLen = clamp((v.len || duration) / factor, minViewLen(), duration)
    const center = centerTime ?? (positionRef.current >= v.start && positionRef.current <= v.start + (v.len || duration)
      ? positionRef.current
      : v.start + (v.len || duration) / 2)
    const start = clamp(center - newLen / 2, 0, duration - newLen)
    setView({ start, len: newLen })
  }
  const fitView = () => duration && setView({ start: 0, len: duration })

  const onMetadata = (d) => {
    setDuration(d)
    setView((v) => (v.len ? v : { start: 0, len: d }))
  }

  // Build audio elements + WebAudio graph per session: the full mix normally,
  // or just the selected stem while editing it (practice-track mode keeps the
  // transport, loop and speed machinery driven by the stem being edited)
  const sessionKey = editing ? `${stemsKey}|edit:${selected}` : stemsKey
  useEffect(() => {
    const ctx = audioCtxRef.current
    const stack = editing ? stems.filter((s) => s.name === selected) : stems
    const els = stack.map((s) => {
      const el = new Audio(stemUrl(jobId, s.file))
      el.preload = 'auto'
      el.crossOrigin = 'anonymous'
      el.preservesPitch = true
      el.mozPreservesPitch = true
      el.webkitPreservesPitch = true
      return el
    })
    elsRef.current = els
    els.forEach((el, i) => {
      const src = ctx.createMediaElementSource(el)
      const gain = ctx.createGain()
      src.connect(gain).connect(ctx.destination)
      gainNodesRef.current[stack[i].name] = gain
    })

    const leader = els[0]
    const onMeta = () => onMetadata(leader.duration || 0)
    leader.addEventListener('loadedmetadata', onMeta)

    const seekAll = (t) => els.forEach((el) => { el.currentTime = t })

    // drift correction + region looping + follow-the-playhead when zoomed in:
    // keep followers within 60ms of the leader
    const tick = () => {
      if (!leader.paused) {
        const region = regionRef.current
        if (region && leader.currentTime >= region.end - 0.02) {
          seekAll(region.start)
          setPosition(region.start)
        } else {
          setPosition(leader.currentTime)
        }
        for (let i = 1; i < els.length; i++) {
          if (Math.abs(els[i].currentTime - leader.currentTime) > 0.06 && !els[i].seeking) {
            els[i].currentTime = leader.currentTime
          }
        }
        // auto-scroll when zoomed and the playhead nears the view edge
        const v = viewRef.current
        if (v.len && v.len < duration * 0.999) {
          const end = v.start + v.len
          if (leader.currentTime > end - v.len * 0.1) {
            const start = clamp(leader.currentTime - v.len * 0.1, 0, duration - v.len)
            if (Math.abs(start - v.start) > 0.01) setView({ start, len: v.len })
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    leader.addEventListener('ended', () => setPlaying(false))

    return () => {
      cancelAnimationFrame(rafRef.current)
      els.forEach((el) => { el.pause(); el.src = '' })
      // ctx is shared across stack rebuilds (edit mode toggles it); closing it
      // here would break the next build's MediaElementSource graph
      elsRef.current = []
      gainNodesRef.current = {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, sessionKey])

  // apply per-stem gain (volume, mute, solo) whenever controls change
  useEffect(() => {
    for (const s of stems) {
      const g = gainNodesRef.current[s.name]
      if (!g) continue
      const audible = solo ? s.name === solo : !muted[s.name]
      g.gain.value = audible ? volumes[s.name] : 0
    }
  }, [volumes, muted, solo, stemsKey])

  // apply global rate to all elements (region looping is handled in the rAF tick)
  useEffect(() => {
    for (const el of elsRef.current) {
      el.playbackRate = rate
    }
  }, [rate])

  const togglePlay = async () => {
    const ctx = audioCtxRef.current
    const els = elsRef.current
    if (playing) {
      els.forEach((el) => el.pause())
      setPlaying(false)
    } else {
      if (ctx.state === 'suspended') await ctx.resume()
      // with an active region, start the section over from the top instead of
      // resuming where it was paused; otherwise start from the leader's position
      const t = regionRef.current ? regionRef.current.start : els[0].currentTime
      els[0].currentTime = t
      await els[0].play()
      for (let i = 1; i < els.length; i++) {
        els[i].currentTime = t
        els[i].play().catch(() => {})
      }
      setPosition(t)
      setPlaying(true)
    }
  }

  // space bar toggles play/pause. Controls with native space behavior keep it
  // (the play button itself, form inputs); range sliders have none, so space
  // still works right after touching a volume or speed slider.
  const toggleRef = useRef(togglePlay)
  toggleRef.current = togglePlay
  const editApiRef = useRef(null)
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target
      if (t instanceof Element && t.closest('button, a, select, textarea, input:not([type=range])')) return
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'y')) {
        const api = editApiRef.current
        if (api && api.editing) {
          e.preventDefault()
          if (e.key === 'z' && !e.shiftKey) api.undo()
          else api.redo()
        }
        return
      }
      if (e.code !== 'Space' || e.repeat) return
      e.preventDefault()
      toggleRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const seek = (t) => {
    const clamped = Math.max(0, Math.min(t, duration || t))
    elsRef.current.forEach((el) => { el.currentTime = clamped })
    setPosition(clamped)
  }

  // momentary controls yield focus after click so space reliably means play/pause
  const act = (fn) => (e) => { e.currentTarget.blur(); fn(e) }

  // ---- practice-track editing session ----
  // Edits preview entirely client-side: ops are folded over the decoded
  // original into a new AudioBuffer, encoded to a WAV blob and swapped into
  // the stem's <audio> element + waveform. Exiting edit restores the mix.
  const editingRef = useRef(false)
  editingRef.current = editing

  const renderedBuffer = useMemo(() => {
    if (!editing || !editOrig) return null
    return editOps.length ? foldBuffer(audioCtxRef.current, editOrig, editOps) : editOrig
  }, [editing, editOrig, editOps])

  useEffect(() => {
    if (!editing || !renderedBuffer) return
    const el = elsRef.current[0] // edit-mode stack: the edited stem is the leader
    // swapping src auto-pauses the element and resets playbackRate; make both
    // explicit so the transport state never lies about what's audible
    const load = (src) => {
      if (!el) return
      el.pause()
      el.src = src
      el.playbackRate = rateRef.current
    }
    const resync = (d) => {
      setPlaying(false)
      setDuration(d)
      setView({ start: 0, len: d })
      if (positionRef.current > d) seek(0)
      if (regionRef.current && regionRef.current.end > d + 0.01) setLoopRegion(null)
    }
    if (!editOps.length) {
      // back to the original: drop the blob and restore the source file
      if (editedUrlRef.current) {
        URL.revokeObjectURL(editedUrlRef.current)
        editedUrlRef.current = null
        setEditedUrl(null)
      }
      load(stemUrl(jobId, selStem().file))
      resync(renderedBuffer.duration)
      return
    }
    const url = URL.createObjectURL(bufferToWav(renderedBuffer))
    if (editedUrlRef.current) URL.revokeObjectURL(editedUrlRef.current)
    editedUrlRef.current = url
    setEditedUrl(url)
    load(url) // loadedmetadata refreshes duration for the transport
    resync(renderedBuffer.duration)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderedBuffer, editOps.length])

  useEffect(() => () => {
    if (editedUrlRef.current) URL.revokeObjectURL(editedUrlRef.current)
  }, [])

  const enterEdit = async () => {
    const stem = selStem()
    elsRef.current.forEach((el) => el.pause())
    setPlaying(false)
    const token = ++editTokenRef.current
    setEditing(true) // rebuilds the stack to the single edited stem
    setEditReady(false)
    setEditOps([])
    setRedoOps([])
    setClipboard(null)
    try {
      const res = await fetch(stemUrl(jobId, stem.file))
      const buf = await audioCtxRef.current.decodeAudioData(await res.arrayBuffer())
      if (editTokenRef.current !== token || !editingRef.current) return
      setEditOrig(buf)
      setEditReady(true)
    } catch {
      if (editTokenRef.current === token) setEditing(false)
    }
  }

  const exitEdit = () => {
    editTokenRef.current++
    elsRef.current.forEach((el) => el.pause())
    setPlaying(false) // stack cleanup pauses audio; keep the button honest too
    if (editedUrlRef.current) {
      URL.revokeObjectURL(editedUrlRef.current)
      editedUrlRef.current = null
    }
    setEditedUrl(null)
    setEditOps([])
    setRedoOps([])
    setClipboard(null)
    setEditReady(false)
    setEditOrig(null)
    setEditing(false) // rebuilds the full-mix stack from the original files
  }

  const pushOp = (op) => {
    setEditOps((o) => [...o, op])
    setRedoOps([])
  }

  const applyRegionOp = (kind, extra = {}) => {
    if (!loopRegion) return
    pushOp({ kind, start: loopRegion.start, end: loopRegion.end, ...extra })
    // the section was consumed; a fresh selection is needed for the next op
    if (kind === 'trim' || kind === 'delete') setLoopRegion(null)
  }

  const doCopy = () => {
    if (!loopRegion || !renderedBuffer) return
    setClipboard({
      sampleRate: renderedBuffer.sampleRate,
      channels: copyChannels(renderedBuffer, loopRegion.start, loopRegion.end),
    })
  }

  const doPaste = () => {
    if (!clipboard || !renderedBuffer) return
    if (clipboard.sampleRate !== renderedBuffer.sampleRate) return
    pushOp({ kind: 'insert', at: position, channels: clipboard.channels })
  }

  const repeatRiff = (times) => {
    if (!loopRegion || !renderedBuffer) return
    const chans = copyChannels(renderedBuffer, loopRegion.start, loopRegion.end)
    pushOp({
      kind: 'insert',
      at: loopRegion.end,
      channels: chans.map((c) => repeatArray(c, times - 1)),
    })
  }

  const undo = () => {
    if (!editOps.length) return
    setRedoOps((r) => [...r, editOps[editOps.length - 1]])
    setEditOps(editOps.slice(0, -1))
  }
  const redo = () => {
    if (!redoOps.length) return
    setEditOps((o) => [...o, redoOps[redoOps.length - 1]])
    setRedoOps(redoOps.slice(0, -1))
  }
  const revertEdits = () => {
    setEditOps([])
    setRedoOps([])
  }

  editApiRef.current = { editing, undo, redo }

  const zoomed = view.len > 0 && view.len < duration * 0.999

  const selStem = () => stems.find((s) => s.name === selected) || stems[0]
  const sel = selStem()
  const others = stems.filter((s) => s.name !== sel.name)
  const waveProps = (s) => ({
    url: editing && s.name === sel.name && editedUrl ? editedUrl : stemUrl(jobId, s.file),
    ctx: audioCtxRef.current,
    color: STEM_COLORS[s.name] || '#8b93a5',
    position,
    duration,
    view,
    region: loopRegion,
    onRegionChange: changeRegion,
    onSeek: seek,
    onZoom: zoom,
  })

  return (
    <div className={`mixer${editing ? ' editing' : ''}`}>
      {/* primary practice bar — the one row that drives the session */}
      <div className="practice">
        <button className="primary play" title="space" onClick={togglePlay}>{playing ? '⏸ pause' : '▶ play'}</button>
        <span className="clock"><span className="now">{fmtTime(position)}</span> / {fmtTime(duration)}</span>
        <ScrubBar duration={duration} position={position} region={loopRegion}
          onSeek={seek} onRegionChange={changeRegion} />
        {loopRegion ? (
          <div className="chip loop on" title="click to jump to the loop start" onClick={() => seek(loopRegion.start)}>
            loop {fmtTime(loopRegion.start)}–{fmtTime(loopRegion.end)}
            <span className="x" role="button" title="clear loop"
              onClick={(e) => { e.stopPropagation(); changeRegion(null) }}>✕</span>
          </div>
        ) : (
          <span className="chip loop off" title="drag across a waveform to loop a section">no loop</span>
        )}
        <div className="ctrl speed" title={`playback speed ${(rate * 100).toFixed(0)}%`}>
          <input type="range" min={0.5} max={1.25} step={0.05} value={rate}
            onChange={(e) => setRate(Number(e.target.value))} />
          <div className="presets">
            {[0.5, 0.6, 0.7, 0.8, 0.9, 1].map((v) => (
              <button key={v} className={`mini rate${Math.abs(rate - v) < 0.001 ? ' active' : ''}`}
                onClick={act(() => setRate(v))}>{Math.round(v * 100)}%</button>
            ))}
          </div>
        </div>
        <button className={`chip solo-toggle${solo === sel.name ? ' on' : ''}`}
          onClick={act(() => setSolo((cur) => (cur === sel.name ? null : sel.name)))}>
          solo {sel.name}
        </button>
        <div className="zoomctl">
          <button className="mini" title="zoom out" onClick={act(() => zoom(1 / 2))}>−</button>
          <button className="mini" title="fit whole song" onClick={act(fitView)}
            disabled={!zoomed}>{zoomed ? `${(duration / view.len).toFixed(0)}x` : 'fit'}</button>
          <button className="mini" title="zoom in" onClick={act(() => zoom(2))}>+</button>
        </div>
      </div>

      {/* practice status strip — session state at a glance */}
      <div className="status">
        <span>Practicing <strong>{sel.name}</strong></span>
        <span className="sep">·</span>
        <span className={solo ? 'hi' : undefined}>{solo ? 'solo on' : 'full mix'}</span>
        <span className="sep">·</span>
        <span>{Math.round(rate * 100)}% speed</span>
        <span className="sep">·</span>
        <span className={loopRegion ? 'hi' : undefined}>
          {loopRegion ? `loop ${fmtTime(loopRegion.start)}–${fmtTime(loopRegion.end)}` : 'no loop'}
        </span>
        <span className="spacer" />
        <span className="small">space = play/pause</span>
      </div>

      {/* edit toolbar — practice-track manipulation of the selected stem */}
      {editing && (
        <div className="editbar">
          {!editReady ? (
            <span className="muted small">decoding {sel.name}…</span>
          ) : (
            <>
              <span className="eb-label">
                {sel.name}
                <span className="muted"> · {editOps.length ? `${editOps.length} change${editOps.length > 1 ? 's' : ''}` : 'no changes yet'}</span>
              </span>
              <div className="eb-group">
                <button className="eb" disabled={!loopRegion} title="keep only the selected section"
                  onClick={act(() => applyRegionOp('trim'))}>trim</button>
                <button className="eb" disabled={!loopRegion} title="remove the selected section"
                  onClick={act(() => applyRegionOp('delete'))}>delete</button>
                <button className="eb" disabled={!loopRegion} title="silence the selected section"
                  onClick={act(() => applyRegionOp('silence'))}>silence</button>
                <button className="eb" disabled={!loopRegion} title="ramp the section up from silence"
                  onClick={act(() => applyRegionOp('fade', { dir: 'in' }))}>fade in</button>
                <button className="eb" disabled={!loopRegion} title="ramp the section down to silence"
                  onClick={act(() => applyRegionOp('fade', { dir: 'out' }))}>fade out</button>
              </div>
              <div className="eb-group">
                <button className="eb" disabled={!loopRegion} title="copy the selected section"
                  onClick={act(doCopy)}>copy</button>
                <button className="eb" disabled={!clipboard} title="paste the copied audio at the playhead"
                  onClick={act(doPaste)}>paste</button>
                <button className="eb" disabled={!loopRegion} title="repeat the section back-to-back — 2 plays"
                  onClick={act(() => repeatRiff(2))}>riff ×2</button>
                <button className="eb" disabled={!loopRegion} title="repeat the section back-to-back — 4 plays"
                  onClick={act(() => repeatRiff(4))}>riff ×4</button>
              </div>
              <div className="eb-group">
                <button className="eb" disabled={!editOps.length} title="ctrl+z"
                  onClick={act(undo)}>undo</button>
                <button className="eb" disabled={!redoOps.length} title="ctrl+shift+z"
                  onClick={act(redo)}>redo</button>
                <button className="eb" disabled={!editOps.length} title="discard all edits"
                  onClick={act(revertEdits)}>revert</button>
              </div>
              <span className="spacer" />
              {editedUrl ? (
                <a className="eb dl" href={editedUrl} download={`${sel.name}-practice.wav`}
                  title="download the edited stem (WAV)">download</a>
              ) : (
                <span className="eb off" title="available after your first edit">download</span>
              )}
              {!loopRegion && <span className="muted small">drag the waveform to select a section</span>}
            </>
          )}
        </div>
      )}

      {/* selected stem: expanded lane with full controls + guidance */}
      <div className="lanes">
        <div className={`lane selected${muted[sel.name] ? ' is-muted' : ''}`}>
          <div className="lane-head">
            <span className="lane-name">
              <span className="swatch" style={{ background: STEM_COLORS[sel.name] || '#8b93a5' }} />
              {sel.name}
            </span>
            <div className="lane-tools">
              <input className="vol" type="range" min={0} max={1} step={0.01} value={volumes[sel.name]}
                title={`${sel.name} volume`}
                onChange={(e) => setVolumes((v) => ({ ...v, [sel.name]: Number(e.target.value) }))} />
              <button className={`tool${solo === sel.name ? ' on' : ''}`}
                onClick={act(() => setSolo((cur) => (cur === sel.name ? null : sel.name)))}>solo</button>
              <button className={`tool warn${muted[sel.name] ? ' on' : ''}`}
                onClick={act(() => setMuted((m) => ({ ...m, [sel.name]: !m[sel.name] })))}>mute</button>
              <button className={`tool edit${editing ? ' on' : ''}`}
                onClick={act(editing ? exitEdit : enterEdit)}
                title={editing ? 'leave edit mode and restore the full mix' : 'edit this stem: trim, delete, repeat, copy sections…'}>
                {editing ? 'done' : 'edit'}
              </button>
              <a className="tool dl" href={stemUrl(jobId, sel.file)} download>download</a>
            </div>
          </div>
          <Waveform {...waveProps(sel)} />
          <p className="lane-hint muted small">
            {editing
              ? 'drag to select a section, then trim / delete / repeat it · edits preview instantly · done restores the full mix'
              : 'click to move the playhead · drag across to loop a section · click outside the loop (or its ✕) to clear · wheel to zoom'}
          </p>
        </div>

        {/* secondary stems: compact lanes, click the name to focus */}
        {others.map((s) => (
          <div key={s.name} className={`lane compact${muted[s.name] ? ' is-muted' : ''}${solo === s.name ? ' is-solo' : ''}`}>
            <div className="lane-head">
              <button className="lane-name" title={editing ? 'exit edit mode first' : 'click to focus this stem'}
                onClick={act(() => { if (!editing) setSelected(s.name) })}>
                <span className="swatch" style={{ background: STEM_COLORS[s.name] || '#8b93a5' }} />
                {s.name}
              </button>
              {solo === s.name && <span className="state">solo</span>}
              {muted[s.name] && <span className="state warn">muted</span>}
              <span className="spacer" />
              <input className="vol" type="range" min={0} max={1} step={0.01} value={volumes[s.name]}
                title={`${s.name} volume`}
                onChange={(e) => setVolumes((v) => ({ ...v, [s.name]: Number(e.target.value) }))} />
              <button className={`tool sm${solo === s.name ? ' on' : ''}`}
                title={`solo ${s.name}`}
                onClick={act(() => setSolo((cur) => (cur === s.name ? null : s.name)))}>solo</button>
              <button className={`tool sm warn${muted[s.name] ? ' on' : ''}`}
                title={`mute ${s.name}`}
                onClick={act(() => setMuted((m) => ({ ...m, [s.name]: !m[s.name] })))}>mute</button>
              <a className="tool sm dl" title={`download ${s.name} stem`} href={stemUrl(jobId, s.file)} download>⬇</a>
            </div>
            <Waveform {...waveProps(s)} />
          </div>
        ))}
      </div>
    </div>
  )
}
