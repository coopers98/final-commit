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

/** The companion above the prompt (SPEC 9.3). The wiring files write the view (and the blink); this draws it. */
export function wireBand(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, band)
    // A game pane needs the rows: the band steps aside while one is open.
    const isPlaying = (await read($, lattice)) !== null || (await read($, calibration)) !== null || (await read($, report)) !== null
    if (!v || e.props.hasSurvey || isPlaying) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const line = [...`${v.tier} ${v.name} · ${v.mood}${v.mission ? ` · ${v.mission}` : ''}`].slice(0, columns).join('')
    const showSprite = e.props.maxRows >= COMPANION.spriteMinRows && columns >= SPRITE.cols && v.sprite.length > 0
    const sprite = v.isBlinking || v.mood === 'asleep' ? blink(v.sprite) : v.sprite
    return (
      <Box flexDirection="column">
        {showSprite && sprite.map(row => <Text>{row}</Text>)}
        <Text dimColor>{line}</Text>
      </Box>
    )
  })
}
