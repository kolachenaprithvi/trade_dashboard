import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, ArrowDownRight, ArrowUpRight, BarChart3, Bell, ChevronDown, Clock3, Layers3, LockKeyhole, Moon, Radio, RefreshCw, Search, Settings2, ShieldCheck, Signal, Sun, Wifi, WifiOff, X } from 'lucide-react'
import OiChangeChart from './OiChangeChart'
import MarketChart, { chartTimeframes, type ChartIndicators, type ChartTimeframe, type MarketCandle, type SupertrendSettings } from './MarketChart'

type Quote = { instrumentKey: string; lastPrice: number | null; change: number | null; volume?: number | null; oi?: number | null; timestamp?: string | null; ohlc?: Record<string, number> }
type Dashboard = { mode: string; status: string; asOf: string | null; indices: Record<string, Quote>; technicals: Record<string, unknown>; bankStocks?: Record<string, Quote & { label?: string }>; message: string | null; serverTime?: string }
type FutureRow = { symbol: string; tradingSymbol?: string; expiry?: string; lastPrice?: number | null; change?: number | null; oi?: number | null; previousOi?: number | null }
type Candle = MarketCandle
type ChainRow = { strike_price?: number; call_options?: { market_data?: { ltp?: number; oi?: number; prev_oi?: number; volume?: number; bid_price?: number; ask_price?: number }; option_greeks?: { delta?: number; iv?: number } }; put_options?: { market_data?: { ltp?: number; oi?: number; prev_oi?: number; volume?: number; bid_price?: number; ask_price?: number }; option_greeks?: { delta?: number; iv?: number } } }
const API = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const symbols = [{ id: 'NIFTY', label: 'NIFTY 50', short: 'NIFTY' }, { id: 'BANKNIFTY', label: 'BANK NIFTY', short: 'BANKNIFTY' }, { id: 'INDIA_VIX', label: 'INDIA VIX', short: 'VIX' }]
const modules = ['Overview', 'Futures', 'Option Chain', 'OI Analytics', 'Technicals', 'Strategy Lab']
const chartSettingsKey = 'tradely-chart-settings'
const defaultChartIndicators: ChartIndicators = { ema50: true, ema100: true, ema200: true, rsi: true, vwap: true, supertrend: true }
const defaultSupertrend: SupertrendSettings = { period: 10, multiplier: 3 }
const empty = (): Dashboard => ({ mode: 'demo', status: 'connecting', asOf: null, indices: {}, bankStocks: {}, technicals: {}, message: 'Connecting to your private market data gateway…' })
const fmt = (v?: number | null, digits = 2) => v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const ago = (iso?: string | null) => { if (!iso) return '—'; const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000)); return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago` }

function readChartSettings(): { symbol: string; indicators: ChartIndicators; timeframe: ChartTimeframe; supertrend: SupertrendSettings } {
  const defaults = { symbol: 'NIFTY', indicators: defaultChartIndicators, timeframe: '15m' as ChartTimeframe, supertrend: defaultSupertrend }
  try {
    const stored = localStorage.getItem(chartSettingsKey)
    if (!stored) return defaults
    const parsed: unknown = JSON.parse(stored)
    if (typeof parsed !== 'object' || parsed === null) return defaults
    const settings = parsed as Record<string, unknown>
    const symbol = typeof settings.symbol === 'string' && symbols.some(item => item.id === settings.symbol) ? settings.symbol : defaults.symbol
    const savedIndicators = typeof settings.indicators === 'object' && settings.indicators !== null
      ? settings.indicators as Record<string, unknown>
      : {}
    const savedSupertrend = typeof settings.supertrend === 'object' && settings.supertrend !== null
      ? settings.supertrend as Record<string, unknown>
      : {}
    const savedTimeframe = typeof settings.timeframe === 'string' && chartTimeframes.some(option => option.value === settings.timeframe)
      ? settings.timeframe as ChartTimeframe
      : defaults.timeframe
    return {
      symbol,
      timeframe: savedTimeframe,
      supertrend: {
        period: typeof savedSupertrend.period === 'number' && Number.isFinite(savedSupertrend.period)
          ? Math.min(100, Math.max(1, Math.round(savedSupertrend.period)))
          : defaultSupertrend.period,
        multiplier: typeof savedSupertrend.multiplier === 'number' && Number.isFinite(savedSupertrend.multiplier)
          ? Math.min(10, Math.max(0.1, Math.round(savedSupertrend.multiplier * 10) / 10))
          : defaultSupertrend.multiplier,
      },
      indicators: {
        ema50: typeof savedIndicators.ema50 === 'boolean' ? savedIndicators.ema50 : defaultChartIndicators.ema50,
        ema100: typeof savedIndicators.ema100 === 'boolean' ? savedIndicators.ema100 : defaultChartIndicators.ema100,
        ema200: typeof savedIndicators.ema200 === 'boolean' ? savedIndicators.ema200 : defaultChartIndicators.ema200,
        rsi: typeof savedIndicators.rsi === 'boolean' ? savedIndicators.rsi : defaultChartIndicators.rsi,
        vwap: typeof savedIndicators.vwap === 'boolean' ? savedIndicators.vwap : defaultChartIndicators.vwap,
        supertrend: typeof savedIndicators.supertrend === 'boolean' ? savedIndicators.supertrend : defaultChartIndicators.supertrend,
      },
    }
  } catch (error) {
    console.warn('Unable to read saved chart settings from this browser.', error)
    return defaults
  }
}

function App() {
  const [password, setPassword] = useState(() => sessionStorage.getItem('tradely-password') || '')
  const [passwordDraft, setPasswordDraft] = useState('')
  const [showAccess, setShowAccess] = useState(!sessionStorage.getItem('tradely-password'))
  const [data, setData] = useState<Dashboard>(empty)
  const [chartSettings, setChartSettings] = useState(readChartSettings)
  const selected = chartSettings.symbol
  const [module, setModule] = useState('Overview')
  const [chain, setChain] = useState<ChainRow[]>([])
  const [futures, setFutures] = useState<FutureRow[]>([])
  const [candles, setCandles] = useState<Candle[]>([])
  const [chartCandles, setChartCandles] = useState<Candle[]>([])
  const [chartLoading, setChartLoading] = useState(false)
  const [chartError, setChartError] = useState('')
  const [chartSaveError, setChartSaveError] = useState('')
  const [candlesLoading, setCandlesLoading] = useState(false)
  const [candlesError, setCandlesError] = useState('')
  const [showAllStrikes, setShowAllStrikes] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => localStorage.getItem('tradely-theme') === 'light' ? 'light' : 'dark')
  const [futuresLoading, setFuturesLoading] = useState(false)
  const [futuresError, setFuturesError] = useState('')
  const [expiry, setExpiry] = useState('current_month')
  const [chainLoading, setChainLoading] = useState(false)
  const [chainError, setChainError] = useState('')
  const [lastMessage, setLastMessage] = useState<number | null>(null)
  const [, setClockTick] = useState(Date.now())
  const [socketState, setSocketState] = useState('connecting')
  const [reconnectKey, setReconnectKey] = useState(0)
  const quote = data.indices[selected]
  const fresh = lastMessage !== null && Date.now() - lastMessage < 45000
  const status = fresh ? (data.status === 'connected' ? 'connected' : data.status) : (data.status === 'connected' ? 'stale' : data.status)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('tradely-theme', theme)
  }, [theme])

  useEffect(() => {
    try {
      localStorage.setItem(chartSettingsKey, JSON.stringify(chartSettings))
      setChartSaveError('')
    } catch (error) {
      console.error('Unable to save chart settings in this browser.', error)
      setChartSaveError('Chart settings could not be saved in this browser.')
    }
  }, [chartSettings])

  useEffect(() => {
    const timer = window.setInterval(() => setClockTick(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const loadDashboard = useCallback(async (key = password) => {
    if (!key) return
    try {
      const res = await fetch(`${API}/api/dashboard`, { headers: { 'X-Dashboard-Password': key } })
      if (res.status === 401) { setShowAccess(true); setData({ ...empty(), status: 'locked' }); return }
      if (!res.ok) {
        const body = await res.json() as { detail?: unknown }
        const detail = typeof body.detail === 'string' ? body.detail : `Dashboard API returned HTTP ${res.status}.`
        const message = res.status === 503 && detail === 'Dashboard password is not configured'
          ? 'Dashboard password is not configured. Set DASHBOARD_PASSWORD in the repository-root .env file, then restart the backend.'
          : detail
        setData({ ...empty(), status: 'upstream_error', message })
        return
      }
      const body = await res.json() as Partial<Dashboard>
      setData({ ...empty(), ...body, indices: body.indices || {}, bankStocks: body.bankStocks || {}, technicals: body.technicals || {} })
      setLastMessage(Date.now())
    } catch { setData(prev => ({ ...prev, status: 'offline', message: 'API is not reachable. It may be waking from the free-tier sleep state.' })) }
  }, [password])

  useEffect(() => {
    if (!password) return
    void loadDashboard()
    let retry = 1000, stopped = false, timer: number | undefined
    let ws: WebSocket | undefined
    const connect = () => {
      if (stopped) return
      const scheme = API.startsWith('https:') ? 'wss:' : API.startsWith('http:') ? 'ws:' : location.protocol === 'https:' ? 'wss:' : 'ws:'
      const host = API ? API.replace(/^https?:/, '') : location.host
      ws = new WebSocket(`${scheme}//${host}/ws`)
      ws.onopen = () => { retry = 1000; setSocketState('connected'); ws?.send(JSON.stringify({ password })) }
      ws.onmessage = event => { try { setData(JSON.parse(event.data) as Dashboard); setLastMessage(Date.now()) } catch { /* ignore malformed frame */ } }
      ws.onerror = () => setSocketState('reconnecting')
      ws.onclose = () => { setSocketState('reconnecting'); if (!stopped) { timer = window.setTimeout(connect, retry); retry = Math.min(retry * 2, 30000) } }
    }
    connect()
    return () => { stopped = true; if (timer) clearTimeout(timer); ws?.close() }
  }, [password, reconnectKey, loadDashboard])

  useEffect(() => {
    if (!['Option Chain', 'OI Analytics', 'Strategy Lab'].includes(module) || selected === 'INDIA_VIX' || !password) { setChain([]); return }
    let live = true
    setChainLoading(true); setChainError('')
    fetch(`${API}/api/option-chain/${selected}?expiry=${expiry}`, { headers: { 'X-Dashboard-Password': password } })
      .then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.detail || 'Could not load option chain'); return j })
      .then(j => { if (live) setChain(j.rows || []) })
      .catch(e => { if (live) { setChain([]); setChainError(e.message) } })
      .finally(() => { if (live) setChainLoading(false) })
    return () => { live = false }
  }, [module, selected, expiry, password])

  useEffect(() => {
    if (!['Technicals', 'Strategy Lab'].includes(module) || !password || selected === 'INDIA_VIX') { setCandles([]); return }
    let live = true
    setCandlesLoading(true); setCandlesError('')
    fetch(`${API}/api/candles/${selected}?timeframe=daily`, { headers: { 'X-Dashboard-Password': password } })
      .then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.detail || 'Could not load candle history'); return j })
      .then(j => { if (live) setCandles(j.candles || []) })
      .catch(e => { if (live) { setCandles([]); setCandlesError(e.message) } })
      .finally(() => { if (live) setCandlesLoading(false) })
    return () => { live = false }
  }, [module, selected, password])

  useEffect(() => {
    if (module !== 'Overview' || !password) {
      setChartCandles([])
      setChartError('')
      setChartLoading(false)
      return
    }
    const controller = new AbortController()
    let live = true
    setChartLoading(true)
    setChartError('')
    fetch(`${API}/api/candles/${selected}?timeframe=${chartSettings.timeframe}`, {
      headers: { 'X-Dashboard-Password': password },
      signal: controller.signal,
    })
      .then(async response => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.detail || 'Could not load chart candles')
        return body as { candles?: Candle[] }
      })
      .then(body => { if (live) setChartCandles(body.candles || []) })
      .catch(reason => {
        if (live && !controller.signal.aborted) {
          setChartCandles([])
          setChartError(reason instanceof Error ? reason.message : 'Could not load chart candles')
        }
      })
      .finally(() => { if (live) setChartLoading(false) })
    return () => { live = false; controller.abort() }
  }, [module, selected, password, chartSettings.timeframe])

  useEffect(() => {
    if (module !== 'Futures' || !password) return
    let live = true
    setFuturesLoading(true); setFuturesError('')
    fetch(`${API}/api/futures`, { headers: { 'X-Dashboard-Password': password } })
      .then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.detail || 'Could not load futures'); return j })
      .then(j => { if (live) setFutures(j.rows || []) })
      .catch(e => { if (live) { setFutures([]); setFuturesError(e.message) } })
      .finally(() => { if (live) setFuturesLoading(false) })
    return () => { live = false }
  }, [module, password])
  const chainStats = useMemo(() => chain.reduce((acc, row) => { const call = row.call_options?.market_data, put = row.put_options?.market_data; acc.call += call?.oi || 0; acc.put += put?.oi || 0; if (call?.oi != null && call.prev_oi != null) { acc.callChange += call.oi - call.prev_oi; acc.callChangeCount += 1 } if (put?.oi != null && put.prev_oi != null) { acc.putChange += put.oi - put.prev_oi; acc.putChangeCount += 1 } return acc }, { call: 0, put: 0, callChange: 0, putChange: 0, callChangeCount: 0, putChangeCount: 0 }), [chain])
  const pcr = chainStats.call ? chainStats.put / chainStats.call : null
  const indicators = useMemo(() => calculateIndicators(candles), [candles])
  const selectSymbol = (id: string) => setChartSettings(current => ({ ...current, symbol: id }))
  const updateChartIndicators = (indicators: ChartIndicators) => setChartSettings(current => ({ ...current, indicators }))
  const updateChartTimeframe = (timeframe: ChartTimeframe) => setChartSettings(current => ({ ...current, timeframe }))
  const updateSupertrend = (supertrend: SupertrendSettings) => setChartSettings(current => ({ ...current, supertrend }))
  const unlock = (e: React.FormEvent) => { e.preventDefault(); if (!passwordDraft.trim()) return; sessionStorage.setItem('tradely-password', passwordDraft); setPassword(passwordDraft); setShowAccess(false); setPasswordDraft('') }
  const lock = () => { sessionStorage.removeItem('tradely-password'); setPassword(''); setShowAccess(true); setData(empty()) }

  return <div className="app-shell">
    <aside className="rail"><div className="brand-mark">T<span>.</span></div><button className="rail-item active" title="Terminal"><Activity size={18}/></button><button className="rail-item" title="Analytics"><BarChart3 size={18}/></button><button className="rail-item" title="Layouts"><Layers3 size={18}/></button><div className="rail-bottom"><button className="rail-item" title="Security"><ShieldCheck size={18}/></button><button className="rail-item" title="Settings"><Settings2 size={18}/></button><div className="avatar">T</div></div></aside>
    <main className="main-area">
      <header className="topbar"><div className="crumb"><span className="crumb-muted">WORKSPACE</span><span className="slash">/</span><strong>INDEX TERMINAL</strong><span className="private-badge"><LockKeyhole size={11}/> PRIVATE</span></div><div className="top-actions"><div className="market-clock"><span className="clock-dot"/> NSE <span>•</span> {new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())} IST</div><button className="icon-btn" title="Search"><Search size={16}/></button><button className="icon-btn" title="Notifications"><Bell size={16}/><i/></button><button className="theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>{theme === 'dark' ? <Sun size={14}/> : <Moon size={14}/>}<span>{theme === 'dark' ? 'Light' : 'Dark'}</span></button><button className="profile" onClick={lock} title="Lock dashboard">S</button></div></header>
      <section className="heading-row"><div><div className="eyebrow"><span className="eyebrow-line"/> MARKET INTELLIGENCE <span className="eyebrow-date">{new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date()).toUpperCase()}</span></div><h1>Index Terminal</h1><p className="subtitle">A focused view of the Indian index derivatives market.</p></div><div className="heading-controls"><button className="session-pill"><span className="session-dot"/> {status === 'connected' ? 'Market session' : 'Session monitor'} <ChevronDown size={14}/></button><button className="refresh-btn" onClick={() => { void loadDashboard(); setReconnectKey(k => k + 1) }}><RefreshCw size={14}/> Refresh</button></div></section>
      <div className={`connection-banner ${status === 'connected' ? 'good' : status === 'stale' ? 'warn' : ''}`}><div className="conn-left"><span className="conn-icon">{status === 'connected' ? <Wifi size={14}/> : status === 'stale' ? <Clock3 size={14}/> : <WifiOff size={14}/>}</span><div><strong>{status === 'connected' ? 'Snapshot link established' : status === 'stale' ? 'Data is stale' : status === 'token_missing' ? 'Waiting for data configuration' : status === 'upstream_error' ? 'Upstream unavailable' : 'Connecting to data gateway'}</strong><span>{data.message || 'Authenticated API snapshots · No streaming feed entitlement assumed'}</span></div></div><div className="conn-right"><span className="conn-status"><i className={socketState === 'connected' ? 'green' : ''}/>{socketState === 'connected' ? 'SOCKET ONLINE' : 'RECONNECTING'}</span><span className="divider"/><span className="freshness">UPDATED {ago(data.asOf)}</span></div></div>
      <section className="index-strip">{symbols.map(s => { const q = data.indices[s.id], up = (q?.change || 0) >= 0; return <button onClick={() => selectSymbol(s.id)} className={`index-card ${selected === s.id ? 'selected' : ''}`} key={s.id}><div className="index-top"><span>{s.label}</span><span className={`mini-change ${q ? (up ? 'positive' : 'negative') : ''}`}>{q ? <>{up ? <ArrowUpRight size={12}/> : <ArrowDownRight size={12}/>} {fmt(Math.abs(q.change || 0), 2)}</> : <span className="awaiting">—</span>}</span></div><div className="index-bottom"><strong>{fmt(q?.lastPrice)}</strong><span className="sparkline">{q ? 'SNAPSHOT' : 'NO DATA'}</span></div></button> })}</section>
      <section className="bank-box panel"><div className="bank-box-head"><div><span className="eyebrow-small">BANK NIFTY CONSTITUENTS</span><h2>Top banking stocks</h2></div><span className="bank-box-note">Live quotes · no index weights implied</span></div><div className="bank-stock-grid">{Object.entries(data.bankStocks || {}).map(([id, stock]) => <div className="bank-stock" key={id}><div><strong>{stock.label}</strong><span>{id}</span></div><b>{fmt(stock.lastPrice)}</b><em className={(stock.change || 0) >= 0 ? 'up' : 'down'}>{stock.change == null ? '—' : `${stock.change >= 0 ? '+' : '−'}${fmt(Math.abs(stock.change))}`}</em></div>)}{!Object.keys(data.bankStocks || {}).length && <div className="bank-empty">Bank constituent quotes will appear when Upstox returns them.</div>}</div></section>      <nav className="module-tabs">{modules.map(m => <button className={module === m ? 'current' : ''} key={m} onClick={() => setModule(m)}>{m}{m === 'Option Chain' && <span className="tab-count">{chain.length || '—'}</span>}</button>)}</nav>
      <section className="content-grid">
        <div className="primary-column">
          {module === 'Option Chain' ? <OptionPanel selected={selected} chain={chain} loading={chainLoading} error={chainError} expiry={expiry} setExpiry={setExpiry} pcr={pcr} spot={quote?.lastPrice} showAll={showAllStrikes} setShowAll={setShowAllStrikes}/> : module === 'Futures' ? <FuturesPanel rows={futures} loading={futuresLoading} error={futuresError} spots={data.indices}/> : module === 'OI Analytics' ? <AnalyticsPanel chain={chain} spot={quote?.lastPrice} loading={chainLoading} error={chainError} callOi={chainStats.call} putOi={chainStats.put} pcr={pcr} callOiChange={chainStats.callChange} putOiChange={chainStats.putChange} callOiChangeCount={chainStats.callChangeCount} putOiChangeCount={chainStats.putChangeCount}/> : module === 'Technicals' ? <TechnicalsPanel quote={quote} data={data} indicators={indicators} candles={candles} loading={candlesLoading} error={candlesError}/> : module === 'Strategy Lab' ? <StrategyPanel quote={quote} candles={candles} indicators={indicators} candlesLoading={candlesLoading} candlesError={candlesError} chain={chain} chainLoading={chainLoading} chainError={chainError} selected={selected}/> : <OverviewPanel quote={quote} selected={selected} vix={data.indices.INDIA_VIX} candles={chartCandles} loading={chartLoading} error={chartError} indicators={chartSettings.indicators} onIndicatorsChange={updateChartIndicators} timeframe={chartSettings.timeframe} onTimeframeChange={updateChartTimeframe} supertrend={chartSettings.supertrend} onSupertrendChange={updateSupertrend} theme={theme} saveError={chartSaveError}/>}
        </div>
        <aside className="side-column"><div className="panel focus-card"><div className="panel-head"><div><span className="eyebrow-small">SELECTED INSTRUMENT</span><h3>{symbols.find(s => s.id === selected)?.label}</h3></div><button className="dots">•••</button></div><div className="focus-price">{fmt(quote?.lastPrice)}<span className={!quote ? 'muted' : (quote.change || 0) >= 0 ? 'up' : 'down'}>{quote ? `${(quote.change || 0) >= 0 ? '+' : '−'}${fmt(Math.abs(quote.change || 0))}` : 'Live quote unavailable'}</span></div><div className="focus-meta"><span><i/> {quote ? 'Snapshot received' : 'No live snapshot'}</span><span>{ago(quote?.timestamp || data.asOf)}</span></div><div className="focus-chart"><div className="chart-empty"><Activity size={18}/><span>{quote ? "Intraday chart needs candle history" : "No verified price history"}</span></div></div><div className="chart-axis"><span>SESSION OPEN</span><span>SNAPSHOT VIEW</span><span>NOW</span></div></div>
          <div className="panel quick-stats"><div className="panel-title-row"><h3>Session snapshot</h3><span className="tiny-live"><i/> DATA</span></div><div className="stat-row"><span>Open</span><strong>{fmt(quote?.ohlc?.open)}</strong></div><div className="stat-row"><span>High</span><strong>{fmt(quote?.ohlc?.high)}</strong></div><div className="stat-row"><span>Low</span><strong>{fmt(quote?.ohlc?.low)}</strong></div><div className="stat-row"><span>Volume</span><strong>{quote?.volume == null ? '—' : quote.volume.toLocaleString('en-IN')}</strong></div><div className="stat-row"><span>Open interest</span><strong>{quote?.oi == null ? '—' : quote.oi.toLocaleString('en-IN')}</strong></div></div>
          <div className="secure-note"><ShieldCheck size={15}/><span><strong>Private by design</strong><br/>Credentials stay server-side; this tab session is protected.</span></div>
        </aside>
      </section>
      <footer><span>TRADELY <b>INDEX TERMINAL</b> <span className="footer-version">v0.1.0</span></span><span><Signal size={12}/> SOURCE: UPSTOX API {data.mode === 'demo' ? '· EMPTY STATE' : '· SNAPSHOT MODE'} <span className="footer-sep">|</span> <span className="footer-lock"><LockKeyhole size={11}/> PRIVATE SESSION</span></span></footer>
    </main>
    {showAccess && <div className="modal-backdrop"><form className="access-modal" onSubmit={unlock}><button type="button" className="modal-close" onClick={() => password ? setShowAccess(false) : null}><X size={16}/></button><div className="modal-icon"><LockKeyhole size={21}/></div><span className="eyebrow-small">PRIVATE WORKSPACE</span><h2>Unlock your terminal</h2><p>Enter the dashboard password configured on your backend. It stays in this tab session only.</p><label htmlFor="pw">DASHBOARD PASSWORD</label><input id="pw" autoFocus type="password" autoComplete="current-password" value={passwordDraft} onChange={e => setPasswordDraft(e.target.value)} placeholder="••••••••••••"/><button className="unlock-btn" type="submit">Connect securely <ArrowUpRight size={15}/></button><span className="modal-foot"><ShieldCheck size={13}/> Never enter your Upstox token here.</span></form></div>}
  </div>
}

