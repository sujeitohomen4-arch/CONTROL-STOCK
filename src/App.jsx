import { useState, useRef, useEffect, useCallback } from 'react'
import Tesseract from 'tesseract.js'
import './App.css'

const DIGITS = 17

function formatCode(c) {
  return c.replace(/(\d{5})(\d{4})(\d{4})(\d{4})/, '$1-$2-$3-$4')
}

export default function App() {
  const [tab, setTab] = useState('sistema')
  const [sistemaInput, setSistemaInput] = useState('')
  const [sistemaCodes, setSistemaCodes] = useState(new Set())
  const [fisicosCodes, setFisicosCodes] = useState([])
  const [camActive, setCamActive] = useState(false)
  const [camStatus, setCamStatus] = useState({ type: 'info', msg: 'Presiona "Iniciar cámara" para comenzar a escanear' })
  const [lastScan, setLastScan] = useState(null)
  const [manualInput, setManualInput] = useState('')
  const [isScanning, setIsScanning] = useState(false)

  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const scanIntervalRef = useRef(null)
  const isScanningRef = useRef(false)

  // Parse sistema codes from textarea
  const parseSistema = useCallback((raw) => {
    const tokens = raw.match(/\d{17}/g) || []
    setSistemaCodes(new Set(tokens))
  }, [])

  useEffect(() => {
    parseSistema(sistemaInput)
  }, [sistemaInput, parseSistema])

  // Add a physical code
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
    if (isDup) return { ok: false, msg: 'Duplicado ignorado: ' + formatCode(clean) }
    return { ok: true, msg: 'Agregado: ' + formatCode(clean) }
  }, [])

  const deleteCode = (idx) => {
    setFisicosCodes(prev => prev.filter((_, i) => i !== idx))
  }

  const clearFisicos = () => {
    if (!window.confirm('¿Eliminar todos los códigos físicos escaneados?')) return
    setFisicosCodes([])
    setLastScan(null)
  }

  // Camera
  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
      }).catch(() => navigator.mediaDevices.getUserMedia({ video: true }))

      streamRef.current = stream
      if (videoRef.current) videoRef.current.srcObject = stream
      setCamActive(true)
      setCamStatus({ type: 'success', msg: 'Cámara activa. Escaneo automático cada 2 seg, o presiona "Capturar".' })

      scanIntervalRef.current = setInterval(() => {
        if (!isScanningRef.current) captureFrameAuto()
      }, 2000)
    } catch (e) {
      setCamStatus({ type: 'warn', msg: 'No se pudo acceder a la cámara: ' + e.message })
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
    setCamStatus({ type: 'info', msg: 'Presiona "Iniciar cámara" para comenzar a escanear' })
  }

  useEffect(() => () => stopCamera(), [])

  const processFrame = async (auto = false) => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !video.videoWidth) return

    isScanningRef.current = true
    setIsScanning(true)
    if (!auto) setCamStatus({ type: 'info', msg: 'Procesando imagen...' })

    const vw = video.videoWidth, vh = video.videoHeight
    const cropW = Math.floor(vw * 0.87), cropH = Math.floor(vh * 0.23)
    const cropX = Math.floor((vw - cropW) / 2), cropY = Math.floor((vh - cropH) / 2)

    canvas.width = cropW
    canvas.height = cropH
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH)

    // Binarize for better OCR
    const imgData = ctx.getImageData(0, 0, cropW, cropH)
    const d = imgData.data
    for (let i = 0; i < d.length; i += 4) {
      const gray = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114
      const v = gray > 128 ? 255 : 0
      d[i] = d[i + 1] = d[i + 2] = v
    }
    ctx.putImageData(imgData, 0, 0)

    try {
      const result = await Tesseract.recognize(canvas, 'eng', {
        tessedit_char_whitelist: '0123456789 ',
        tessedit_pageseg_mode: '7',
      })
      const raw = result.data.text.replace(/\s/g, '')
      const matches = raw.match(/\d{17}/g)

      if (matches && matches.length > 0) {
        const res = addCode(matches[0])
        setCamStatus({ type: res.ok ? 'success' : 'warn', msg: res.ok ? '✓ ' + res.msg : res.msg })
        if (res.ok) setLastScan(formatCode(matches[0]))
      } else if (!auto) {
        setCamStatus({ type: 'warn', msg: 'No se detectó código de 17 dígitos. Ajusta la posición e iluminación.' })
      }
    } catch (e) {
      if (!auto) setCamStatus({ type: 'warn', msg: 'Error OCR: ' + e.message })
    }

    isScanningRef.current = false
    setIsScanning(false)
  }

  const captureFrameAuto = () => processFrame(true)
  const captureFrameManual = () => processFrame(false)

  const handleManualAdd = () => {
    const res = addCode(manualInput)
    setCamStatus({ type: res.ok ? 'success' : 'warn', msg: res.msg })
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
        <h1>📦 Control de Inventario de Tarjetas</h1>
        <p>Códigos de 17 dígitos — escanea físicos y compara con el sistema</p>
      </div>

      <div className="tabs">
        {['sistema', 'camara', 'fisicos', 'comparar'].map((t, i) => (
          <button
            key={t}
            className={`tab ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)}
          >
            {['1. Sistema', '2. Cámara', '3. Físicos', '4. Comparar'][i]}
            {t === 'fisicos' && <span className="badge blue">{fisicosCodes.length}</span>}
          </button>
        ))}
      </div>

      {/* TAB 1: SISTEMA */}
      {tab === 'sistema' && (
        <div className="panel">
          <div className="card">
            <div className="card-title">
              <i className="ti ti-database" aria-hidden="true" /> Códigos del sistema (17 dígitos cada uno)
            </div>
            <textarea
              value={sistemaInput}
              onChange={e => setSistemaInput(e.target.value)}
              placeholder={`Pega aquí los códigos del sistema, uno por línea o en masa.\nSe detectan automáticamente los números de 17 dígitos.\n\nEjemplo:\n12345678901234567\n98765432109876543`}
            />
            <div className="btn-row">
              <button className="btn primary" onClick={() => setTab('camara')}>
                Continuar → Escanear físicos
              </button>
              <button className="btn danger" onClick={() => setSistemaInput('')}>
                Limpiar
              </button>
            </div>
          </div>
          <div className="card">
            <div className="card-title">
              Códigos cargados del sistema{' '}
              {sistemaCodes.size > 0 && (
                <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>({sistemaCodes.size})</span>
              )}
            </div>
            {sistemaCodes.size === 0 ? (
              <div className="empty-msg">Aún no hay códigos de 17 dígitos detectados</div>
            ) : (
              <div className="code-list">
                {[...sistemaCodes].sort().map((c, i) => (
                  <div className="code-item" key={c}>
                    <span className="code-num">{i + 1}</span>
                    <span>{formatCode(c)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
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
              <div className="scan-frame"><div className="scan-line" /></div>
              <div className="cam-hint">Centra el código de 17 dígitos en el recuadro</div>
            </div>
          </div>

          <div className="btn-row" style={{ marginTop: '0.75rem' }}>
            <button className="btn primary" onClick={camActive ? stopCamera : startCamera}>
              <i className={`ti ${camActive ? 'ti-camera-off' : 'ti-camera'}`} aria-hidden="true" />
              {camActive ? 'Detener cámara' : 'Iniciar cámara'}
            </button>
            <button className="btn" onClick={captureFrameManual} disabled={!camActive || isScanning}>
              <i className="ti ti-scan" aria-hidden="true" /> Capturar
            </button>
            <button className="btn" onClick={() => setTab('fisicos')}>
              <i className="ti ti-list" aria-hidden="true" /> Ver lista
            </button>
          </div>

          {lastScan && (
            <div className="cam-status success" style={{ marginTop: '0.5rem' }}>
              <i className="ti ti-check" aria-hidden="true" /> Último: {lastScan}
            </div>
          )}

          <div className="card" style={{ marginTop: '0.75rem' }}>
            <div className="card-title">
              <i className="ti ti-keyboard" aria-hidden="true" /> Agregar código manualmente
            </div>
            <div className="manual-add">
              <input
                type="text"
                maxLength={17}
                placeholder="Ingresa código de 17 dígitos"
                value={manualInput}
                onChange={e => setManualInput(e.target.value.replace(/\D/g, ''))}
                onKeyDown={e => e.key === 'Enter' && handleManualAdd()}
              />
              <button className="btn primary" onClick={handleManualAdd}>Agregar</button>
            </div>
          </div>
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
          <div className="card">
            <div className="card-title">
              <i className="ti ti-list" aria-hidden="true" /> Tarjetas físicas escaneadas (ordenadas menor → mayor)
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
            <hr className="divider" />
            <div className="btn-row">
              <button className="btn" onClick={() => setTab('camara')}>
                <i className="ti ti-camera" aria-hidden="true" /> Seguir escaneando
              </button>
              <button className="btn primary" onClick={() => setTab('comparar')}>
                <i className="ti ti-git-compare" aria-hidden="true" /> Comparar
              </button>
              <button className="btn danger" onClick={clearFisicos}>Limpiar lista</button>
            </div>
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
                  <i className="ti ti-alert-circle" aria-hidden="true" /> Faltantes — en el sistema pero no en físicos
                </div>
                {missing.length === 0
                  ? <div className="no-result">Ninguno</div>
                  : missing.map(c => <span key={c} className="code-tag missing">{formatCode(c)}</span>)
                }
              </div>

              <div className="card">
                <div className="result-title extra">
                  <i className="ti ti-alert-triangle" aria-hidden="true" /> Sobrantes — en físicos pero no en el sistema
                </div>
                {extra.length === 0
                  ? <div className="no-result">Ninguno</div>
                  : extra.map(c => <span key={c} className="code-tag extra">{formatCode(c)}</span>)
                }
              </div>

              <div className="card">
                <div className="result-title match">
                  <i className="ti ti-circle-check" aria-hidden="true" /> Coincidencias
                </div>
                {match.length === 0
                  ? <div className="no-result">Ninguno</div>
                  : match.map(c => <span key={c} className="code-tag match">{formatCode(c)}</span>)
                }
              </div>

              <div className="btn-row">
                <button className="btn" onClick={exportResults}>
                  <i className="ti ti-download" aria-hidden="true" /> Exportar .txt
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
