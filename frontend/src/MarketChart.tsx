import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  LineStyle,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Time,
  type UTCTimestamp,
  type WhitespaceData,
} from 'lightweight-charts'
import { Maximize2, Minimize2 } from 'lucide-react'

export type MarketCandle = [string, number, number, number, number, number, number]
export type ChartIndicators = { ema50: boolean; ema100: boolean; ema200: boolean; rsi: boolean; vwap: boolean; supertrend: boolean }
export type ChartTimeframe = '1m' | '3m' | '5m' | '10m' | '15m' | '30m' | '1h' | '2h' | '3h' | '4h' | '1d' | '1w' | '1mo' | '1y'
export type SupertrendSettings = { period: number; multiplier: number }

export const chartTimeframes: Array<{ value: ChartTimeframe; label: string; name: string }> = [
  { value: '1m', label: '1m', name: '1 minute' },
  { value: '3m', label: '3m', name: '3 minutes' },
  { value: '5m', label: '5m', name: '5 minutes' },
  { value: '10m', label: '10m', name: '10 minutes' },
  { value: '15m', label: '15m', name: '15 minutes' },
  { value: '30m', label: '30m', name: '30 minutes' },
  { value: '1h', label: '1h', name: '1 hour' },
  { value: '2h', label: '2h', name: '2 hours' },
  { value: '3h', label: '3h', name: '3 hours' },
  { value: '4h', label: '4h', name: '4 hours' },
  { value: '1d', label: '1D', name: '1 day' },
  { value: '1w', label: '1W', name: '1 week' },
  { value: '1mo', label: '1M', name: '1 month' },
  { value: '1y', label: '1Y', name: '1 year' },
]

const indicatorOptions: Array<{ key: keyof ChartIndicators; label: string }> = [
  { key: 'ema50', label: 'EMA 50' },
  { key: 'ema100', label: 'EMA 100' },
  { key: 'ema200', label: 'EMA 200' },
  { key: 'rsi', label: 'RSI' },
  { key: 'vwap', label: 'VWAP' },
  { key: 'supertrend', label: 'Supertrend' },
]

type Bar = { time: UTCTimestamp; open: number; high: number; low: number; close: number; volume: number }
type OverlayData = {
  ema50: LineData<Time>[]
  ema100: LineData<Time>[]
  ema200: LineData<Time>[]
  rsi: LineData<Time>[]
  vwap: LineData<Time>[]
  supertrendUp: Array<LineData<Time> | WhitespaceData<Time>>
  supertrendDown: Array<LineData<Time> | WhitespaceData<Time>>
}

function calculateRsi(bars: Bar[], period = 14): Array<number | null> {
  const values: Array<number | null> = Array(bars.length).fill(null)
  if (bars.length <= period) return values

  let averageGain = 0
  let averageLoss = 0
  for (let index = 1; index <= period; index += 1) {
    const change = bars[index].close - bars[index - 1].close
    averageGain += Math.max(change, 0)
    averageLoss += Math.max(-change, 0)
  }
  averageGain /= period
  averageLoss /= period
  values[period] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss)
  for (let index = period + 1; index < bars.length; index += 1) {
    const change = bars[index].close - bars[index - 1].close
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period
    values[index] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss)
  }
  return values
}

function calculateEma(bars: Bar[], period: number): Array<number | null> {
  const values: Array<number | null> = Array(bars.length).fill(null)
  if (bars.length < period) return values

  const alpha = 2 / (period + 1)
  let average = bars.slice(0, period).reduce((sum, bar) => sum + bar.close, 0) / period
  values[period - 1] = average
  for (let index = period; index < bars.length; index += 1) {
    average = bars[index].close * alpha + average * (1 - alpha)
    values[index] = average
  }
  return values
}

