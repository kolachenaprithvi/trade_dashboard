import { useState } from 'react'
import { Download, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react'
import './SwingTrade.css'

type Direction = 'LONG' | 'SHORT'
type SwingCandidate = {
  direction: Direction
  symbol: string
  setup: string
  score_percent: number
  grade: string
  close: number
  daily_rsi: number
  daily_adx: number
  relative_volume: number
  hourly_rsi: number
  hourly_candle_time: string
}
type SwingMetrics = {
  foUnderlyingCount: number
  matchedCount: number
  eligibleCount: number
  scannedCount: number
  candidateCount: number
  longCount: number
  shortCount: number
  issueCount: number
}
type SwingScan = {
  scanId: string
  fileName: string
  asOf: string
  metrics: SwingMetrics
  rows: SwingCandidate[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isSwingScan(value: unknown): value is SwingScan {
  if (!isRecord(value) || !isRecord(value.metrics) || !Array.isArray(value.rows)) return false
  return typeof value.scanId === 'string'
    && typeof value.fileName === 'string'
    && typeof value.asOf === 'string'
    && typeof value.metrics.candidateCount === 'number'
    && typeof value.metrics.longCount === 'number'
    && typeof value.metrics.shortCount === 'number'
    && typeof value.metrics.eligibleCount === 'number'
    && typeof value.metrics.scannedCount === 'number'
    && typeof value.metrics.foUnderlyingCount === 'number'
    && typeof value.metrics.matchedCount === 'number'
    && typeof value.metrics.issueCount === 'number'
    && value.rows.every(isSwingCandidate)
}

function isSwingCandidate(value: unknown): value is SwingCandidate {
  return isRecord(value)
    && (value.direction === 'LONG' || value.direction === 'SHORT')
    && typeof value.symbol === 'string'
    && typeof value.setup === 'string'
    && typeof value.score_percent === 'number'
    && typeof value.grade === 'string'
    && typeof value.close === 'number'
    && typeof value.daily_rsi === 'number'
    && typeof value.daily_adx === 'number'
    && typeof value.relative_volume === 'number'
    && typeof value.hourly_rsi === 'number'
    && typeof value.hourly_candle_time === 'string'
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return new Error(fallback)
  }
  const detail = isRecord(body) ? body.detail : undefined
  return new Error(typeof detail === 'string' ? detail : fallback)
}

const numberFormat = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 })
const formatNumber = (value: number) => Number.isFinite(value) ? numberFormat.format(value) : '—'
const formatTime = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(date)
}

