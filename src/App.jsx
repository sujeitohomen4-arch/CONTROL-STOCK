import { useState, useRef, useEffect, useCallback } from 'react'
import Tesseract from 'tesseract.js'
import './App.css'

const DIGITS = 17

function formatCode(c) {
  return c.replace(/(\d{5})(\d{4})(\d{4})(\d{4})/, '$1-$2-$3-$4')
}

function playBeep() {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.3, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.15)
  } catch (e) { /* silent fail if audio blocked */ }
}

export default function App() {
  const [tab, setTab] = useState('sistema')
  const [sistemaInput, setSistemaInput] = useState('')
  const [sistemaCodes, setSistemaCodes] = useState(new Set())
  const [fisicosCodes, setFisicosCodes] = useState([])
  const [camActive, setCamActive] = useState(false)
  const [camStatus, setCamStatus] = useState({ type: 'info', msg: 'Presiona "Iniciar cámara" para comenzar' })
  const [lastScan, setLastScan] = useState(null)
  const [manualInput, setManualInput] = useState('')
  const [isScanning, setIsScanning] = useState(false)
  const [scanCount, setScanCount] = useState(0)

  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const scanIntervalRef = useRef(null)
  const isScanningRef = useRef(false)
  const workerRef = useRef(null)

  const parseSistema = useCallback((raw) => {
    const tokens = raw.match(/\d{17}/g) || []
    setSistemaCodes(new Set(tokens))
  }, [])

  useEffect(() => {
    parseSistema(sistemaInput)
  }, [sistemaInput, parseSistema])

  // Pre-initialize Tesseract worker for speed
  useEffect(() => {
    const initWorker = async () => {
      const worker = await Tesseract.createWorker('eng', 1, {
        logger: () => {}
      })
      await worker.setParameters({
        tessedit_char_whitelist: '0123456789',
        tessedit_pageseg_mode: '7',
        tessedit_ocr_engine_mode: '2',
      })
      workerRef.current = worker
    }
    initWorker()
    return () => { workerRef.current?.terminate() }
  }, [])

  const addCode = useCallback((code) => {
    const clean = code.replace(/\D/g, '')
    if (clean.length !== DIGITS) {
      return { ok: false, msg: `Debe tener ${DIGITS} dígitos (detectado: ${clean.length})` }
    }
    let isDup = false
    setFisicosCodes(prev => {
      if (prev.includes(clean)) { isDup = true; return prev }
      return [...prev, clean].sort()
    })
    if (isDup) return { ok: false, msg: 'Duplicado: ' + formatCode(clean) }
    setScanCount(n => n + 1)
    return { ok: true, msg: formatCode(clean) }
  }, [])

  const deleteCode = (idx) => {
    setFisicosCodes(prev => prev.filter((_, i) => i !== idx))
    setScanCount(n => Math.max(0, n - 1))
  }

  const clearFisicos = () => {
    if (!window.confirm('¿Eliminar todos los códigos físicos?')) return
    setFisicosCodes([])
    setLastScan(null)
    setScanCount(0)
  }

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }
      }).catch(() => navigator.mediaDevices.getUserMedia({ video: true }))

      streamRef.current = stream
      if (videoRef.current) videoRef.current.srcObject = stream
      setCamActive(true)
      setCamStatus({ type: 'success', msg: 'Cámara activa — escaneando automáticamente' })

      // Auto-scan every 800ms for fast detection
      scanIntervalRef.current = setInterval(() => {
        if (!isScanningRef.current) captureFrameAuto()
      }, 800)
    } catch (e) {
      setCamStatus({ type: 'warn', msg: 'Error cámara: ' + e.message })
    }
  }

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    if (scanIntervalRef.current) {
      clearInterval(scanIntervalRef.current)
      scanIntervalRef.current = null
    }
    if (videoRef.current) videoRef.current.srcObject = null
    setCamActive(false)
    setCamStatus({ type: 'info', msg: 'Presiona "Iniciar cámara" para comenzar' })
  }

  useEffect(() => () => stopCamera(), [])

  const processFrame = async (auto = false) => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !video.videoWidth || !workerRef.current) return

    isScanningRef.current = true
    setIsScanning(true)

    const vw = video.videoWidth, vh = video.videoHeight
    // Wider crop to catch full 17-digit codes
    const cropW = Math.floor(vw * 0.92)
    const cropH = Math.floor(vh * 0.20)
    const cropX = Math.floor((vw - cropW) / 2)
    const cropY = Math.floor((vh - cropH) / 2)

    // Scale up 2x for better OCR accuracy
    const scale = 2
    canvas.width = cropW * scale
    canvas.height = cropH * scale
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW * scale, cropH * scale)

    // High-contrast binarization with adaptive threshold
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const d = imgData.data
    // Calculate average brightness for adaptive threshold
    let sum = 0
    for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114
    const avg = sum / (d.length / 4)
    const threshold = Math.min(Math.max(avg * 0.85, 80), 180)

    for (let i = 0; i < d.length; i += 4) {
      const gray = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114
      const v = gray > threshold ? 255 : 0
      d[i] = d[i+1] = d[i+2] = v
    }
    ctx.putImageData(imgData, 0, 0)

    try {
      const result = await workerRef.current.recognize(canvas)
      const raw = result.data.text.replace(/\D/g, '')
      // Try to find 17-digit sequence, also handle slight misreads (16-18 digits)
      const matches = raw.match(/\d{17}/g) || raw.match(/\d{16,18}/g)

      if (matches && matches.length > 0) {
        const candidate = matches[0].length === 17
          ? matches[0]
          : matches.find(m => m.length === 17) || matches[0]

        if (candidate.length === 17) {
          const res = addCode(candidate)
          if (res.ok) {
            playBeep()
            setLastScan(res.msg)
            setCamStatus({ type: 'success', msg: '✓ Capturado: ' + res.msg })
          } else if (res.msg.startsWith('Duplicado')) {
            setCamStatus({ type: 'warn', msg: '⚠ ' + res.msg })
          }
        }
      }
    } catch (e) {
      // silent fail on auto scan
    }

    isScanningRef.current = false
    setIsScanning(false)
  }

  const captureFrameAuto = () => processFrame(true)
  const captureFrameManual = () => processFrame(false)

  const handleManualAdd = () => {
    const res = addCode(manualInput)
    setCamStatus({ type: res.ok ? 'success' : 'warn', msg: res.ok ? '✓ Agregado: ' + res.msg : res.msg })
    if (res.ok) setManualInput('')
  }

  const exportResults = () => {
    const sSet = sistemaCodes
    const fSet = new Set(fisicosCodes)
    const missing = [...sSet].filter(c => !fSet.has(c)).sort()
    const extra = [...fSet].filter(c => !sSet.has(c)).sort()
    const match = [...fSet].filter(c => sSet.has(c)).sort()
    let txt = `=== REPORTE DE INVENTARIO DE TARJETAS ===\nFecha: ${new Date().toLocaleString()}\n\n`
    txt += `SISTEMA: ${sSet.size} códigos\nFÍSICOS: ${fisicosCodes.length} códigos\n\n`
    txt += `--- FALTANTES (${missing.length}) ---\n${missing.map(c => formatCode(c)).join('\n') || 'Ninguno'}\n\n`
    txt += `--- SOBRANTES (${extra.length}) ---\n${extra.map(c => formatCode(c)).join('\n') || 'Ninguno'}\n\n`
    txt += `--- COINCIDENCIAS (${match.length}) ---\n${match.map(c => formatCode(c)).join('\n') || 'Ninguno'}\n`
    const a = document.createElement('a')
    a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(txt)
    a.download = 'inventario_tarjetas.txt'
    a.click()
  }

  const diff = fisicosCodes.length - sistemaCodes.size
  const sSet = sistemaCodes
  const fSet = new Set(fisicosCodes)
  const missing = [...sSet].filter(c => !fSet.has(c)).sort()
  const extra = [...fSet].filter(c => !sSet.has(c)).sort()
  const match = [...fSet].filter(c => sSet.has(c)).sort()

  return (
    <div className="app">
      <div className="header">
        <h1>📦 Control de Tarjetas</h1>
        <p>Códigos de 17 dígitos</p>
      </div>

      <div className="tabs">
        {['sistema', 'camara', 'fisicos', 'comparar'].map((t, i) => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {['Sistema', 'Cámara', 'Físicos', 'Comparar'][i]}
            {t === 'fisicos' && fisicosCodes.length > 0 && (
              <span className="badge blue">{fisicosCodes.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* TAB 1: SISTEMA */}
      {tab === 'sistema' && (
        <div className="panel">
          <div className="card">
            <div className="card-title">
              <i className="ti ti-database" aria-hidden="true" /> Códigos del sistema
              {sistemaCodes.size > 0 && <span className="count-badge">{sistemaCodes.size}</span>}
            </div>
            <textarea
              value={sistemaInput}
              onChange={e => setSistemaInput(e.target.value)}
              placeholder={`Pega aquí los códigos del sistema.\nSe detectan automáticamente los números de 17 dígitos.\n\nEjemplo:\n12345678901234567\n98765432109876543`}
            />
            <div className="btn-row">
              <button className="btn-big primary" onClick={() => setTab('camara')}>
                <i className="ti ti-camera" aria-hidden="true" />
                Ir a escanear físicos
              </button>
              <button className="btn danger" onClick={() => setSistemaInput('')}>
                <i className="ti ti-trash" aria-hidden="true" /> Limpiar
              </button>
            </div>
          </div>
          {sistemaCodes.size > 0 && (
            <div className="card">
              <div className="card-title">Códigos cargados</div>
              <div className="code-list">
                {[...sistemaCodes].sort().map((c, i) => (
                  <div className="code-item" key={c}>
                    <span className="code-num">{i + 1}</span>
                    <span>{formatCode(c)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 2: CÁMARA */}
      {tab === 'camara' && (
        <div className="panel">
          <div className={`cam-status ${camStatus.type}`}>
            <i className={`ti ${camStatus.type === 'success' ? 'ti-check' : camStatus.type === 'warn' ? 'ti-alert-triangle' : 'ti-camera'}`} aria-hidden="true" />
            {camStatus.msg}
          </div>

          <div className="cam-container">
            <video ref={videoRef} autoPlay playsInline muted />
            <canvas ref={canvasRef} style={{ display: 'none' }} />
            <div className="cam-overlay">
              <div className={`scan-frame ${isScanning ? 'scanning' : ''}`}>
                <div className="scan-line" />
              </div>
              <div className="cam-hint">Centra el código de 17 dígitos en el recuadro</div>
            </div>
            {/* Counter overlay */}
            <div className="cam-counter">
              <span>{fisicosCodes.length}</span>
              <small>escaneados</small>
            </div>
          </div>

          {/* BIG CAPTURE BUTTON */}
          <div className="capture-zone">
            {!camActive ? (
              <button className="btn-capture start" onClick={startCamera}>
                <i className="ti ti-camera" aria-hidden="true" />
                <span>INICIAR CÁMARA</span>
              </button>
            ) : (
              <>
                <button
                  className={`btn-capture ${isScanning ? 'scanning' : 'ready'}`}
                  onClick={captureFrameManual}
                  disabled={isScanning}
                >
                  <i className={`ti ${isScanning ? 'ti-loader' : 'ti-scan'}`} aria-hidden="true" />
                  <span>{isScanning ? 'PROCESANDO...' : 'CAPTURAR'}</span>
                  <small>o espera — automático cada 0.8s</small>
                </button>
                <button className="btn-stop" onClick={stopCamera}>
                  <i className="ti ti-camera-off" aria-hidden="true" /> Detener
                </button>
              </>
            )}
          </div>

          {lastScan && (
            <div className="last-scan-banner">
              <i className="ti ti-circle-check" aria-hidden="true" />
              <div>
                <small>Último capturado</small>
                <strong>{lastScan}</strong>
              </div>
              <span className="scan-total">{fisicosCodes.length} total</span>
            </div>
          )}

          <div className="card" style={{ marginTop: '0.75rem' }}>
            <div className="card-title">
              <i className="ti ti-keyboard" aria-hidden="true" /> Ingresar manualmente
            </div>
            <div className="manual-add">
              <input
                type="text"
                inputMode="numeric"
                maxLength={17}
                placeholder="17 dígitos"
                value={manualInput}
                onChange={e => setManualInput(e.target.value.replace(/\D/g, ''))}
                onKeyDown={e => e.key === 'Enter' && handleManualAdd()}
              />
              <button className="btn primary" onClick={handleManualAdd}>Agregar</button>
            </div>
          </div>

          <button className="btn-nav-bottom" onClick={() => setTab('fisicos')}>
            <i className="ti ti-list" aria-hidden="true" /> Ver lista de físicos ({fisicosCodes.length})
          </button>
        </div>
      )}

      {/* TAB 3: FÍSICOS */}
      {tab === 'fisicos' && (
        <div className="panel">
          <div className="stats-row">
            <div className="stat-card blue">
              <div className="stat-num">{fisicosCodes.length}</div>
              <div className="stat-label">Físicos</div>
            </div>
            <div className="stat-card green">
              <div className="stat-num">{sistemaCodes.size}</div>
              <div className="stat-label">Sistema</div>
            </div>
            <div className="stat-card">
              <div className="stat-num" style={{ color: diff === 0 ? '#3B6D11' : diff > 0 ? '#854F0B' : '#A32D2D' }}>
                {diff === 0 ? '✓' : diff > 0 ? '+' + diff : diff}
              </div>
              <div className="stat-label">Diferencia</div>
            </div>
          </div>

          <div className="action-row">
            <button className="btn-big primary" onClick={() => setTab('camara')}>
              <i className="ti ti-camera" aria-hidden="true" /> Seguir escaneando
            </button>
            <button className="btn-big success" onClick={() => setTab('comparar')}>
              <i className="ti ti-git-compare" aria-hidden="true" /> Comparar
            </button>
          </div>

          <div className="card">
            <div className="card-title">
              <i className="ti ti-list" aria-hidden="true" /> Tarjetas físicas (menor → mayor)
            </div>
            {fisicosCodes.length === 0 ? (
              <div className="empty-msg">Escanea tarjetas en la pestaña "Cámara"</div>
            ) : (
              <div className="code-list">
                {fisicosCodes.map((c, i) => (
                  <div className="code-item" key={c}>
                    <span className="code-num">{i + 1}</span>
                    <span>{formatCode(c)}</span>
                    <button className="del-btn" onClick={() => deleteCode(i)} title="Eliminar">
                      <i className="ti ti-x" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {fisicosCodes.length > 0 && (
              <>
                <hr className="divider" />
                <button className="btn danger" onClick={clearFisicos}>
                  <i className="ti ti-trash" aria-hidden="true" /> Limpiar toda la lista
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* TAB 4: COMPARAR */}
      {tab === 'comparar' && (
        <div className="panel">
          {sistemaCodes.size === 0 && fisicosCodes.length === 0 ? (
            <div className="card">
              <div className="empty-msg">Carga códigos del sistema y escanea las tarjetas físicas para comparar</div>
            </div>
          ) : (
            <>
              <div className="stats-row">
                <div className="stat-card green">
                  <div className="stat-num">{match.length}</div>
                  <div className="stat-label">Coinciden</div>
                </div>
                <div className="stat-card" style={{ border: '0.5px solid #F09595' }}>
                  <div className="stat-num" style={{ color: '#A32D2D' }}>{missing.length}</div>
                  <div className="stat-label">Faltantes</div>
                </div>
                <div className="stat-card" style={{ border: '0.5px solid #FAC775' }}>
                  <div className="stat-num" style={{ color: '#854F0B' }}>{extra.length}</div>
                  <div className="stat-label">Sobrantes</div>
                </div>
              </div>

              <div className="card">
                <div className="result-title missing">
                  <i className="ti ti-alert-circle" aria-hidden="true" /> Faltantes ({missing.length}) — en sistema pero no en físicos
                </div>
                {missing.length === 0
                  ? <div className="no-result">Ninguno ✓</div>
                  : missing.map(c => <span key={c} className="code-tag missing">{formatCode(c)}</span>)
                }
              </div>

              <div className="card">
                <div className="result-title extra">
                  <i className="ti ti-alert-triangle" aria-hidden="true" /> Sobrantes ({extra.length}) — en físicos pero no en sistema
                </div>
                {extra.length === 0
                  ? <div className="no-result">Ninguno ✓</div>
                  : extra.map(c => <span key={c} className="code-tag extra">{formatCode(c)}</span>)
                }
              </div>

              <div className="card">
                <div className="result-title match">
                  <i className="ti ti-circle-check" aria-hidden="true" /> Coincidencias ({match.length})
                </div>
                {match.length === 0
                  ? <div className="no-result">Ninguno</div>
                  : match.map(c => <span key={c} className="code-tag match">{formatCode(c)}</span>)
                }
              </div>

              <button className="btn-big" onClick={exportResults}>
                <i className="ti ti-download" aria-hidden="true" /> Exportar reporte .txt
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
