import { useState, useRef, useEffect, useCallback } from 'react'
import './App.css'

const DIGITS = 17
const LS_KEY_APIKEY = 'ocrspace_apikey'
const LS_KEY_FISICOS = 'fisicos_codes'
const LS_KEY_SISTEMA = 'sistema_input'

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
  } catch (e) {}
}

export default function App() {
  const [tab, setTab] = useState('sistema')
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(LS_KEY_APIKEY) || '')
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [showApiSetup, setShowApiSetup] = useState(false)

  const [sistemaInput, setSistemaInput] = useState(() => localStorage.getItem(LS_KEY_SISTEMA) || '')
  const [sistemaCodes, setSistemaCodes] = useState(new Set())
  const [fisicosCodes, setFisicosCodes] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS_KEY_FISICOS)) || [] } catch { return [] }
  })

  const [camActive, setCamActive] = useState(false)
  const [camStatus, setCamStatus] = useState({ type: 'info', msg: 'Presiona "Iniciar cámara" para comenzar' })
  const [lastScan, setLastScan] = useState(null)
  const [manualInput, setManualInput] = useState('')
  const [isScanning, setIsScanning] = useState(false)

  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const scanIntervalRef = useRef(null)
  const isScanningRef = useRef(false)

  // Persist sistema input
  useEffect(() => {
    localStorage.setItem(LS_KEY_SISTEMA, sistemaInput)
    const tokens = sistemaInput.match(/\d{17}/g) || []
    setSistemaCodes(new Set(tokens))
  }, [sistemaInput])

  // Persist fisicos
  useEffect(() => {
    localStorage.setItem(LS_KEY_FISICOS, JSON.stringify(fisicosCodes))
  }, [fisicosCodes])

  const saveApiKey = () => {
    const k = apiKeyInput.trim()
    if (!k) return
    localStorage.setItem(LS_KEY_APIKEY, k)
    setApiKey(k)
    setApiKeyInput('')
    setShowApiSetup(false)
  }

  const removeApiKey = () => {
    localStorage.removeItem(LS_KEY_APIKEY)
    setApiKey('')
    setShowApiSetup(true)
  }

  const addCode = useCallback((code) => {
    const clean = code.replace(/\D/g, '')
    if (clean.length !== DIGITS) return { ok: false, msg: `Debe tener ${DIGITS} dígitos (detectado: ${clean.length})` }
    let isDup = false
    setFisicosCodes(prev => {
      if (prev.includes(clean)) { isDup = true; return prev }
      return [...prev, clean].sort()
    })
    if (isDup) return { ok: false, msg: 'Duplicado ignorado' }
    return { ok: true, msg: formatCode(clean) }
  }, [])

  const deleteCode = (idx) => setFisicosCodes(prev => prev.filter((_, i) => i !== idx))

  const clearFisicos = () => {
    if (!window.confirm('¿Eliminar todos los códigos físicos?')) return
    setFisicosCodes([])
    setLastScan(null)
  }

  // ── OCR.Space ──────────────────────────────────────────────
  const ocrFrame = useCallback(async () => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !video.videoWidth || !apiKey) return

    const vw = video.videoWidth, vh = video.videoHeight
    const cropW = Math.floor(vw * 0.94)
    const cropH = Math.floor(vh * 0.22)
    const cropX = Math.floor((vw - cropW) / 2)
    const cropY = Math.floor((vh - cropH) / 2)

    const scale = 2
    canvas.width = cropW * scale
    canvas.height = cropH * scale
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height)

    // Sharpen contrast
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const d = imgData.data
    let sum = 0
    for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114
    const avg = sum / (d.length / 4)
    const thr = Math.min(Math.max(avg * 0.9, 90), 175)
    for (let i = 0; i < d.length; i += 4) {
      const g = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114
      const v = g > thr ? 255 : 0
      d[i] = d[i+1] = d[i+2] = v
    }
    ctx.putImageData(imgData, 0, 0)

    // Convert to base64 PNG
    const base64 = canvas.toDataURL('image/png').split(',')[1]

    try {
      const formData = new FormData()
      formData.append('base64Image', 'data:image/png;base64,' + base64)
      formData.append('apikey', apiKey)
      formData.append('language', 'eng')
      formData.append('isOverlayRequired', 'false')
      formData.append('detectOrientation', 'false')
      formData.append('scale', 'true')
      formData.append('OCREngine', '2') // Engine 2 = better for numbers

      const res = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        body: formData,
      })
      const data = await res.json()

      if (data.IsErroredOnProcessing) {
        setCamStatus({ type: 'warn', msg: 'Error OCR: ' + (data.ErrorMessage?.[0] || 'desconocido') })
        return
      }

      const text = data.ParsedResults?.[0]?.ParsedText || ''
      const raw = text.replace(/\D/g, '')
      const matches = raw.match(/\d{17}/g)

      if (matches && matches.length > 0) {
        const result = addCode(matches[0])
        if (result.ok) {
          playBeep()
          setLastScan(result.msg)
          setCamStatus({ type: 'success', msg: '✓ Capturado: ' + result.msg })
        }
        // Duplicados: sin sonido, sin alerta, escaneo silencioso
      }
    } catch (e) {
      // red de error — silent en auto
    }
  }, [apiKey, addCode])

  const startCamera = async () => {
    if (!apiKey) { setShowApiSetup(true); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }
      }).catch(() => navigator.mediaDevices.getUserMedia({ video: true }))

      streamRef.current = stream
      if (videoRef.current) videoRef.current.srcObject = stream
      setCamActive(true)
      setCamStatus({ type: 'success', msg: 'Cámara activa — escaneando automáticamente' })

      scanIntervalRef.current = setInterval(() => {
        if (!isScanningRef.current) {
          isScanningRef.current = true
          setIsScanning(true)
          ocrFrame().finally(() => {
            isScanningRef.current = false
            setIsScanning(false)
          })
        }
      }, 1500)
    } catch (e) {
      setCamStatus({ type: 'warn', msg: 'Error cámara: ' + e.message })
    }
  }

  const stopCamera = useCallback(() => {
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null }
    if (scanIntervalRef.current) { clearInterval(scanIntervalRef.current); scanIntervalRef.current = null }
    if (videoRef.current) videoRef.current.srcObject = null
    setCamActive(false)
    isScanningRef.current = false
    setIsScanning(false)
    setCamStatus({ type: 'info', msg: 'Presiona "Iniciar cámara" para comenzar' })
  }, [])

  useEffect(() => () => stopCamera(), [stopCamera])

  const captureManual = () => {
    if (!apiKey) { setShowApiSetup(true); return }
    if (isScanningRef.current) return
    isScanningRef.current = true
    setIsScanning(true)
    setCamStatus({ type: 'info', msg: 'Procesando imagen...' })
    ocrFrame().finally(() => {
      isScanningRef.current = false
      setIsScanning(false)
    })
  }

  const handleManualAdd = () => {
    const res = addCode(manualInput)
    if (res.ok) { playBeep(); setLastScan(res.msg); setManualInput('') }
    setCamStatus({ type: res.ok ? 'success' : 'warn', msg: res.ok ? '✓ Agregado: ' + res.msg : res.msg })
  }

  const exportResults = () => {
    const fSet = new Set(fisicosCodes)
    const missing = [...sistemaCodes].filter(c => !fSet.has(c)).sort()
    const extra = [...fSet].filter(c => !sistemaCodes.has(c)).sort()
    const match = [...fSet].filter(c => sistemaCodes.has(c)).sort()
    let txt = `=== REPORTE INVENTARIO TARJETAS ===\nFecha: ${new Date().toLocaleString()}\n\n`
    txt += `SISTEMA: ${sistemaCodes.size}\nFÍSICOS: ${fisicosCodes.length}\n\n`
    txt += `--- FALTANTES (${missing.length}) ---\n${missing.map(formatCode).join('\n') || 'Ninguno'}\n\n`
    txt += `--- SOBRANTES (${extra.length}) ---\n${extra.map(formatCode).join('\n') || 'Ninguno'}\n\n`
    txt += `--- COINCIDENCIAS (${match.length}) ---\n${match.map(formatCode).join('\n') || 'Ninguno'}\n`
    const a = document.createElement('a')
    a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(txt)
    a.download = 'inventario_tarjetas.txt'
    a.click()
  }

  const fSet = new Set(fisicosCodes)
  const missing = [...sistemaCodes].filter(c => !fSet.has(c)).sort()
  const extra = [...fSet].filter(c => !sistemaCodes.has(c)).sort()
  const match = [...fSet].filter(c => sistemaCodes.has(c)).sort()
  const diff = fisicosCodes.length - sistemaCodes.size

  return (
    <div className="app">
      <div className="header">
        <div className="header-row">
          <div>
            <h1>📦 Control de Tarjetas</h1>
            <p>Códigos de 17 dígitos</p>
          </div>
          <button className="btn-settings" onClick={() => setShowApiSetup(v => !v)} title="Configurar API Key">
            <i className={`ti ${apiKey ? 'ti-settings' : 'ti-alert-circle'}`} />
            {!apiKey && <span className="api-warn">Sin API Key</span>}
          </button>
        </div>
      </div>

      {/* API KEY SETUP */}
      {(showApiSetup || !apiKey) && (
        <div className={`api-setup-card ${!apiKey ? 'no-key' : ''}`}>
          <div className="card-title">
            <i className="ti ti-key" /> API Key de OCR.Space
          </div>
          {apiKey ? (
            <div className="api-active">
              <i className="ti ti-circle-check" style={{ color: '#3B6D11' }} />
              <span>API Key configurada</span>
              <button className="btn danger small" onClick={removeApiKey}>Cambiar</button>
              <button className="btn small" onClick={() => setShowApiSetup(false)}>Cerrar</button>
            </div>
          ) : (
            <>
              <p className="api-hint">Obtén tu key gratis en <strong>ocr.space/ocrapi</strong> — solo necesitas tu email, sin tarjeta.</p>
              <div className="manual-add" style={{ marginTop: '0.75rem' }}>
                <input
                  type="text"
                  placeholder="Pega tu API Key aquí"
                  value={apiKeyInput}
                  onChange={e => setApiKeyInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && saveApiKey()}
                  style={{ fontFamily: 'monospace', fontSize: '13px' }}
                />
                <button className="btn primary" onClick={saveApiKey}>Guardar</button>
              </div>
            </>
          )}
        </div>
      )}

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
              <i className="ti ti-database" /> Códigos del sistema
              {sistemaCodes.size > 0 && <span className="count-badge">{sistemaCodes.size}</span>}
            </div>
            <textarea
              value={sistemaInput}
              onChange={e => setSistemaInput(e.target.value)}
              placeholder={`Pega aquí los códigos del sistema.\nSe detectan automáticamente los números de 17 dígitos.\n\nEjemplo:\n12345678901234567\n98765432109876543`}
            />
            <div className="btn-row">
              <button className="btn-big primary" onClick={() => setTab('camara')}>
                <i className="ti ti-camera" /> Ir a escanear físicos
              </button>
              <button className="btn danger" onClick={() => setSistemaInput('')}>
                <i className="ti ti-trash" /> Limpiar
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
            <i className={`ti ${camStatus.type === 'success' ? 'ti-check' : camStatus.type === 'warn' ? 'ti-alert-triangle' : 'ti-camera'}`} />
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
            <div className="cam-counter">
              <span>{fisicosCodes.length}</span>
              <small>escaneados</small>
            </div>
          </div>

          <div className="capture-zone">
            {!camActive ? (
              <button className="btn-capture start" onClick={startCamera}>
                <i className="ti ti-camera" />
                <span>INICIAR CÁMARA</span>
                <small>escaneo automático cada 1.5s</small>
              </button>
            ) : (
              <>
                <button
                  className={`btn-capture ${isScanning ? 'scanning' : 'ready'}`}
                  onClick={captureManual}
                  disabled={isScanning}
                >
                  <i className={`ti ${isScanning ? 'ti-loader-2' : 'ti-scan'}`} />
                  <span>{isScanning ? 'PROCESANDO...' : 'CAPTURAR AHORA'}</span>
                  <small>automático cada 1.5s</small>
                </button>
                <button className="btn-stop" onClick={stopCamera}>
                  <i className="ti ti-camera-off" /> Detener cámara
                </button>
              </>
            )}
          </div>

          {lastScan && (
            <div className="last-scan-banner">
              <i className="ti ti-circle-check" />
              <div>
                <small>Último capturado</small>
                <strong>{lastScan}</strong>
              </div>
              <span className="scan-total">{fisicosCodes.length} total</span>
            </div>
          )}

          <div className="card" style={{ marginTop: '0.75rem' }}>
            <div className="card-title">
              <i className="ti ti-keyboard" /> Ingresar manualmente
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
            <i className="ti ti-list" /> Ver lista de físicos ({fisicosCodes.length})
          </button>
        </div>
      )}

      {/* TAB 3: FÍSICOS */}
      {tab === 'fisicos' && (
        <div className="panel">
          <div className="stats-row">
            <div className="stat-card blue"><div className="stat-num">{fisicosCodes.length}</div><div className="stat-label">Físicos</div></div>
            <div className="stat-card green"><div className="stat-num">{sistemaCodes.size}</div><div className="stat-label">Sistema</div></div>
            <div className="stat-card">
              <div className="stat-num" style={{ color: diff === 0 ? '#3B6D11' : diff > 0 ? '#854F0B' : '#A32D2D' }}>
                {diff === 0 ? '✓' : diff > 0 ? '+' + diff : diff}
              </div>
              <div className="stat-label">Diferencia</div>
            </div>
          </div>
          <div className="action-row">
            <button className="btn-big primary" onClick={() => setTab('camara')}>
              <i className="ti ti-camera" /> Seguir escaneando
            </button>
            <button className="btn-big success" onClick={() => setTab('comparar')}>
              <i className="ti ti-git-compare" /> Comparar
            </button>
          </div>
          <div className="card">
            <div className="card-title"><i className="ti ti-list" /> Tarjetas físicas (menor → mayor)</div>
            {fisicosCodes.length === 0 ? (
              <div className="empty-msg">Escanea tarjetas en la pestaña "Cámara"</div>
            ) : (
              <div className="code-list">
                {fisicosCodes.map((c, i) => (
                  <div className="code-item" key={c}>
                    <span className="code-num">{i + 1}</span>
                    <span>{formatCode(c)}</span>
                    <button className="del-btn" onClick={() => deleteCode(i)}><i className="ti ti-x" /></button>
                  </div>
                ))}
              </div>
            )}
            {fisicosCodes.length > 0 && (
              <>
                <hr className="divider" />
                <button className="btn danger" onClick={clearFisicos}>
                  <i className="ti ti-trash" /> Limpiar toda la lista
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
            <div className="card"><div className="empty-msg">Carga códigos del sistema y escanea las tarjetas físicas para comparar</div></div>
          ) : (
            <>
              <div className="stats-row">
                <div className="stat-card green"><div className="stat-num">{match.length}</div><div className="stat-label">Coinciden</div></div>
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
                <div className="result-title missing"><i className="ti ti-alert-circle" /> Faltantes ({missing.length})</div>
                {missing.length === 0 ? <div className="no-result">Ninguno ✓</div> : missing.map(c => <span key={c} className="code-tag missing">{formatCode(c)}</span>)}
              </div>
              <div className="card">
                <div className="result-title extra"><i className="ti ti-alert-triangle" /> Sobrantes ({extra.length})</div>
                {extra.length === 0 ? <div className="no-result">Ninguno ✓</div> : extra.map(c => <span key={c} className="code-tag extra">{formatCode(c)}</span>)}
              </div>
              <div className="card">
                <div className="result-title match"><i className="ti ti-circle-check" /> Coincidencias ({match.length})</div>
                {match.length === 0 ? <div className="no-result">Ninguno</div> : match.map(c => <span key={c} className="code-tag match">{formatCode(c)}</span>)}
              </div>
              <button className="btn-big" onClick={exportResults}>
                <i className="ti ti-download" /> Exportar reporte .txt
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