function OverviewPanel({ quote, selected, vix, candles, loading, error, indicators, onIndicatorsChange, timeframe, onTimeframeChange, supertrend, onSupertrendChange, theme, saveError }: {
  quote?: Quote
  selected: string
  vix?: Quote
  candles: Candle[]
  loading: boolean
  error: string
  indicators: ChartIndicators
  onIndicatorsChange: (indicators: ChartIndicators) => void
  timeframe: ChartTimeframe
  onTimeframeChange: (timeframe: ChartTimeframe) => void
  supertrend: SupertrendSettings
  onSupertrendChange: (settings: SupertrendSettings) => void
  theme: 'dark' | 'light'
  saveError: string
}) {
  const o = quote?.ohlc
  const label = symbols.find(symbol => symbol.id === selected)?.label || selected
  return <>
    <div className="panel overview-card">
      <div className="panel-heading">
        <div><span className="eyebrow-small">MARKET OVERVIEW</span><h2>Market chart</h2><p>Historical Upstox candles for {label}; choose the candle interval below.</p></div>
        <span className="period-chip"><Clock3 size={13}/> {chartTimeframes.find(option => option.value === timeframe)?.name.toUpperCase() || '15 MINUTES'}</span>
      </div>
      <MarketChart candles={candles} symbol={selected} label={label} indicators={indicators} onIndicatorsChange={onIndicatorsChange} timeframe={timeframe} onTimeframeChange={onTimeframeChange} supertrend={supertrend} onSupertrendChange={onSupertrendChange} loading={loading} error={error} theme={theme} saveError={saveError}/>
      <div className="overview-legend"><span><i className="legend-line"/> VERIFIED UPSTOX CANDLES</span><span>Indicator settings save in this browser</span></div>
    </div>
    <div className="overview-lower">
      <div className="panel metric-panel">
        <div className="panel-title-row"><h3>Session snapshot</h3><span className="unavailable-pill">{quote ? 'UPSTOX DATA' : 'NO DATA'}</span></div>
        <div className="snapshot-metrics"><div><span>OPEN</span><strong>{fmt(o?.open)}</strong></div><div><span>HIGH</span><strong>{fmt(o?.high)}</strong></div><div><span>LOW</span><strong>{fmt(o?.low)}</strong></div><div><span>CHANGE</span><strong className={(quote?.change || 0) >= 0 ? 'up' : 'down'}>{quote?.change == null ? '—' : `${quote.change >= 0 ? '+' : '−'}${fmt(Math.abs(quote.change))}`}</strong></div></div>
      </div>
      <div className="panel metric-panel">
        <div className="panel-title-row"><h3>India VIX</h3><span className="unavailable-pill">{vix ? 'SNAPSHOT' : 'NO DATA'}</span></div>
        <div className="vix-summary"><strong>{fmt(vix?.lastPrice)}</strong><span>{vix?.change == null ? 'Waiting for India VIX snapshot' : `${vix.change >= 0 ? '+' : '−'}${fmt(Math.abs(vix.change))} today`}</span></div>
      </div>
    </div>
  </>
}
function FuturesPanel({ rows, loading, error, spots }: { rows: FutureRow[]; loading: boolean; error: string; spots: Record<string, Quote> }) { const visibleRows = [...rows].sort((a,b) => (['NIFTY','BANKNIFTY'].indexOf(a.symbol) - ['NIFTY','BANKNIFTY'].indexOf(b.symbol))); return <div className="panel module-panel"><div className="panel-heading"><div><span className="eyebrow-small">DERIVATIVES</span><h2>Index futures</h2><p>Current month contract snapshots from Upstox instrument search and quotes.</p></div><span className="unavailable-pill">{loading ? 'LOADING' : error ? 'API ERROR' : rows.length ? 'SNAPSHOT' : 'NO DATA'}</span></div>{error && <div className="inline-error">{error}</div>}{loading ? <div className="futures-empty"><Layers3 size={24}/><strong>Finding current month contracts…</strong><span>Resolving live instrument keys and fetching verified quotes from Upstox.</span></div> : visibleRows.length ? <div className="table-scroll"><table className="futures-table"><thead><tr><th>CONTRACT</th><th>EXPIRY</th><th>FUTURES LTP</th><th>BASIS</th><th>OPEN INTEREST</th><th>OI CHANGE</th></tr></thead><tbody>{visibleRows.map(row => { const spot = spots[row.symbol]?.lastPrice; const basis = spot == null || row.lastPrice == null ? null : row.lastPrice - spot; const oiChange = row.oi == null || row.previousOi == null ? null : row.oi - row.previousOi; return <tr key={row.symbol}><td className="futures-contract">{row.tradingSymbol || row.symbol}</td><td>{row.expiry || '—'}</td><td>{fmt(row.lastPrice)}</td><td className={basis == null ? '' : basis >= 0 ? 'up' : 'down'}>{basis == null ? '—' : `${basis >= 0 ? '+' : '−'}${fmt(Math.abs(basis))}`}</td><td>{fmt(row.oi,0)}</td><td className={oiChange == null ? '' : oiChange >= 0 ? 'up' : 'down'}>{oiChange == null ? '—' : `${oiChange >= 0 ? '+' : '−'}${Math.abs(oiChange).toLocaleString('en-IN')}`}</td></tr> })}</tbody></table></div> : <div className="futures-empty"><Layers3 size={24}/><strong>{error ? 'Futures data unavailable' : 'No current month futures returned'}</strong><span>{error || 'Upstox returned no current contracts for these index symbols. Confirm the token entitlement and try again during market hours.'}</span></div>}</div> }
function OptionPanel({ selected, chain, loading, error, expiry, setExpiry, pcr, spot, showAll, setShowAll }: { selected: string; chain: ChainRow[]; loading: boolean; error: string; expiry: string; setExpiry: (v: string) => void; pcr: number | null; spot?: number | null; showAll: boolean; setShowAll: (v: boolean) => void }) { const sorted = [...chain].sort((a,b)=>(a.strike_price||0)-(b.strike_price||0)); const atmIndex = sorted.reduce((best,r,i)=>Math.abs((r.strike_price||0)-(spot||0))<Math.abs((sorted[best]?.strike_price||0)-(spot||0))?i:best,0); const visible = showAll || spot == null ? sorted : sorted.slice(Math.max(0,atmIndex-5),atmIndex+6); return <div className="panel chain-panel"><div className="panel-heading"><div><span className="eyebrow-small">DERIVATIVES</span><h2>Option chain</h2><p>{symbols.find(s => s.id === selected)?.label} calls and puts · official chain response</p></div><label className="expiry-select"><span>EXPIRY</span><button className="strike-toggle" type="button" onClick={()=>setShowAll(!showAll)}>{showAll ? 'ATM � 5' : 'Show all'}</button><select value={expiry} onChange={e => setExpiry(e.target.value)}><option value="current_week">Current week</option><option value="next_week">Next week</option><option value="current_month">Current month</option><option value="next_month">Next month</option></select><ChevronDown size={13}/></label></div><div className="chain-summary"><div><span>PUT / CALL OI</span><strong>{pcr == null ? '—' : fmt(pcr, 2)}</strong></div><div><span>CALL OPEN INTEREST</span><strong>{chain.length ? chain.reduce((n,r)=>n+(r.call_options?.market_data?.oi||0),0).toLocaleString('en-IN') : '—'}</strong></div><div><span>PUT OPEN INTEREST</span><strong>{chain.length ? chain.reduce((n,r)=>n+(r.put_options?.market_data?.oi||0),0).toLocaleString('en-IN') : '—'}</strong></div><div><span>STRIKES</span><strong>{chain.length || '—'}</strong></div></div>{error && <div className="inline-error">{error}</div>}<div className="table-scroll"><table className="chain-table"><thead><tr><th colSpan={4} className="call-head">CALLS</th><th className="strike-head">STRIKE</th><th colSpan={4} className="put-head">PUTS</th></tr><tr><th>OI</th><th>VOLUME</th><th>IV</th><th>LTP</th><th>PRICE</th><th>LTP</th><th>IV</th><th>VOLUME</th><th>OI</th></tr></thead><tbody>{loading ? <tr><td colSpan={9} className="table-empty">Loading verified option chain…</td></tr> : visible.length ? visible.map(r => <tr key={r.strike_price}><td>{fmt(r.call_options?.market_data?.oi,0)}</td><td>{fmt(r.call_options?.market_data?.volume,0)}</td><td>{fmt(r.call_options?.option_greeks?.iv,1)}</td><td>{fmt(r.call_options?.market_data?.ltp)}</td><td className="strike-cell">{fmt(r.strike_price,0)}</td><td>{fmt(r.put_options?.market_data?.ltp)}</td><td>{fmt(r.put_options?.option_greeks?.iv,1)}</td><td>{fmt(r.put_options?.market_data?.volume,0)}</td><td>{fmt(r.put_options?.market_data?.oi,0)}</td></tr>) : <tr><td colSpan={9} className="table-empty">{selected === 'INDIA_VIX' ? 'India VIX has no option chain.' : 'No live chain rows. Configure a valid token and try again.'}</td></tr>}</tbody></table></div><div className="chain-foot"><span><i/> Open interest and IV are shown only when returned by Upstox.</span><span>Snapshot · {visible.length ? `${visible.length} of ${chain.length} strikes` : 'No data'}</span></div></div> }