function calculateOverlays(bars: Bar[], supertrend: SupertrendSettings): { data: OverlayData; vwapUsesVolume: boolean | null } {
  const times = bars.map(bar => bar.time)
  const asLineData = (values: Array<number | null>) => values.flatMap((value, index) =>
    value == null || !Number.isFinite(value) ? [] : [{ time: times[index], value }])

  let cumulativePriceVolume = 0
  let cumulativeVolume = 0
  let session = ''
  let sessionBars: Array<{ bar: Bar; index: number }> = []
  let sessionHasVolume = false
  let vwapUsesVolume: boolean | null = bars.length ? true : null
  const vwap: Array<number | null> = Array(bars.length).fill(null)
  const sessionFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const formatSession = (bar: Bar) => {
    const parts = sessionFormatter.formatToParts(new Date(bar.time * 1000))
    return `${parts.find(part => part.type === 'year')?.value}-${parts.find(part => part.type === 'month')?.value}-${parts.find(part => part.type === 'day')?.value}`
  }
  const flushSession = () => {
    if (!sessionBars.length) return
    if (sessionHasVolume) {
      for (const { bar, index } of sessionBars) {
        if (bar.volume > 0) {
          cumulativePriceVolume += ((bar.high + bar.low + bar.close) / 3) * bar.volume
          cumulativeVolume += bar.volume
        }
        vwap[index] = cumulativeVolume > 0 ? cumulativePriceVolume / cumulativeVolume : null
      }
    } else {
      vwapUsesVolume = false
      let cumulativeTypicalPrice = 0
      sessionBars.forEach(({ bar, index }, sessionIndex) => {
        cumulativeTypicalPrice += (bar.high + bar.low + bar.close) / 3
        vwap[index] = cumulativeTypicalPrice / (sessionIndex + 1)
      })
    }
  }
  bars.forEach((bar, index) => {
    const currentSession = formatSession(bar)
    if (currentSession !== session) {
      flushSession()
      sessionBars = []
      cumulativePriceVolume = 0
      cumulativeVolume = 0
      sessionHasVolume = false
      session = currentSession
    }
    sessionBars.push({ bar, index })
    sessionHasVolume ||= bar.volume > 0
  })
  flushSession()

  const trueRanges = bars.map((bar, index) => index === 0
    ? bar.high - bar.low
    : Math.max(bar.high - bar.low, Math.abs(bar.high - bars[index - 1].close), Math.abs(bar.low - bars[index - 1].close)))
  const trend: Array<number | null> = Array(bars.length).fill(null)
  if (bars.length >= supertrend.period) {
    let finalUpper = 0
    let finalLower = 0
    let direction = 1
    for (let index = supertrend.period - 1; index < bars.length; index += 1) {
      const atr = trueRanges.slice(index - supertrend.period + 1, index + 1).reduce((sum, value) => sum + value, 0) / supertrend.period
      const midpoint = (bars[index].high + bars[index].low) / 2
      const basicUpper = midpoint + supertrend.multiplier * atr
      const basicLower = midpoint - supertrend.multiplier * atr
      if (index === supertrend.period - 1) {
        finalUpper = basicUpper
        finalLower = basicLower
        direction = bars[index].close >= midpoint ? 1 : -1
      } else {
        finalUpper = basicUpper < finalUpper || bars[index - 1].close > finalUpper ? basicUpper : finalUpper
        finalLower = basicLower > finalLower || bars[index - 1].close < finalLower ? basicLower : finalLower
        if (direction === 1 && bars[index].close < finalLower) direction = -1
        else if (direction === -1 && bars[index].close > finalUpper) direction = 1
      }
      trend[index] = direction === 1 ? finalLower : finalUpper
    }
  }

  const splitTrend = (up: boolean) => trend.map((value, index) =>
    value == null || (bars[index].close >= value) !== up ? { time: times[index] } : { time: times[index], value })

  return {
    data: {
      ema50: asLineData(calculateEma(bars, 50)),
      ema100: asLineData(calculateEma(bars, 100)),
      ema200: asLineData(calculateEma(bars, 200)),
      rsi: asLineData(calculateRsi(bars)),
      vwap: asLineData(vwap),
      supertrendUp: splitTrend(true),
      supertrendDown: splitTrend(false),
    },
    vwapUsesVolume,
  }
}