function SwingTrade({ apiBaseUrl, password, onUnauthorized }: {
  apiBaseUrl: string
  password: string
  onUnauthorized: () => void
}) {
  const [scan, setScan] = useState<SwingScan | null>(null)
  const [scanning, setScanning] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState('')

  const runScan = async () => {
    setScanning(true)
    setError('')
    setScan(null)
    try {
      const response = await fetch(`${apiBaseUrl}/api/swing-trade/scan`, {
        method: 'POST',
        headers: { 'X-Dashboard-Password': password },
      })
      if (response.status === 401) onUnauthorized()
      if (!response.ok) throw await responseError(response, `Swing scan failed with HTTP ${response.status}.`)
      const body: unknown = await response.json()
      if (!isSwingScan(body)) throw new Error('The swing scan returned an unexpected response.')
      setScan(body)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Swing scan could not be completed.')
    } finally {
      setScanning(false)
    }
  }

  const downloadWorkbook = async () => {
    if (!scan) return
    setDownloading(true)
    setError('')
    try {
      const response = await fetch(`${apiBaseUrl}/api/swing-trade/export/${encodeURIComponent(scan.scanId)}`, {
        headers: { 'X-Dashboard-Password': password },
      })
      if (response.status === 401) onUnauthorized()
      if (!response.ok) throw await responseError(response, `Workbook download failed with HTTP ${response.status}.`)
      const file = await response.blob()
      const url = URL.createObjectURL(file)
      const link = document.createElement('a')
      link.href = url
      link.download = scan.fileName
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Workbook could not be downloaded.')
    } finally {
      setDownloading(false)
    }
  }

  return <section className="swing-trade-page">
    <div className="heading-row">
      <div>
        <div className="eyebrow"><span className="eyebrow-line"/> MARKET INTELLIGENCE <span className="eyebrow-date">NSE F&O</span></div>
        <h1>Swing Trade</h1>
        <p className="subtitle">Scan daily and completed hourly candles for bullish and bearish setups.</p>
      </div>
      <div className="heading-controls">
        <button className="refresh-btn swing-run-button" onClick={() => void runScan()} disabled={scanning || downloading}>
          <RefreshCw size={14} className={scanning ? 'swing-spinning' : ''}/>
          {scanning ? 'Scanning F&O stocks…' : 'Run swing scan'}
        </button>
      </div>
    </div>

    <div className="panel swing-method">
      <div className="swing-method-icon"><TrendingUp size={17}/></div>
      <div>
        <strong>Daily direction · hourly confirmation</strong>
        <p>Checks NSE single-stock F&O names priced ₹200–₹5,000 with at least 1M daily volume. LONG/SHORT candidates require aligned daily conditions and hourly Supertrend 7,2 + 10,3 on the latest completed hour.</p>
        <span>Signals are heuristic screening results, not probabilities or investment advice. This scan does not fetch option chains or create spread legs.</span>
      </div>
    </div>

    {error && <div className="swing-error" role="alert">{error}</div>}

    {scan && <>
      <div className="swing-scan-summary">
        <div><span>F&O UNDERLYINGS</span><strong>{formatNumber(scan.metrics.foUnderlyingCount)}</strong></div>
        <div><span>ELIGIBLE TO SCAN</span><strong>{formatNumber(scan.metrics.eligibleCount)}</strong></div>
        <div><span>SUCCESSFULLY SCANNED</span><strong>{formatNumber(scan.metrics.scannedCount)}</strong></div>
        <div><span>LONG SETUPS</span><strong className="swing-long"><TrendingUp size={14}/>{formatNumber(scan.metrics.longCount)}</strong></div>
        <div><span>SHORT SETUPS</span><strong className="swing-short"><TrendingDown size={14}/>{formatNumber(scan.metrics.shortCount)}</strong></div>
        <div><span>DATA ISSUES</span><strong className={scan.metrics.issueCount ? 'swing-issue-count' : ''}>{formatNumber(scan.metrics.issueCount)}</strong></div>
      </div>

      <div className="panel swing-results">
        <div className="panel-heading">
          <div>
            <span className="eyebrow-small">LATEST COMPLETED SCAN</span>
            <h2>Directional candidates</h2>
            <p>{scan.metrics.candidateCount} setup{scan.metrics.candidateCount === 1 ? '' : 's'} · {formatTime(scan.asOf)}</p>
          </div>
          <button className="refresh-btn swing-download-button" onClick={() => void downloadWorkbook()} disabled={downloading || scanning}>
            <Download size={14}/>{downloading ? 'Preparing workbook…' : 'Download Excel'}
          </button>
        </div>
        {scan.rows.length ? <div className="table-scroll swing-table-scroll">
          <table className="swing-table">
            <thead><tr><th>DIRECTION</th><th>SYMBOL</th><th>SETUP</th><th>SCORE</th><th>GRADE</th><th>DAILY CLOSE</th><th>DAILY RSI</th><th>DAILY ADX</th><th>REL. VOL.</th><th>HOURLY RSI</th><th>LAST HOURLY BAR</th></tr></thead>
            <tbody>{scan.rows.map(row => <tr key={`${row.symbol}-${row.direction}`}>
              <td><span className={`swing-direction ${row.direction.toLowerCase()}`}>{row.direction === 'LONG' ? <TrendingUp size={13}/> : <TrendingDown size={13}/>} {row.direction}</span></td>
              <td className="swing-symbol">{row.symbol}</td>
              <td>{row.setup.replace(/_/g, ' ')}</td>
              <td className="swing-score">{formatNumber(row.score_percent)}%</td>
              <td>{row.grade}</td>
              <td>{formatNumber(row.close)}</td>
              <td>{formatNumber(row.daily_rsi)}</td>
              <td>{formatNumber(row.daily_adx)}</td>
              <td>{formatNumber(row.relative_volume)}x</td>
              <td>{formatNumber(row.hourly_rsi)}</td>
              <td>{formatTime(row.hourly_candle_time)}</td>
            </tr>)}</tbody>
          </table>
        </div> : <div className="swing-empty"><TrendingUp size={22}/><strong>No directional candidates on this run</strong><span>Review the scan date, market-data access, and any recorded issues in the downloaded workbook.</span></div>}
      </div>
      <p className="swing-export-note">Excel export includes the Directional Scan sheet. The template’s spread tabs remain blank; no option prices or legs are inferred.</p>
    </>}

    {!scan && !scanning && !error && <div className="panel swing-empty swing-start-state">
      <div className="swing-empty-mark"><RefreshCw size={20}/></div>
      <strong>Run your first swing scan</strong>
      <span>The scan uses the backend’s configured Upstox access token and exports results into your supplied workbook template.</span>
    </div>}
  </section>
}

export default SwingTrade