function AnalyticsPanel({ chain, spot, loading, error, callOi, putOi, pcr, callOiChange, putOiChange, callOiChangeCount, putOiChangeCount }: { chain: ChainRow[]; spot?: number | null; loading: boolean; error: string; callOi: number; putOi: number; pcr: number | null; callOiChange: number; putOiChange: number; callOiChangeCount: number; putOiChangeCount: number }) { const signed = (value: number) => `${value >= 0 ? '+' : '-'}${Math.abs(value).toLocaleString('en-IN')}`; return <div className="panel module-panel"><div className="panel-heading"><div><span className="eyebrow-small">POSITIONING</span><h2>Open interest analytics</h2><p>Computed only from the current option-chain response.</p></div><span className="period-chip"><Radio size={13}/> SNAPSHOT</span></div><div className="analytics-cards oi-analytics-cards"><div><span>PUT / CALL RATIO</span><strong>{pcr == null ? '-' : fmt(pcr,2)}</strong><small>Put OI / Call OI</small></div><div><span>CALL OI</span><strong>{chain.length ? callOi.toLocaleString('en-IN') : '-'}</strong><small>Across returned strikes</small></div><div><span>PUT OI</span><strong>{chain.length ? putOi.toLocaleString('en-IN') : '-'}</strong><small>Across returned strikes</small></div><div><span>CALL OI CHANGE</span><strong className={callOiChange >= 0 ? 'up' : 'down'}>{callOiChangeCount ? signed(callOiChange) : '-'}</strong><small>{callOiChangeCount ? `Previous OI available for ${callOiChangeCount} strikes` : 'Previous OI unavailable'}</small></div><div><span>PUT OI CHANGE</span><strong className={putOiChange >= 0 ? 'up' : 'down'}>{putOiChangeCount ? signed(putOiChange) : '-'}</strong><small>{putOiChangeCount ? `Previous OI available for ${putOiChangeCount} strikes` : 'Previous OI unavailable'}</small></div></div><OiChangeChart chain={chain} spot={spot} loading={loading} error={error}/></div> }

