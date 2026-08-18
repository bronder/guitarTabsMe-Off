import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getJob } from '../api.js'
import Mixer from '../components/Mixer.jsx'

export default function JobView() {
  const { id } = useParams()
  const [job, setJob] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let active = true
    let timer
    const poll = async () => {
      try {
        const j = await getJob(id)
        if (!active) return
        setJob(j)
        if (j.state !== 'done' && j.state !== 'error') timer = setTimeout(poll, 2000)
      } catch (e) {
        if (active) setError(e.message)
      }
    }
    poll()
    return () => { active = false; clearTimeout(timer) }
  }, [id])

  if (error) return <p className="error">{error}</p>
  if (!job) return <p className="muted">loading…</p>

  return (
    <div className="jobview">
      <p><Link to="/">← all jobs</Link></p>
      <h2>{job.name} <span className="badge">{job.tier}</span></h2>

      {job.state === 'error' && (
        <p className="error">job failed: {job.error}</p>
      )}

      {(job.state === 'queued' || job.state === 'stage1' || job.state === 'stage2') && (
        <>
          <div className="progress big"><div style={{ width: `${job.progress}%` }} /></div>
          <p className="muted">{job.state === 'queued' ? 'queued…' : job.stage_detail} · {job.progress}%</p>
        </>
      )}

      {job.state === 'done' && <Mixer jobId={job.id} stems={job.stems} />}
    </div>
  )
}
