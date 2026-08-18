import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { uploadJob, listJobs } from '../api.js'

const TIERS = {
  fast: {
    label: 'Fast',
    desc: '6 stems (vocals, drums, bass, guitar, piano, other) · ~8x realtime · lower separation quality',
  },
  studio: {
    label: 'Studio',
    desc: 'Guitar + no-guitar via RoFormer vocal removal + Demucs · ~3x realtime · best guitar quality',
  },
}

function fmtBytes(n) {
  return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(0)} kB`
}

export default function Home() {
  const [tier, setTier] = useState('fast')
  const [file, setFile] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [pct, setPct] = useState(0)
  const [error, setError] = useState(null)
  const [jobs, setJobs] = useState([])
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef(null)

  const refresh = () => listJobs().then(setJobs).catch(() => {})
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 3000)
    return () => clearInterval(t)
  }, [])

  const submit = async () => {
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      await uploadJob(file, tier, setPct)
      setFile(null)
      inputRef.current.value = ''
      refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setUploading(false)
      setPct(0)
    }
  }

  return (
    <div className="home">
      <section className="upload-card">
        <div
          className={`dropzone ${dragOver ? 'over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); setFile(e.dataTransfer.files[0]) }}
          onClick={() => inputRef.current.click()}
        >
          {file
            ? <><strong>{file.name}</strong> <span className="muted">{fmtBytes(file.size)}</span></>
            : <span className="muted">drop an audio file here, or click to choose<br />(mp3 · wav · flac · ogg · m4a, max 100 MB)</span>}
          <input ref={inputRef} type="file" hidden
            accept=".mp3,.wav,.flac,.ogg,.m4a"
            onChange={(e) => setFile(e.target.files[0])} />
        </div>

        <div className="tiers">
          {Object.entries(TIERS).map(([key, t]) => (
            <label key={key} className={`tier ${tier === key ? 'selected' : ''}`}>
              <input type="radio" name="tier" checked={tier === key} onChange={() => setTier(key)} />
              <strong>{t.label}</strong>
              <span>{t.desc}</span>
            </label>
          ))}
        </div>

        {error && <p className="error">{error}</p>}
        {uploading
          ? <div className="progress"><div style={{ width: `${pct}%` }} /><span>uploading {pct}%</span></div>
          : <button className="primary" disabled={!file} onClick={submit}>Split it</button>}
      </section>

      <section className="jobs">
        <h2>Jobs</h2>
        {jobs.length === 0 && <p className="muted">nothing yet — upload a song above</p>}
        {jobs.map((j) => (
          <Link key={j.id} to={`/job/${j.id}`} className={`job ${j.state}`}>
            <span className="name">{j.name}</span>
            <span className="badge">{j.tier}</span>
            {j.state === 'done' && <span className="badge ok">done</span>}
            {(j.state === 'queued' || j.state === 'stage1' || j.state === 'stage2') && (
              <span className="badge busy">{j.state} {j.progress}%</span>
            )}
            {j.state === 'error' && <span className="badge err">error</span>}
          </Link>
        ))}
      </section>
    </div>
  )
}