function TechnicalsPanel({ quote, data, indicators, candles, loading, error }: { quote?: Quote; data: Dashboard; indicators: Indicators; candles: Candle[]; loading: boolean; error: string }) { const o = quote?.ohlc; return <div className="panel module-panel"><div className="panel-heading"><div><span className="eyebrow-small">PRICE STRUCTURE � DAILY</span><h2>Technical indicators</h2><p>Calculated from verified Upstox daily candles � {candles.length} bars loaded.</p></div><span className="period-chip"><Clock3 size={13}/> DAILY</span></div>{error && <div className="inline-error">{error}</div>}<IndicatorCards indicators={indicators} loading={loading}/><div className="signal-explainer"><strong>How to read this</strong><span>EMA shows trend direction, RSI indicates momentum, MACD histogram shows momentum change, and Supertrend marks a volatility-based trend level. These are historical indicators, not predictions.</span></div><div className="snapshot-metrics technical-snapshot"><div><span>SESSION OPEN</span><strong>{fmt(o?.open)}</strong></div><div><span>SESSION HIGH</span><strong>{fmt(o?.high)}</strong></div><div><span>SESSION LOW</span><strong>{fmt(o?.low)}</strong></div><div><span>LAST SNAPSHOT</span><strong>{fmt(quote?.lastPrice)}</strong></div></div>{!candles.length && !loading && <div className="futures-empty"><Activity size={24}/><strong>{quote ? 'Candle history unavailable' : 'Waiting for verified OHLC data'}</strong><span>{error || data.message || 'This token may not have access to historical candles.'}</span></div>}</div> }

