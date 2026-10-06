import type { Register } from 'claude-code'

// Wiring only: every rule lives in src/. The next commit wires the game in.
export const register: Register = on => {
  on('session.start', ($, e, next) => next(e))
}
