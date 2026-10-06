import { atom, read } from 'claude-code'
import type { On } from 'claude-code'
import type { BandView, CalibrationView, LatticeView, ReportView } from '../../types'
import { COMPANION, SPRITE } from '../config'
import { tierColor } from './color'

const band = atom({ plugin: 'final-commit', key: 'band' } as const, null as BandView | null)
const lattice = atom({ plugin: 'final-commit', key: 'lattice' } as const, null as LatticeView | null)
const calibration = atom({ plugin: 'final-commit', key: 'calibration' } as const, null as CalibrationView | null)
const report = atom({ plugin: 'final-commit', key: 'report' } as const, null as ReportView | null)
const bridgeOpen = atom({ plugin: 'final-commit', key: 'bridgeOpen' } as const, false)

/** Eyes close for a blink frame. */
export function blink(rows: string[]): string[] {
  return rows.map(r => r.replace(/[oO@]/g, '-'))
}

/** The drawing without its blank margin: blank rows above and below, blank columns at either side. */
export function trimSprite(rows: string[]): string[] {
  const inked = rows.filter(r => r.trim().length > 0)
  if (inked.length === 0) return []
  const first = rows.findIndex(r => r.trim().length > 0)
  const last = rows.length - 1 - [...rows].reverse().findIndex(r => r.trim().length > 0)
  const kept = rows.slice(first, last + 1)
  const left = Math.min(...inked.map(r => r.length - r.trimStart().length))
  const right = Math.max(...inked.map(r => r.trimEnd().length))
  return kept.map(r => r.padEnd(right, ' ').slice(left, right))
}

/** Cuts a line to `width` cells. Band text is printable ASCII and one cell per character. */
const fit = (text: string, width: number): string => [...text].slice(0, Math.max(0, width)).join('')

/** The text beside the sprite: one fact per line, each cut to the column left of it. */
export function besideLines(v: Pick<BandView, 'name' | 'tier' | 'mood' | 'mission'>, width: number): string[] {
  return [v.name, v.tier, v.mood, ...(v.mission ? [v.mission] : [])].map(line => fit(line, width))
}

/** The companion above the prompt (SPEC 9.3). The wiring files write the view (and the blink); this draws it. */
export function wireBand(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, band)
    // A game pane needs the rows: the band steps aside while one is open. The Bridge draws the companion itself.
    const isPlaying = (await read($, lattice)) !== null || (await read($, calibration)) !== null || (await read($, report)) !== null || (await read($, bridgeOpen))
    if (!v || e.props.hasSurvey || isPlaying) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const color = tierColor(v.tierName, await $.clock.now())
    // The companion keeps to the right edge; whatever else draws in the band keeps the left.
    const beneath = await next(e)
    const showSprite = e.props.maxRows >= COMPANION.spriteMinRows && columns >= SPRITE.cols && v.sprite.length > 0
    if (!showSprite) {
      const line = fit(`${v.tier} ${v.name} · ${v.mood}${v.mission ? ` · ${v.mission}` : ''}`, columns)
      return (
        <Box flexDirection="row">
          <Box flexGrow={1} flexShrink={1}>{beneath}</Box>
          <Box flexShrink={0}><Text dimColor color={color}>{line}</Text></Box>
        </Box>
      )
    }
    const sprite = trimSprite(v.isBlinking || v.mood === 'asleep' ? blink(v.sprite) : v.sprite)
    const spriteColumns = Math.max(0, ...sprite.map(r => r.length))
    const room = columns - spriteColumns - COMPANION.spriteGap
    const lines = room >= COMPANION.besideMinColumns ? besideLines(v, room) : []
    const textColumns = Math.max(0, ...lines.map(l => [...l].length))
    return (
      <Box flexDirection="row">
        <Box flexGrow={1} flexShrink={1}>{beneath}</Box>
        {lines.length > 0 && (
          <Box flexDirection="column" justifyContent="center" flexShrink={0} width={textColumns} marginRight={COMPANION.spriteGap}>
            {lines.map((line, i) => (i === 0 ? <Text bold color={color}>{line}</Text> : i === 1 ? <Text color={color}>{line}</Text> : <Text dimColor>{line}</Text>))}
          </Box>
        )}
        <Box flexDirection="column" flexShrink={0} width={spriteColumns}>
          {sprite.map(row => <Text color={color}>{row}</Text>)}
        </Box>
      </Box>
    )
  })
}