function IndicatorCards({ indicators, loading }: { indicators: Indicators; loading: boolean }) { const v=(n:number|null,d=2)=>n==null?'�':fmt(n,d); return <div className="analytics-cards indicator-cards"><div><span>EMA 20 / EMA 50</span><strong>{loading?'�':v(indicators.ema20)} / {v(indicators.ema50)}</strong><small>{indicators.ema20==null||indicators.ema50==null?'Need candle history':indicators.ema20>indicators.ema50?'Short trend above long trend':'Short trend below long trend'}</small></div><div><span>RSI � 14</span><strong>{loading?'�':v(indicators.rsi,1)}</strong><small>{indicators.rsi==null?'Need 15+ closes':indicators.rsi>=70?'Elevated momentum':indicators.rsi<=30?'Weak momentum':'Between 30 and 70'}</small></div><div><span>MACD HISTOGRAM</span><strong>{loading?'�':v(indicators.macdHist,2)}</strong><small>{indicators.macdHist==null?'Need 35+ closes':indicators.macdHist>=0?'Positive momentum':'Negative momentum'}</small></div><div><span>SUPERTREND � 10, 3</span><strong>{loading?'�':v(indicators.supertrend)}</strong><small>{indicators.supertrend==null?'Need candle history':indicators.supertrendUp?'Uptrend condition':'Downtrend condition'}</small></div></div> }

