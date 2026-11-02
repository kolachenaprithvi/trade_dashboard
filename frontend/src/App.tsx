import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, ArrowDownRight, ArrowUpRight, BarChart3, Bell, ChevronDown, Clock3, Layers3, LockKeyhole, Radio, RefreshCw, Search, Settings2, ShieldCheck, Signal, Wifi, WifiOff, X } from 'lucide-react'

type Quote = { instrumentKey: string; lastPrice: number | null; change: number | null; volume?: number | null; oi?: number | null; timestamp?: string | null; ohlc?: Record<string, number> }
type Dashboard = { mode: string; status: string; asOf: string | null; indices: Record<string, Quote>; technicals: Record<string, unknown>; message: string | null; serverTime?: string }
type ChainRow = { strike_price?: number; call_options?: { market_data?: { ltp?: number; oi?: number; volume?: number; bid_price?: number; ask_price?: number }; option_greeks?: { delta?: number; iv?: number } }; put_options?: { market_data?: { ltp?: number; oi?: number; volume?: number; bid_price?: number; ask_price?: number }; option_greeks?: { delta?: number; iv?: number } } }
const API = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const symbols = [{ id: 'NIFTY', label: 'NIFTY 50', short: 'NIFTY' }, { id: 'BANKNIFTY', label: 'BANK NIFTY', short: 'BANKNIFTY' }, { id: 'FINNIFTY', label: 'FINNIFTY', short: 'FINNIFTY' }, { id: 'MIDCPNIFTY', label: 'MIDCPNIFTY', short: 'MIDCPNIFTY' }, { id: 'INDIA_VIX', label: 'INDIA VIX', short: 'VIX' }]
const modules = ['Overview', 'Futures', 'Option Chain', 'OI Analytics', 'Technicals']
const empty = (): Dashboard => ({ mode: 'demo', status: 'connecting', asOf: null, indices: {}, technicals: {}, message: 'Connecting to your private market data gateway…' })
const fmt = (v?: number | null, digits = 2) => v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const ago = (iso?: string | null) => { if (!iso) return '—'; const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000)); return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago` }

function App() {
  const [password, setPassword] = useState(() => sessionStorage.getItem('tradely-password') || '')
  const [passwordDraft, setPasswordDraft] = useState('')
  const [showAccess, setShowAccess] = useState(!sessionStorage.getItem('tradely-password'))
  const [data, setData] = useState<Dashboard>(empty)
  const [selected, setSelected] = useState('NIFTY')
  const [module, setModule] = useState('Overview')
  const [chain, setChain] = useState<ChainRow[]>([])
  const [expiry, setExpiry] = useState('current_week')
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
    const timer = window.setInterval(() => setClockTick(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const loadDashboard = useCallback(async (key = password) => {
    if (!key) return
    try {
      const res = await fetch(`${API}/api/dashboard`, { headers: { 'X-Dashboard-Password': key } })
      if (res.status === 401) { setShowAccess(true); setData({ ...empty(), status: 'locked' }); return }
      const body = await res.json() as Dashboard
      setData(body); setLastMessage(Date.now())
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
    if (module !== 'Option Chain' || selected === 'INDIA_VIX' || !password) { setChain([]); return }
    let live = true
    setChainLoading(true); setChainError('')
    fetch(`${API}/api/option-chain/${selected}?expiry=${expiry}`, { headers: { 'X-Dashboard-Password': password } })
      .then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.detail || 'Could not load option chain'); return j })
      .then(j => { if (live) setChain(j.rows || []) })
      .catch(e => { if (live) { setChain([]); setChainError(e.message) } })
      .finally(() => { if (live) setChainLoading(false) })
    return () => { live = false }
  }, [module, selected, expiry, password])

  const chainStats = useMemo(() => chain.reduce((acc, row) => { acc.call += row.call_options?.market_data?.oi || 0; acc.put += row.put_options?.market_data?.oi || 0; return acc }, { call: 0, put: 0 }), [chain])
  const pcr = chainStats.call ? chainStats.put / chainStats.call : null
  const selectSymbol = (id: string) => setSelected(id)
  const unlock = (e: React.FormEvent) => { e.preventDefault(); if (!passwordDraft.trim()) return; sessionStorage.setItem('tradely-password', passwordDraft); setPassword(passwordDraft); setShowAccess(false); setPasswordDraft('') }
  const lock = () => { sessionStorage.removeItem('tradely-password'); setPassword(''); setShowAccess(true); setData(empty()) }

  return <div className="app-shell">
    <aside className="rail"><div className="brand-mark">T<span>.</span></div><button className="rail-item active" title="Terminal"><Activity size={18}/></button><button className="rail-item" title="Analytics"><BarChart3 size={18}/></button><button className="rail-item" title="Layouts"><Layers3 size={18}/></button><div className="rail-bottom"><button className="rail-item" title="Security"><ShieldCheck size={18}/></button><button className="rail-item" title="Settings"><Settings2 size={18}/></button><div className="avatar">T</div></div></aside>
    <main className="main-area">
      <header className="topbar"><div className="crumb"><span className="crumb-muted">WORKSPACE</span><span className="slash">/</span><strong>INDEX TERMINAL</strong><span className="private-badge"><LockKeyhole size={11}/> PRIVATE</span></div><div className="top-actions"><div className="market-clock"><span className="clock-dot"/> NSE <span>•</span> {new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())} IST</div><button className="icon-btn" title="Search"><Search size={16}/></button><button className="icon-btn" title="Notifications"><Bell size={16}/><i/></button><button className="profile" onClick={lock} title="Lock dashboard">S</button></div></header>
      <section className="heading-row"><div><div className="eyebrow"><span className="eyebrow-line"/> MARKET INTELLIGENCE <span className="eyebrow-date">{new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date()).toUpperCase()}</span></div><h1>Index Terminal</h1><p className="subtitle">A focused view of the Indian index derivatives market.</p></div><div className="heading-controls"><button className="session-pill"><span className="session-dot"/> {status === 'connected' ? 'Market session' : 'Session monitor'} <ChevronDown size={14}/></button><button className="refresh-btn" onClick={() => { void loadDashboard(); setReconnectKey(k => k + 1) }}><RefreshCw size={14}/> Refresh</button></div></section>
      <div className={`connection-banner ${status === 'connected' ? 'good' : status === 'stale' ? 'warn' : ''}`}><div className="conn-left"><span className="conn-icon">{status === 'connected' ? <Wifi size={14}/> : status === 'stale' ? <Clock3 size={14}/> : <WifiOff size={14}/>}</span><div><strong>{status === 'connected' ? 'Snapshot link established' : status === 'stale' ? 'Data is stale' : status === 'token_missing' ? 'Waiting for data configuration' : status === 'upstream_error' ? 'Upstream unavailable' : 'Connecting to data gateway'}</strong><span>{data.message || 'Authenticated API snapshots · No streaming feed entitlement assumed'}</span></div></div><div className="conn-right"><span className="conn-status"><i className={socketState === 'connected' ? 'green' : ''}/>{socketState === 'connected' ? 'SOCKET ONLINE' : 'RECONNECTING'}</span><span className="divider"/><span className="freshness">UPDATED {ago(data.asOf)}</span></div></div>
      <section className="index-strip">{symbols.map(s => { const q = data.indices[s.id], up = (q?.change || 0) >= 0; return <button onClick={() => selectSymbol(s.id)} className={`index-card ${selected === s.id ? 'selected' : ''}`} key={s.id}><div className="index-top"><span>{s.label}</span><span className={`mini-change ${q ? (up ? 'positive' : 'negative') : ''}`}>{q ? <>{up ? <ArrowUpRight size={12}/> : <ArrowDownRight size={12}/>} {fmt(Math.abs(q.change || 0), 2)}</> : <span className="awaiting">—</span>}</span></div><div className="index-bottom"><strong>{fmt(q?.lastPrice)}</strong><span className="sparkline">{q ? 'SNAPSHOT' : 'NO DATA'}</span></div></button> })}</section>
      <nav className="module-tabs">{modules.map(m => <button className={module === m ? 'current' : ''} key={m} onClick={() => setModule(m)}>{m}{m === 'Option Chain' && <span className="tab-count">{chain.length || '—'}</span>}</button>)}</nav>
      <section className="content-grid">
        <div className="primary-column">
          {module === 'Option Chain' ? <OptionPanel selected={selected} chain={chain} loading={chainLoading} error={chainError} expiry={expiry} setExpiry={setExpiry} pcr={pcr}/> : module === 'Futures' ? <FuturesPanel/> : module === 'OI Analytics' ? <AnalyticsPanel chain={chain} callOi={chainStats.call} putOi={chainStats.put} pcr={pcr}/> : module === 'Technicals' ? <TechnicalsPanel quote={quote} data={data}/> : <OverviewPanel quote={quote} selected={selected}/>}
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

function OverviewPanel({ quote, selected }: { quote?: Quote; selected: string }) { return <><div className="panel overview-card"><div className="panel-heading"><div><span className="eyebrow-small">MARKET OVERVIEW</span><h2>Intraday pulse</h2><p>Verified exchange snapshot for {symbols.find(s => s.id === selected)?.label}.</p></div><span className="period-chip"><Clock3 size={13}/> CURRENT SESSION <ChevronDown size={12}/></span></div><div className="pulse-chart"><div className="chart-grid-lines"><i/><i/><i/><i/></div><div className="no-chart"><Activity size={20}/><strong>{quote ? "Snapshot received · price history unavailable" : "Waiting for a verified quote"}</strong><span>{quote ? "Historical candles are required to draw an intraday chart." : "Connect the server-side Upstox token to populate this panel."}</span></div></div><div className="overview-legend"><span><i className="legend-line"/> INDEX SNAPSHOT</span><span>Price values are shown only when returned by Upstox</span></div></div><div className="overview-lower"><div className="panel metric-panel"><div className="panel-title-row"><h3>Market breadth</h3><span className="unavailable-pill">NOT AVAILABLE</span></div><div className="empty-graphic"><BarChart3 size={18}/><span>Connect an entitled source to display breadth.</span></div></div><div className="panel metric-panel"><div className="panel-title-row"><h3>Volatility regime</h3><span className="unavailable-pill">VIX SNAPSHOT</span></div><div className="empty-graphic compact"><span className="vix-value">—</span><span>Waiting for India VIX snapshot</span></div></div></div></> }

function FuturesPanel() { return <div className="panel module-panel"><div className="panel-heading"><div><span className="eyebrow-small">DERIVATIVES</span><h2>Index futures</h2><p>Front-month and next-month contract metrics.</p></div><span className="unavailable-pill">CONTRACT MAPPING REQUIRED</span></div><div className="futures-empty"><Layers3 size={24}/><strong>Futures data is not configured</strong><span>Instrument discovery and an entitled market-data feed are required before displaying futures prices, basis, rollover, or OI change.</span><div className="empty-table"><span>CONTRACT</span><span>LAST PRICE</span><span>BASIS</span><span>OI CHANGE</span><b>—</b><b>—</b><b>—</b><b>—</b></div></div></div> }

function OptionPanel({ selected, chain, loading, error, expiry, setExpiry, pcr }: { selected: string; chain: ChainRow[]; loading: boolean; error: string; expiry: string; setExpiry: (v: string) => void; pcr: number | null }) { return <div className="panel chain-panel"><div className="panel-heading"><div><span className="eyebrow-small">DERIVATIVES</span><h2>Option chain</h2><p>{symbols.find(s => s.id === selected)?.label} calls and puts · official chain response</p></div><label className="expiry-select"><span>EXPIRY</span><select value={expiry} onChange={e => setExpiry(e.target.value)}><option value="current_week">Current week</option><option value="next_week">Next week</option><option value="current_month">Current month</option><option value="next_month">Next month</option></select><ChevronDown size={13}/></label></div><div className="chain-summary"><div><span>PUT / CALL OI</span><strong>{pcr == null ? '—' : fmt(pcr, 2)}</strong></div><div><span>CALL OPEN INTEREST</span><strong>{chain.length ? chain.reduce((n,r)=>n+(r.call_options?.market_data?.oi||0),0).toLocaleString('en-IN') : '—'}</strong></div><div><span>PUT OPEN INTEREST</span><strong>{chain.length ? chain.reduce((n,r)=>n+(r.put_options?.market_data?.oi||0),0).toLocaleString('en-IN') : '—'}</strong></div><div><span>STRIKES</span><strong>{chain.length || '—'}</strong></div></div>{error && <div className="inline-error">{error}</div>}<div className="table-scroll"><table className="chain-table"><thead><tr><th colSpan={4} className="call-head">CALLS</th><th className="strike-head">STRIKE</th><th colSpan={4} className="put-head">PUTS</th></tr><tr><th>OI</th><th>VOLUME</th><th>IV</th><th>LTP</th><th>PRICE</th><th>LTP</th><th>IV</th><th>VOLUME</th><th>OI</th></tr></thead><tbody>{loading ? <tr><td colSpan={9} className="table-empty">Loading verified option chain…</td></tr> : chain.length ? chain.map(r => <tr key={r.strike_price}><td>{fmt(r.call_options?.market_data?.oi,0)}</td><td>{fmt(r.call_options?.market_data?.volume,0)}</td><td>{fmt(r.call_options?.option_greeks?.iv,1)}</td><td>{fmt(r.call_options?.market_data?.ltp)}</td><td className="strike-cell">{fmt(r.strike_price,0)}</td><td>{fmt(r.put_options?.market_data?.ltp)}</td><td>{fmt(r.put_options?.option_greeks?.iv,1)}</td><td>{fmt(r.put_options?.market_data?.volume,0)}</td><td>{fmt(r.put_options?.market_data?.oi,0)}</td></tr>) : <tr><td colSpan={9} className="table-empty">{selected === 'INDIA_VIX' ? 'India VIX has no option chain.' : 'No live chain rows. Configure a valid token and try again.'}</td></tr>}</tbody></table></div><div className="chain-foot"><span><i/> Open interest and IV are shown only when returned by Upstox.</span><span>Snapshot · {chain.length ? `${chain.length} strikes` : 'No data'}</span></div></div> }

function AnalyticsPanel({ chain, callOi, putOi, pcr }: { chain: ChainRow[]; callOi: number; putOi: number; pcr: number | null }) { return <div className="panel module-panel"><div className="panel-heading"><div><span className="eyebrow-small">POSITIONING</span><h2>Open interest analytics</h2><p>Computed only from the current option-chain response.</p></div><span className="period-chip"><Radio size={13}/> SNAPSHOT</span></div><div className="analytics-cards"><div><span>PUT / CALL RATIO</span><strong>{pcr == null ? '—' : fmt(pcr,2)}</strong><small>Put OI ÷ Call OI</small></div><div><span>CALL OI</span><strong>{chain.length ? callOi.toLocaleString('en-IN') : '—'}</strong><small>Across returned strikes</small></div><div><span>PUT OI</span><strong>{chain.length ? putOi.toLocaleString('en-IN') : '—'}</strong><small>Across returned strikes</small></div></div><div className="futures-empty"><BarChart3 size={24}/><strong>{chain.length ? 'Strike-level OI distribution' : 'Waiting for option chain'}</strong><span>{chain.length ? 'Use Option Chain to inspect returned strikes. Change in OI and max pain history need timestamped snapshots.' : 'Load a live option chain to calculate current PCR and open interest totals.'}</span></div></div> }

function TechnicalsPanel({ quote, data }: { quote?: Quote; data: Dashboard }) { const o = quote?.ohlc; return <div className="panel module-panel"><div className="panel-heading"><div><span className="eyebrow-small">PRICE STRUCTURE</span><h2>Technicals</h2><p>Daily OHLC snapshot, without inferred indicators.</p></div><span className="period-chip"><Clock3 size={13}/> DAILY</span></div><div className="analytics-cards"><div><span>OPEN</span><strong>{fmt(o?.open)}</strong><small>Session open</small></div><div><span>HIGH</span><strong>{fmt(o?.high)}</strong><small>Session high</small></div><div><span>LOW</span><strong>{fmt(o?.low)}</strong><small>Session low</small></div></div><div className="futures-empty"><Activity size={24}/><strong>{quote ? 'Indicator history not loaded' : 'Waiting for verified OHLC data'}</strong><span>{quote ? 'Moving averages, RSI, VWAP, and ATR need candle-history data. No indicator values are inferred from a single snapshot.' : (data.message || 'A valid data connection is needed.')}</span></div></div> }

export default App
