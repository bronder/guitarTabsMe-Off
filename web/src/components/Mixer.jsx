import { useEffect, useRef, useState } from 'react'
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
  const [width, setWidth] = useState(0)
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
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
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
    if (!canvas || !width || !peaks || !viewLen) return
    const dpr = window.devicePixelRatio || 1
    const h = 64
    canvas.width = width * dpr
    canvas.height = h * dpr
    canvas.style.height = `${h}px`
    const g = canvas.getContext('2d')
    g.scale(dpr, dpr)
    g.clearRect(0, 0, width, h)
    const n = peaks.length
    const b0 = clamp(Math.floor((viewStart / duration) * n), 0, n - 1)
    const b1 = clamp(Math.ceil(((viewStart + viewLen) / duration) * n), b0 + 1, n)
    const visible = b1 - b0
    const barW = width / visible
    g.fillStyle = color
    for (let i = 0; i < visible; i++) {
      const amp = peaks[b0 + i] ? Math.max(peaks[b0 + i], 0.008) : 0.004
      const barH = amp * (h - 4)
      g.fillRect(i * barW, (h - barH) / 2, Math.max(barW - 0.5, 0.5), barH)
    }
  }, [peaks, width, color, viewStart, viewLen, duration])

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

export default function Mixer({ jobId, stems }) {
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState(1)
  const [loop, setLoop] = useState(false)
  const [loopRegion, setLoopRegion] = useState(null) // {start, end} seconds
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [view, setView] = useState({ start: 0, len: 0 }) // len 0 until duration known
  const [volumes, setVolumes] = useState(() =>
    Object.fromEntries(stems.map((s) => [s.name, s.name === 'guitar' ? 1 : 0.35])))
  const [muted, setMuted] = useState(() => Object.fromEntries(stems.map((s) => [s.name, false])))
  const [solo, setSolo] = useState(null)

  const audioCtxRef = useRef(null)
  if (!audioCtxRef.current) audioCtxRef.current = new AudioContext()
  const gainNodesRef = useRef({})
  const elsRef = useRef([]) // audio elements, stems order; index 0 is the leader
  const rafRef = useRef(0)

  // refs mirror state for the long-lived rAF loop without restarting it
  const loopRef = useRef(loop)
  loopRef.current = loop
  const regionRef = useRef(loopRegion)
  regionRef.current = loopRegion
  const positionRef = useRef(position)
  positionRef.current = position
  const viewRef = useRef(view)
  viewRef.current = view

  const stemsKey = stems.map((s) => s.name).join(',')

  // setting a region implies looping it; if the playhead sits outside the
  // region, jump to its start so playback begins inside the loop. Clearing a
  // region (double-click or plain click outside it) exits loop mode entirely.
  const changeRegion = (r) => {
    const prev = regionRef.current
    setLoopRegion(r)
    setLoop(!!r)
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

  // Build audio elements + WebAudio graph once per job
  useEffect(() => {
    const ctx = audioCtxRef.current
    const els = stems.map((s) => {
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
      gainNodesRef.current[stems[i].name] = gain
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
        if (loopRef.current && region && leader.currentTime >= region.end - 0.02) {
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
      ctx.close()
      elsRef.current = []
      gainNodesRef.current = {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, stemsKey])

  // apply per-stem gain (volume, mute, solo) whenever controls change
  useEffect(() => {
    for (const s of stems) {
      const g = gainNodesRef.current[s.name]
      if (!g) continue
      const audible = solo ? s.name === solo : !muted[s.name]
      g.gain.value = audible ? volumes[s.name] : 0
    }
  }, [volumes, muted, solo, stemsKey])

  // apply global rate + loop to all elements (region looping is handled in the rAF tick)
  useEffect(() => {
    for (const el of elsRef.current) {
      el.playbackRate = rate
      el.loop = loop
    }
  }, [rate, loop])

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
  // (the play button itself, the loop checkbox); range sliders have none, so
  // space still works right after touching a volume or speed slider.
  const toggleRef = useRef(togglePlay)
  toggleRef.current = togglePlay
  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'Space' || e.repeat) return
      const t = e.target
      if (t instanceof Element && t.closest('button, a, select, textarea, input:not([type=range])')) return
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

  const zoomed = view.len > 0 && view.len < duration * 0.999

  return (
    <div className="mixer">
      <div className="transport">
        <button className="primary play" title="space" onClick={togglePlay}>{playing ? '⏸ pause' : '▶ play'}</button>
        <span className="time">{fmtTime(position)} / {fmtTime(duration)}</span>
        <input type="range" min={0} max={duration || 0} step={0.1} value={position}
          onChange={(e) => seek(Number(e.target.value))} style={{ flex: 1 }} />

        <div className="zoomctl">
          <button className="mini" title="zoom out" onClick={() => zoom(1 / 2)}>−</button>
          <button className="mini" title="fit whole song" onClick={fitView}
            disabled={!zoomed}>{zoomed ? `${(duration / view.len).toFixed(0)}x` : 'fit'}</button>
          <button className="mini" title="zoom in" onClick={() => zoom(2)}>+</button>
        </div>

        <label className="ctrl">
          speed {rate.toFixed(2)}x
          <input type="range" min={0.5} max={1.25} step={0.05} value={rate}
            onChange={(e) => setRate(Number(e.target.value))} />
        </label>
        <label className="ctrl checkbox">
          <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> loop
        </label>
      </div>

      <div className="channels">
        {stems.map((s) => (
          <div key={s.name} className={`channel ${s.name === 'guitar' ? 'star' : ''}`}>
            <div className="ch-head">
              <strong>{s.name}</strong>
              <input
                className="vol" type="range" min={0} max={1} step={0.01} value={volumes[s.name]}
                onChange={(e) => setVolumes((v) => ({ ...v, [s.name]: Number(e.target.value) }))} />
              <button className={`mini ${muted[s.name] ? 'active' : ''}`}
                title="mute" onClick={() => setMuted((m) => ({ ...m, [s.name]: !m[s.name] }))}>M</button>
              <button className={`mini ${solo === s.name ? 'active' : ''}`}
                title="solo" onClick={() => setSolo((cur) => (cur === s.name ? null : s.name))}>S</button>
              <a className="mini dl" href={stemUrl(jobId, s.file)} download>⬇</a>
            </div>
            <Waveform
              url={stemUrl(jobId, s.file)}
              ctx={audioCtxRef.current}
              color={STEM_COLORS[s.name] || '#8b93a5'}
              position={position}
              duration={duration}
              view={view}
              region={loopRegion}
              onRegionChange={changeRegion}
              onSeek={seek}
              onZoom={zoom} />
          </div>
        ))}
      </div>
      <p className="muted small">
        tip: space toggles play · drag on a waveform to loop a section · wheel to zoom · solo the guitar · drop the speed — then learn it
        {loopRegion && <> · looping {fmtTime(loopRegion.start)}–{fmtTime(loopRegion.end)} (click outside it or double-click to clear)</>}
      </p>
    </div>
  )
}