function StrategyPanel({ quote, candles, indicators, candlesLoading, candlesError, chain, chainLoading, chainError, selected }: { quote?: Quote; candles: Candle[]; indicators: Indicators; candlesLoading: boolean; candlesError: string; chain: ChainRow[]; chainLoading: boolean; chainError: string; selected: string }) { const spread = buildSpread(chain, quote?.lastPrice, indicators); const directional = indicators.ema20 == null || indicators.ema50 == null || indicators.supertrendUp == null ? 'Waiting for candle history' : indicators.ema20 > indicators.ema50 && indicators.supertrendUp ? 'Bullish trend confluence' : indicators.ema20 < indicators.ema50 && !indicators.supertrendUp ? 'Bearish trend confluence' : 'Mixed signals'; const entry=quote?.lastPrice??null; const stop=indicators.supertrend; const risk=entry!=null&&stop!=null?Math.abs(entry-stop):null; const target=entry!=null&&risk!=null?(indicators.supertrendUp?entry+2*risk:entry-2*risk):null; const hasSignal=directional.includes('confluence'); const bias=directional.startsWith('Bullish')?'Bull call debit spread':directional.startsWith('Bearish')?'Bear put debit spread':'No aligned spread setup'; return <div className="strategy-stack"><div className="panel module-panel"><div className="panel-heading"><div><span className="eyebrow-small">RULE-BASED RESEARCH � NOT AN ORDER</span><h2>Swing-trade context</h2><p>{symbols.find(s=>s.id===selected)?.label} � daily timeframe � {candles.length} candles.</p></div><span className="unavailable-pill">{candlesLoading?'LOADING':candles.length?'DAILY SIGNAL':'NO DATA'}</span></div>{candlesError&&<div className="inline-error">{candlesError}</div>}<IndicatorCards indicators={indicators} loading={candlesLoading}/><div className="swing-box"><span className="eyebrow-small">DIRECTIONAL FILTER</span><strong className={directional.startsWith('Bullish')?'up':directional.startsWith('Bearish')?'down':''}>{directional}</strong><div className="swing-levels"><span>Reference close <b>{fmt(entry)}</b></span><span>Supertrend level <b>{fmt(stop)}</b></span><span>2R reference target <b>{hasSignal?fmt(target):'�'}</b></span></div><small>{hasSignal?'Illustrative levels from current close and Supertrend distance; not an entry alert. Confirm liquidity, gap risk, and your own risk limits.':'A swing context appears only when EMA 20/50 and Supertrend agree.'}</small></div></div><div className="panel module-panel"><div className="panel-heading"><div><span className="eyebrow-small">LIVE OPTION QUOTES � {selected}</span><h2>Defined-risk spread candidates</h2><p>{bias} � prices use the current chain bid/ask, when available.</p></div><span className="unavailable-pill">{chainLoading?'LOADING':chain.length?'LIVE SNAPSHOT':'NO DATA'}</span></div>{chainError&&<div className="inline-error">{chainError}</div>}{spread ? <div className="spread-grid"><div className="spread-card"><div className="spread-title"><strong>{spread.label}</strong><span>{spread.bias}</span></div><div className="spread-legs"><span>Buy {spread.longType} {fmt(spread.longStrike,0)} @ ask <b>{fmt(spread.longAsk)}</b></span><span>Sell {spread.shortType} {fmt(spread.shortStrike,0)} @ bid <b>{fmt(spread.shortBid)}</b></span></div><div className="spread-values"><div><span>NET DEBIT / UNIT</span><b>{fmt(spread.debit)}</b></div><div><span>MAX LOSS / UNIT</span><b>{fmt(spread.debit)}</b></div><div><span>MAX GAIN / UNIT</span><b>{fmt(spread.maxGain)}</b></div><div><span>BREAKEVEN</span><b>{fmt(spread.breakeven)}</b></div></div><p>Per index point; lot size and charges not included. Quotes can change before execution.</p></div></div> : <div className="futures-empty"><Layers3 size={24}/><strong>{chainLoading?'Loading option quotes�':'Spread price unavailable'}</strong><span>{chainError||'Requires live bid/ask quotes for both legs. Select NIFTY or BANK NIFTY and load the option chain.'}</span></div>}<div className="win-rate-note"><strong>Win rate: not validated</strong><span>A defensible spread success rate needs historical option prices, realistic execution costs, and out-of-sample testing. This dashboard will not turn a rule score or an option Greek into a claimed win probability.</span></div><div className="strategy-disclaimer">Research context only. No machine-learning model or trading recommendation is active. A Gaussian model is not used because it has not been validated on this market and can give misleading probabilities.</div></div></div> }

