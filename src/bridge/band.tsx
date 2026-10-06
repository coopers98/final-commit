import { atom, read } from 'claude-code'
import type { On } from 'claude-code'
import type { BandView, CalibrationView, LatticeView, ReportView } from '../../types'
import { COMPANION, SPRITE } from '../config'

const band = atom({ plugin: 'final-commit', key: 'band' } as const, null as BandView | null)
const lattice = atom({ plugin: 'final-commit', key: 'lattice' } as const, null as LatticeView | null)
const calibration = atom({ plugin: 'final-commit', key: 'calibration' } as const, null as CalibrationView | null)
const report = atom({ plugin: 'final-commit', key: 'report' } as const, null as ReportView | null)

/** Eyes close for a blink frame. */
export function blink(rows: string[]): string[] {
  return rows.map(r => r.replace(/[oO@]/g, '-'))
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
    // A game pane needs the rows: the band steps aside while one is open.
    const isPlaying = (await read($, lattice)) !== null || (await read($, calibration)) !== null || (await read($, report)) !== null
    if (!v || e.props.hasSurvey || isPlaying) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const showSprite = e.props.maxRows >= COMPANION.spriteMinRows && columns >= SPRITE.cols && v.sprite.length > 0
    if (!showSprite) {
      return <Text dimColor>{fit(`${v.tier} ${v.name} · ${v.mood}${v.mission ? ` · ${v.mission}` : ''}`, columns)}</Text>
    }
    // The sprite sits at the right edge; its facts fill the columns to its left.
    const sprite = v.isBlinking || v.mood === 'asleep' ? blink(v.sprite) : v.sprite
    const textColumns = columns - SPRITE.cols - COMPANION.spriteGap
    const lines = textColumns >= COMPANION.besideMinColumns ? besideLines(v, textColumns) : []
    return (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="column" width={Math.max(0, textColumns)}>
          {lines.map((line, i) => (i === 0 ? <Text bold>{line}</Text> : <Text dimColor>{line}</Text>))}
        </Box>
        <Box flexDirection="column" width={SPRITE.cols}>
          {sprite.map(row => <Text>{row}</Text>)}
        </Box>
      </Box>
    )
  })
}
