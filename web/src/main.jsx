import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Home from './pages/Home.jsx'
import JobView from './pages/JobView.jsx'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <header className="topbar">
        <h1><a href="/">🎸 Stem Splitter</a></h1>
        <span className="tagline">isolate the guitar, learn the song</span>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/job/:id" element={<JobView />} />
        </Routes>
      </main>
    </BrowserRouter>
  </React.StrictMode>,
)