function buildSpread(chain: ChainRow[], spot?: number | null, indicators?: Indicators) { if (!chain.length || spot==null) return null; const rows=[...chain].filter(r=>r.strike_price!=null).sort((a,b)=>(a.strike_price||0)-(b.strike_price||0)); if(rows.length<3)return null; const atm=rows.reduce((best,r,i)=>Math.abs((r.strike_price||0)-spot)<Math.abs((rows[best].strike_price||0)-spot)?i:best,0); const direction=indicators?.ema20!=null&&indicators.ema50!=null&&indicators.supertrendUp!=null&&indicators.ema20>indicators.ema50&&indicators.supertrendUp?'bull':indicators?.ema20!=null&&indicators.ema50!=null&&indicators.supertrendUp===false&&indicators.ema20<indicators.ema50?'bear':null; if(!direction)return null; const longRow=rows[atm], shortRow=rows[direction==='bull'?Math.min(rows.length-1,atm+3):Math.max(0,atm-3)]; if(longRow===shortRow)return null; const long=direction==='bull'?longRow.call_options:longRow.put_options, short=direction==='bull'?shortRow.call_options:shortRow.put_options; const ask=long?.market_data?.ask_price, bid=short?.market_data?.bid_price, width=Math.abs((longRow.strike_price||0)-(shortRow.strike_price||0)); if(ask==null||bid==null||ask<=bid)return null; const debit=ask-bid; if(debit>=width)return null; return {label:direction==='bull'?'Bull call debit spread':'Bear put debit spread',bias:direction==='bull'?'Bullish':'Bearish',longType:direction==='bull'?'CALL':'PUT',shortType:direction==='bull'?'CALL':'PUT',longStrike:longRow.strike_price||0,shortStrike:shortRow.strike_price||0,longAsk:ask,shortBid:bid,debit,maxGain:width-debit,breakeven:direction==='bull'?(longRow.strike_price||0)+debit:(longRow.strike_price||0)-debit}; }