export default function MarketChart({ candles, symbol, label, indicators, onIndicatorsChange, timeframe, onTimeframeChange, supertrend, onSupertrendChange, loading, error, theme, saveError }: {
  candles: MarketCandle[]
  symbol: string
  label: string
  indicators: ChartIndicators
  onIndicatorsChange: (indicators: ChartIndicators) => void
  timeframe: ChartTimeframe
  onTimeframeChange: (timeframe: ChartTimeframe) => void
  supertrend: SupertrendSettings
  onSupertrendChange: (settings: SupertrendSettings) => void
  loading: boolean
  error: string
  theme: 'dark' | 'light'
  saveError: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const fullscreenRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const ema50Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const ema100Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const ema200Ref = useRef<ISeriesApi<'Line'> | null>(null)
  const rsiRef = useRef<ISeriesApi<'Line'> | null>(null)
  const vwapRef = useRef<ISeriesApi<'Line'> | null>(null)
  const supertrendUpRef = useRef<ISeriesApi<'Line'> | null>(null)
  const supertrendDownRef = useRef<ISeriesApi<'Line'> | null>(null)
  const rsiEnabledRef = useRef(indicators.rsi)
  const [fullscreen, setFullscreen] = useState(false)
  const [fullscreenError, setFullscreenError] = useState('')
  const [visibleLeft, setVisibleLeft] = useState(0)
  const [visibleBars, setVisibleBars] = useState(100)
  const [verticalScroll, setVerticalScroll] = useState(50)
  const [periodDraft, setPeriodDraft] = useState(String(supertrend.period))
  const [multiplierDraft, setMultiplierDraft] = useState(String(supertrend.multiplier))

  const bars = useMemo(() => candles.flatMap(candle => {
    const time = Date.parse(candle[0])
    const values = candle.slice(1, 6)
    if (!Number.isFinite(time) || values.some(value => !Number.isFinite(value))) return []
    return [{
      time: Math.floor(time / 1000) as UTCTimestamp,
      open: candle[1],
      high: candle[2],
      low: candle[3],
      close: candle[4],
      volume: Math.max(0, candle[5]),
    }]
  }).sort((a, b) => a.time - b.time), [candles])
  const { data: overlays, vwapUsesVolume } = useMemo(() => calculateOverlays(bars, supertrend), [bars, supertrend])
  const selectedTimeframe = chartTimeframes.find(option => option.value === timeframe) || chartTimeframes[4]
  const priceBounds = useMemo(() => ({
    low: Math.min(...bars.map(bar => bar.low)),
    high: Math.max(...bars.map(bar => bar.high)),
  }), [bars])
  const maxHorizontalScroll = Math.max(0, bars.length - Math.ceil(visibleBars))

  useEffect(() => {
    setPeriodDraft(String(supertrend.period))
    setMultiplierDraft(String(supertrend.multiplier))
  }, [supertrend])

  useEffect(() => {
    rsiEnabledRef.current = indicators.rsi
    const chart = chartRef.current
    const panes = chart?.panes()
    if (!chart || !panes || panes.length < 2) return
    const height = hostRef.current?.clientHeight || 355
    const rsiHeight = indicators.rsi ? Math.min(110, Math.max(72, Math.round(height * 0.24))) : 0
    panes[1].setHeight(rsiHeight)
    panes[0].setHeight(Math.max(180, height - rsiHeight - 28))
  }, [indicators.rsi])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const isLight = theme === 'light'
    const chart = createChart(host, {
      width: host.clientWidth,
      height: host.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: isLight ? '#ffffff' : '#10151b' },
        textColor: isLight ? '#52616d' : '#98a3ae',
        fontFamily: "'DM Mono', monospace",
      },
      grid: {
        vertLines: { color: isLight ? '#edf1f4' : '#1c242c' },
        horzLines: { color: isLight ? '#edf1f4' : '#1c242c' },
      },
      rightPriceScale: { borderColor: isLight ? '#d8e0e6' : '#29313a' },
      timeScale: { borderColor: isLight ? '#d8e0e6' : '#29313a', timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: isLight ? '#8798a5' : '#62717d' }, horzLine: { color: isLight ? '#8798a5' : '#62717d' } },
      handleScroll: true,
      handleScale: true,
    })
    chartRef.current = chart
    const rsiPane = chart.addPane()
    rsiPane.setHeight(indicators.rsi ? 90 : 0)
    candleSeriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: isLight ? '#16845d' : '#45d6a2',
      downColor: isLight ? '#cf3545' : '#ef707a',
      borderUpColor: isLight ? '#16845d' : '#45d6a2',
      borderDownColor: isLight ? '#cf3545' : '#ef707a',
      wickUpColor: isLight ? '#16845d' : '#45d6a2',
      wickDownColor: isLight ? '#cf3545' : '#ef707a',
    })
    ema50Ref.current = chart.addSeries(LineSeries, { color: '#a66de0', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, title: 'EMA 50' })
    ema100Ref.current = chart.addSeries(LineSeries, { color: '#3789e8', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, title: 'EMA 100' })
    ema200Ref.current = chart.addSeries(LineSeries, { color: '#e076b6', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, title: 'EMA 200' })
    rsiRef.current = chart.addSeries(LineSeries, {
      color: '#e5a436',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      title: 'RSI 14',
      priceScaleId: 'right',
    }, 1)
    rsiRef.current.createPriceLine({ price: 70, color: isLight ? '#cf3545' : '#ef707a', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: 'Overbought' })
    rsiRef.current.createPriceLine({ price: 30, color: isLight ? '#16845d' : '#45d6a2', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: 'Oversold' })
    chart.priceScale('right', 1).applyOptions({ autoScale: false, scaleMargins: { top: 0.1, bottom: 0.1 } })
    vwapRef.current = chart.addSeries(LineSeries, { color: '#e5a436', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, title: 'VWAP' })
    supertrendUpRef.current = chart.addSeries(LineSeries, { color: isLight ? '#16845d' : '#45d6a2', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, title: 'Supertrend' })
    supertrendDownRef.current = chart.addSeries(LineSeries, { color: isLight ? '#cf3545' : '#ef707a', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, title: 'Supertrend' })
    const updateHorizontalScroll = () => {
      const range = chart.timeScale().getVisibleLogicalRange()
      if (range) {
        setVisibleLeft(range.from)
        setVisibleBars(Math.max(1, range.to - range.from))
      }
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(updateHorizontalScroll)

    const resizeChart = (width: number, height: number) => {
      chart.applyOptions({ width, height })
      const panes = chart.panes()
      if (panes.length > 1) {
        const rsiHeight = rsiEnabledRef.current ? Math.min(110, Math.max(72, Math.round(height * 0.24))) : 0
        panes[1].setHeight(rsiHeight)
        panes[0].setHeight(Math.max(180, height - rsiHeight - 28))
      }
    }

    const resizeObserver = new ResizeObserver(entries => {
      const entry = entries[0]
      if (entry && chartRef.current === chart) {
        resizeChart(Math.max(0, Math.floor(entry.contentRect.width)), Math.max(240, Math.floor(entry.contentRect.height)))
      }
    })
    resizeObserver.observe(host)

    return () => {
      resizeObserver.disconnect()
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(updateHorizontalScroll)
      chart.remove()
      if (chartRef.current === chart) chartRef.current = null
      candleSeriesRef.current = null
      ema50Ref.current = null
      ema100Ref.current = null
      ema200Ref.current = null
      rsiRef.current = null
      vwapRef.current = null
      supertrendUpRef.current = null
      supertrendDownRef.current = null
    }
  }, [theme])

  useEffect(() => {
    if (!bars.length) {
      candleSeriesRef.current?.setData([])
      ema50Ref.current?.setData([])
      ema100Ref.current?.setData([])
      ema200Ref.current?.setData([])
      rsiRef.current?.setData([])
      vwapRef.current?.setData([])
      supertrendUpRef.current?.setData([])
      supertrendDownRef.current?.setData([])
      return
    }

    candleSeriesRef.current?.setData(bars)
    chartRef.current?.timeScale().setVisibleLogicalRange({
      from: Math.max(0, bars.length - Math.min(100, bars.length)),
      to: bars.length,
    })
  }, [bars, theme])

  useEffect(() => {
    ema50Ref.current?.setData(overlays.ema50)
    ema100Ref.current?.setData(overlays.ema100)
    ema200Ref.current?.setData(overlays.ema200)
    rsiRef.current?.setData(overlays.rsi)
    chartRef.current?.priceScale('right', 1).setVisibleRange({ from: 0, to: 100 })
    vwapRef.current?.setData(overlays.vwap)
    supertrendUpRef.current?.setData(overlays.supertrendUp)
    supertrendDownRef.current?.setData(overlays.supertrendDown)
  }, [overlays, theme])

  useEffect(() => {
    ema50Ref.current?.applyOptions({ visible: indicators.ema50 })
    ema100Ref.current?.applyOptions({ visible: indicators.ema100 })
    ema200Ref.current?.applyOptions({ visible: indicators.ema200 })
    rsiRef.current?.applyOptions({ visible: indicators.rsi })
    vwapRef.current?.applyOptions({ visible: indicators.vwap })
    supertrendUpRef.current?.applyOptions({ visible: indicators.supertrend })
    supertrendDownRef.current?.applyOptions({ visible: indicators.supertrend })
  }, [indicators, bars, theme])

  useEffect(() => {
    const handleFullscreenChange = () => setFullscreen(document.fullscreenElement === fullscreenRef.current)
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  const toggleFullscreen = async () => {
    const target = fullscreenRef.current
    if (!target) return
    setFullscreenError('')
    try {
      if (document.fullscreenElement === target) await document.exitFullscreen()
      else await target.requestFullscreen()
    } catch (reason) {
      setFullscreenError(reason instanceof Error ? reason.message : 'Fullscreen is unavailable in this browser.')
    }
  }

  const commitSupertrend = (field: keyof SupertrendSettings, value: string) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
      setPeriodDraft(String(supertrend.period))
      setMultiplierDraft(String(supertrend.multiplier))
      return
    }
    if (field === 'period') {
      const period = Math.min(100, Math.max(1, Math.round(parsed)))
      setPeriodDraft(String(period))
      onSupertrendChange({ ...supertrend, period })
    } else {
      const multiplier = Math.min(10, Math.max(0.1, Math.round(parsed * 10) / 10))
      setMultiplierDraft(String(multiplier))
      onSupertrendChange({ ...supertrend, multiplier })
    }
  }

  const scrollPrice = (value: number) => {
    const scale = candleSeriesRef.current?.priceScale()
    const span = priceBounds.high - priceBounds.low
    if (!scale || !Number.isFinite(span) || span <= 0) return
    const currentRange = scale.getVisibleRange()
    const visibleSpan = Math.min(span, currentRange ? currentRange.to - currentRange.from : span)
    const availableSpan = Math.max(0, span - visibleSpan)
    const from = priceBounds.low + availableSpan * value / 100
    scale.setAutoScale(false)
    scale.setVisibleRange({ from, to: from + visibleSpan })
    setVerticalScroll(value)
  }

  const resetPriceScale = () => {
    candleSeriesRef.current?.priceScale().setAutoScale(true)
    setVerticalScroll(50)
  }

  return <section ref={fullscreenRef} className={`market-chart-workspace ${fullscreen ? 'fullscreen' : ''}`}>
    <div className="market-chart-toolbar">
      <div className="market-chart-title">
        <strong>{label} · {selectedTimeframe.name}</strong>
        <span>{loading ? 'Loading verified Upstox candles…' : `${bars.length} bars · Upstox historical data`}</span>
      </div>
      <div className="market-chart-actions">
        <label className="chart-timeframe-select">Timeframe
          <select aria-label="Chart timeframe" value={timeframe} onChange={event => onTimeframeChange(event.target.value as ChartTimeframe)}>
            {chartTimeframes.map(option => <option key={option.value} value={option.value}>{option.name}</option>)}
          </select>
        </label>
        {indicatorOptions.map(option => <button
          key={option.key}
          type="button"
          className={`indicator-toggle ${indicators[option.key] ? 'selected' : ''}`}
          aria-pressed={indicators[option.key]}
          onClick={() => onIndicatorsChange({ ...indicators, [option.key]: !indicators[option.key] })}
        >{option.label}</button>)}
        <label className="supertrend-setting">ST period
          <input aria-label="Supertrend ATR period" type="number" min="1" max="100" step="1" value={periodDraft} onChange={event => setPeriodDraft(event.target.value)} onBlur={() => commitSupertrend('period', periodDraft)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}/>
        </label>
        <label className="supertrend-setting">Multiplier
          <input aria-label="Supertrend multiplier" type="number" min="0.1" max="10" step="0.1" value={multiplierDraft} onChange={event => setMultiplierDraft(event.target.value)} onBlur={() => commitSupertrend('multiplier', multiplierDraft)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}/>
        </label>
        <button type="button" className="chart-fullscreen" onClick={() => { void toggleFullscreen() }} aria-label={fullscreen ? 'Exit fullscreen chart' : 'View chart fullscreen'} title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
          {fullscreen ? <Minimize2 size={15}/> : <Maximize2 size={15}/>}
        </button>
      </div>
    </div>
    {saveError && <p className="chart-state-message error">{saveError}</p>}
    {fullscreenError && <p className="chart-state-message error">{fullscreenError}</p>}
    {error && <p className="chart-state-message error">{error}</p>}
    <div className="market-chart-chart-row">
      <div className="market-chart-plot">
        <div ref={hostRef} className="market-chart-canvas"/>
        {!loading && !error && !bars.length && <div className="market-chart-empty">No candles are available for {symbol} at this timeframe.</div>}
        {loading && <div className="market-chart-empty">Loading chart candles…</div>}
      </div>
      <label className="market-chart-y-scroll" title="Scroll the price axis">
        <span>PRICE</span>
        <input aria-label="Vertical price scrollbar" type="range" min="0" max="100" value={verticalScroll} onChange={event => scrollPrice(Number(event.target.value))}/>
        <button type="button" onClick={resetPriceScale} aria-label="Reset price scale" title="Reset price scale">Auto</button>
      </label>
    </div>
    <label className="market-chart-x-scroll">
      <span>TIME</span>
      <input aria-label="Horizontal time scrollbar" type="range" min="0" max={maxHorizontalScroll} value={Math.min(maxHorizontalScroll, Math.max(0, Math.round(visibleLeft)))} onChange={event => {
        const from = Number(event.target.value)
        chartRef.current?.timeScale().setVisibleLogicalRange({ from, to: from + visibleBars })
      }}/>
    </label>
    <div className="market-chart-footer">
      <span>{vwapUsesVolume === null ? 'VWAP appears when chart candles load.' : vwapUsesVolume ? 'VWAP uses candle volume and resets each session.' : 'VWAP uses an equal-weight candle-price proxy where Upstox provides no index volume.'} Supertrend, timeframe, and indicator settings save in this browser.</span>
      <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">Charts by TradingView</a>
    </div>
  </section>
}
