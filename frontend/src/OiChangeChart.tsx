import { useMemo, useState } from 'react'

type OiChartRow = {
  strike_price?: number
  call_options?: { market_data?: { oi?: number; prev_oi?: number } }
  put_options?: { market_data?: { oi?: number; prev_oi?: number } }
}

type OiPoint = { strike: number; callChange: number | null; putChange: number | null }

const rangeOptions: Array<number | 'all'> = [5, 10, 15, 20, 'all']
const chartHeight = 340
const chartTop = 24
const chartBottom = 82
const chartLeft = 74
const chartRight = 20
const plotHeight = chartHeight - chartTop - chartBottom

function formatAxisValue(value: number) {
  const absolute = Math.abs(value)
  const compact = absolute >= 10_000_000
    ? `${(absolute / 10_000_000).toLocaleString('en-IN', { maximumFractionDigits: 1 })}Cr`
    : absolute >= 100_000
      ? `${(absolute / 100_000).toLocaleString('en-IN', { maximumFractionDigits: 1 })}L`
      : absolute >= 1_000
        ? `${(absolute / 1_000).toLocaleString('en-IN', { maximumFractionDigits: 1 })}k`
        : absolute.toLocaleString('en-IN')
  return `${value < 0 ? '-' : ''}${compact}`
}

export default function OiChangeChart({ chain, spot, loading, error }: {
  chain: OiChartRow[]
  spot?: number | null
  loading: boolean
  error: string
}) {
  const [range, setRange] = useState<number | 'all'>(10)
  const points = useMemo(() => chain
    .map(row => {
      const call = row.call_options?.market_data
      const put = row.put_options?.market_data
      return {
        strike: row.strike_price,
        callChange: call?.oi != null && call.prev_oi != null ? call.oi - call.prev_oi : null,
        putChange: put?.oi != null && put.prev_oi != null ? put.oi - put.prev_oi : null,
      }
    })
    .filter((point): point is OiPoint => point.strike != null && (point.callChange != null || point.putChange != null))
    .sort((a, b) => a.strike - b.strike), [chain])

  const atmIndex = points.length
    ? spot == null
      ? Math.floor(points.length / 2)
      : points.reduce((best, point, index) =>
        Math.abs(point.strike - spot) < Math.abs(points[best].strike - spot) ? index : best, 0)
    : -1
  const visible = range === 'all' || atmIndex < 0
    ? points
    : points.slice(Math.max(0, atmIndex - range), atmIndex + range + 1)

  if (loading) {
    return <div className="oi-chart-empty"><strong>Loading current option chain…</strong><span>Strike-level open-interest changes will appear when the chain is ready.</span></div>
  }
  if (error) {
    return <div className="oi-chart-empty"><strong>OI change chart unavailable</strong><span>{error}</span></div>
  }
  if (!points.length) {
    return <div className="oi-chart-empty"><strong>{chain.length ? 'Previous OI is unavailable' : 'Waiting for option chain'}</strong><span>{chain.length ? 'Upstox did not return both current and previous open interest for any strike.' : 'Load an index option chain with current and previous open-interest values to see the chart.'}</span></div>
  }

  const maxChange = Math.max(1, ...visible.flatMap(point => [Math.abs(point.callChange || 0), Math.abs(point.putChange || 0)])) * 1.08
  const plotWidth = Math.max(820, visible.length * 42)
  const chartWidth = chartLeft + plotWidth + chartRight
  const slotWidth = plotWidth / visible.length
  const barWidth = Math.min(13, slotWidth * 0.32)
  const zeroY = chartTop + plotHeight / 2
  const labelEvery = Math.max(1, Math.ceil(visible.length / 24))
  const toY = (value: number) => chartTop + ((maxChange - value) / (maxChange * 2)) * plotHeight
  const markerIndex = range === 'all' ? atmIndex : atmIndex >= 0 && visible.some(point => point.strike === points[atmIndex].strike)
    ? visible.findIndex(point => point.strike === points[atmIndex].strike)
    : -1

  return <section className="oi-chart-section">
    <div className="oi-chart-toolbar">
      <div>
        <h3>OI change by strike</h3>
        <span>Current OI minus previous OI · {visible.length} of {points.length} strikes</span>
      </div>
      <div className="oi-range-control" aria-label="Strikes shown around ATM">
        {rangeOptions.map(option => <button
          key={option}
          type="button"
          className={range === option ? 'selected' : ''}
          onClick={() => setRange(option)}
          aria-pressed={range === option}
        >{option === 'all' ? 'All' : `±${option}`}</button>)}
      </div>
    </div>
    <div className="oi-chart-scroll">
      <svg className="oi-change-chart" viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label="Put and call open-interest change by strike">
        {[2, 1, 0, -1, -2].map(step => {
          const value = maxChange * step / 2
          const y = toY(value)
          return <g key={step}>
            <line x1={chartLeft} x2={chartLeft + plotWidth} y1={y} y2={y} className={step === 0 ? 'oi-zero-line' : 'oi-grid-line'}/>
            <text x={chartLeft - 10} y={y + 4} className="oi-axis-label" textAnchor="end">{formatAxisValue(value)}</text>
          </g>
        })}
        {markerIndex >= 0 && <g>
          <line x1={chartLeft + (markerIndex + 0.5) * slotWidth} x2={chartLeft + (markerIndex + 0.5) * slotWidth} y1={chartTop} y2={chartTop + plotHeight} className="oi-atm-line"/>
          <text x={chartLeft + (markerIndex + 0.5) * slotWidth} y={chartTop - 8} className="oi-atm-label" textAnchor="middle">ATM</text>
        </g>}
        {visible.map((point, index) => {
          const center = chartLeft + (index + 0.5) * slotWidth
          return <g key={point.strike}>
            {([['put', point.putChange, center - barWidth - 1], ['call', point.callChange, center + 1]] as const).map(([type, value, x]) => {
              if (value == null || value === 0) return null
              const valueY = toY(value)
              const y = value > 0 ? valueY : zeroY
              const height = Math.max(1, Math.abs(zeroY - valueY))
              return <rect key={type} x={x} y={y} width={barWidth} height={height} rx={2} className={`oi-bar ${type}`}>
                <title>{`${type === 'put' ? 'Put' : 'Call'} OI change at ${point.strike.toLocaleString('en-IN')}: ${value > 0 ? '+' : ''}${value.toLocaleString('en-IN')}`}</title>
              </rect>
            })}
            {index % labelEvery === 0 && <text
              x={center}
              y={chartTop + plotHeight + 20}
              className="oi-strike-label"
              textAnchor="end"
              transform={`rotate(-42 ${center} ${chartTop + plotHeight + 20})`}
            >{point.strike.toLocaleString('en-IN')}</text>}
          </g>
        })}
      </svg>
    </div>
    <div className="oi-chart-legend">
      <span><i className="put"/> Put OI change</span>
      <span><i className="call"/> Call OI change</span>
      {spot != null && <span className="oi-spot-legend">ATM near {spot.toLocaleString('en-IN')}</span>}
    </div>
    <p className="oi-chart-note">Positive bars show OI added; negative bars show OI reduced. Values are available only where Upstox returned previous OI.</p>
  </section>
}