function calculateIndicators(input: Candle[]): Indicators { const bars=[...input].sort((a,b)=>Date.parse(a[0])-Date.parse(b[0])); const closes=bars.map(c=>c[4]).filter(Number.isFinite); if(closes.length<2)return {ema20:null,ema50:null,rsi:null,macdHist:null,supertrend:null,supertrendUp:null}; const ema=(period:number)=>{if(closes.length<period)return null; const alpha=2/(period+1); let v=closes.slice(0,period).reduce((a,b)=>a+b,0)/period; for(const n of closes.slice(period))v=n*alpha+v*(1-alpha);return v}; const gains:number[]=[],losses:number[]=[]; for(let i=1;i<closes.length;i++){const d=closes[i]-closes[i-1];gains.push(Math.max(d,0));losses.push(Math.max(-d,0))} let rsi:number|null=null;if(gains.length>=14){let ag=gains.slice(0,14).reduce((a,b)=>a+b,0)/14,al=losses.slice(0,14).reduce((a,b)=>a+b,0)/14;for(let i=14;i<gains.length;i++){ag=(ag*13+gains[i])/14;al=(al*13+losses[i])/14}rsi=al===0?100:100-100/(1+ag/al)} const emaSeries=(period:number)=>{if(closes.length<period)return [] as number[];const alpha=2/(period+1);const out=Array(closes.length).fill(null) as (number|null)[];let v=closes.slice(0,period).reduce((a,b)=>a+b,0)/period;out[period-1]=v;for(let i=period;i<closes.length;i++){v=closes[i]*alpha+v*(1-alpha);out[i]=v}return out};const e12=emaSeries(12),e26=emaSeries(26);const macd=closes.map((_,i)=>e12[i]!=null&&e26[i]!=null?e12[i]!-e26[i]!:null);const m=macd.filter((x):x is number=>x!=null);let macdHist:number|null=null;if(m.length>=9){const a=2/10;let sig=m.slice(0,9).reduce((x,y)=>x+y,0)/9;for(const n of m.slice(9))sig=n*a+sig*(1-a);macdHist=m[m.length-1]-sig} let supertrend:number|null=null,supertrendUp:boolean|null=null;if(bars.length>=11){let trs:number[]=[];for(let i=1;i<bars.length;i++){const c=bars[i],prev=bars[i-1];trs.push(Math.max(c[2]-c[3],Math.abs(c[2]-prev[4]),Math.abs(c[3]-prev[4])))}let upper=0,lower=0,trend=true;for(let i=9;i<trs.length;i++){const atr=trs.slice(i-9,i+1).reduce((a,b)=>a+b,0)/10;const bar=bars[i+1],mid=(bar[2]+bar[3])/2;const basicU=mid+3*atr,basicL=mid-3*atr;upper=i===9?basicU:(basicU<upper||bars[i][4]>upper?basicU:upper);lower=i===9?basicL:(basicL>lower||bars[i][4]<lower?basicL:lower);if(trend&&bar[4]<lower)trend=false;else if(!trend&&bar[4]>upper)trend=true;supertrend=trend?lower:upper;supertrendUp=trend}} return {ema20:ema(20),ema50:ema(50),rsi,macdHist,supertrend,supertrendUp}; }
type Indicators = {ema20:number|null;ema50:number|null;rsi:number|null;macdHist:number|null;supertrend:number|null;supertrendUp:boolean|null}


export default App
