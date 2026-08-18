const BASE = '/api'

export async function uploadJob(file, tier, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${BASE}/jobs?tier=${encodeURIComponent(tier)}`)
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100))
    xhr.onload = () => (xhr.status < 300 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(JSON.parse(xhr.responseText).detail || xhr.statusText)))
    xhr.onerror = () => reject(new Error('network error'))
    const form = new FormData()
    form.append('file', file)
    xhr.send(form)
  })
}

export const listJobs = () => fetch(`${BASE}/jobs`).then((r) => r.json())
export const getJob = (id) => fetch(`${BASE}/jobs/${id}`).then((r) => r.json())
export const stemUrl = (id, file) => `${BASE}/jobs/${id}/stems/${file}`
