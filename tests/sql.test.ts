import { expect, test } from 'claude-code/testing'
import { PUZZLE } from '../src/config'
import { createRng } from '../src/rng'
import { buildBugHunt, mutationSites, mutationsFor } from '../src/puzzle/bug-hunt'
import { missionUnits } from '../src/puzzle/material'
import { generatorPrompt } from '../src/puzzle/pattern-id'
import { filterSql, shownSqlLines } from '../src/puzzle/sql-filter'
import { runnable } from '../src/puzzle/trace-gate'
import { SQL_ADAPTER, sqlStatementName } from '../src/puzzle/units'

// SPEC 8.3 rule 2 and 8.4: the SQL adapter. Invented schema only (SPEC 15).

test('plain SQL lines show as written; a line with a string or comment is blanked to its indent and its code `;`', async () => {
  const src = [
    '-- active orders for the week',
    'SELECT o.id, o.total',
    'FROM orders o',
    '  JOIN customers c ON c.id = o.customer_id',
    "WHERE c.name = 'Jane Roe' AND o.total > 10;",
    'SELECT 1;',
  ].join('\n')
  expect(filterSql(src, 'standard').split('\n')).toEqual([
    '…',
    'SELECT o.id, o.total',
    'FROM orders o',
    '  JOIN customers c ON c.id = o.customer_id',
    '… ;',
    'SELECT 1;',
  ])
  expect(filterSql(src, 'off')).toBe(src)
})

test('block comments are followed to their close; identifiers in brackets and backticks are code', async () => {
  const lines = ['/* owner: Jane Roe; see below', '   it\'s here */ SELECT a', 'FROM [order lines] JOIN `visits` v', '  ON v.id = x.arr[1];']
  const shown = shownSqlLines(lines)
  expect(shown.map(s => s.shown)).toEqual([false, false, true, true])
  // A `;` in a comment is not structure.
  expect(shown[0]!.semis).toBe(0)
})

test('a PostgreSQL dollar-quoted body is blanked, and the code after it shows again', async () => {
  const lines = [
    'CREATE FUNCTION nova_total(n int) RETURNS int AS $body$',
    'BEGIN',
    "  RAISE NOTICE 'Jane Roe %', n;",
    '  RETURN n + 1;',
    'END;',
    '$body$ LANGUAGE plpgsql;',
    'SELECT nova_total(2);',
  ]
  const shown = shownSqlLines(lines)
  expect(shown.map(s => s.shown)).toEqual([false, false, false, false, false, false, true])
  // A `;` inside the body is the body's; the one after the close tag is code.
  expect(shown.map(s => s.semis)).toEqual([0, 0, 0, 0, 0, 1, 1])
  // Parameters and a `$` inside a name are code.
  expect(shownSqlLines(['SELECT a$b FROM t WHERE id = $1 AND n = $12;']).map(s => s.shown)).toEqual([true])
})

test('wherever the readings could disagree, the rest of the file is blanked', async () => {
  const unsure = [
    // Strings that run on, or escape with a backslash (MySQL, E'').
    ["SELECT 'run", 'zqA', "';"],
    ["SELECT 'a\\' , zqB;", 'zqB2'],
    ["SELECT E'a\\n';", 'zqC'],
    ['SELECT "a\\" , ";', 'zqD'],
    // BigQuery's triple quotes, Oracle's q-quotes.
    ['SELECT """a"', 'zqE', '"""'],
    ["SELECT q'[it's]' , 'x", 'zqF', "'"],
    ["SELECT nq'{a'}', 1;", "x 'y", 'zqG'],
    ["SELECT q'[ a'", 'zqH', "]';"],
    // A bracket or backtick that holds an opener, or never closes on its line.
    ["SELECT [it's] , 'a", 'zqI', "';"],
    ['SELECT `a', 'zqJ', '`;'],
    ['SELECT x[', 'zqK', '];'],
    ["SELECT data['k'];", 'zqL'],
    // `--` not followed by a space, `#` and `//`, before an opener.
    ["SELECT 1 --x 'a", 'zqM', "';"],
    ["SELECT 1 # it's", 'zqN', "';"],
    ["SELECT 1 // it's", 'zqO', "';"],
    // MySQL's executable comments and hints; nested comments.
    ["SELECT /*! 'a */ 1;", 'zqP', "'*/"],
    ['SELECT /*+ INDEX(t) */ 1;', 'zqQ'],
    ['/* a /* b */', 'zqR', '*/'],
    ['SELECT 1 */', 'zqS'],
    // Dollar bodies the other reading leaves outside code, or that hold `$$` under a tag.
    ["SELECT $a$ 'x", 'zqT', "$a$ ' y", 'zqT2'],
    ['SELECT $a$ x', '-- note $a$ /*', 'zqU', '*/'],
    ['SELECT $a$ $$ $a$;', 'zqV'],
    ['SELECT 1$$ x', 'zqW', '$$;'],
    ['SELECT $1$$ x', 'zqW2', '$$;'],
    // SQLite's `$name(...)` parameter reads past quotes and comment markers.
    ["SELECT $x(a'b) 'c", 'zqX', "';"],
    ['SELECT @x(/*) 1', 'zqY', '*/'],
    // A psql meta-command, and a lone CR.
    ["\\set name 'a", 'zqZ'],
    ['SELECT 1; -- x\r/*', 'zqAA', '*/'],
    // Security review: `//*` opens a comment; `/*/` nests; a `$` right after a closing tag opens a quote.
    ['SELECT total //* share', 'zqAB', '*/ FROM t;'],
    ['SELECT 1 /* see a/*/', 'zqAC', '*/ */;'],
    ['SELECT $f$a b$f$$$', 'zqAD', '$$;'],
    // SQL Server's `]]` escape; a Snowflake `$$` made with a tag's `$`.
    ["SELECT [a]]'b] AS x, 'y", 'zqAE', "';"],
    ['SELECT $a$ x $$a$ AS y', 'zqAF', '$$;'],
    ['SELECT $a$$ x $a$ AS y', 'zqAG', '$$;'],
    // SQLite reads a parameter past a no-break space; Oracle splits `1q'`.
    ["SELECT $a(b\u00a0'c) AS d, 'e", 'zqAH', "';"],
    ["SELECT 1q'{a' FROM dual", 'zqAI', "}' x;"],
    // sqlcmd ends a batch at `GO` inside a comment; SQL*Plus runs at a lone `/`.
    ['/*', 'GO', "'", '*/', 'zqAJ', "x';"],
    ['/*', '/', "'", '*/', 'zqAK', "x';"],
    // SQL*Plus's DOCUMENT block runs to a `#` line.
    ['DOCUMENT', 'zqAL', '#'],
    // Second review: a comment opened on a line ending in `;` (SQL*Plus), and `GO` with a comment after it.
    ['SELECT 1 FROM dual /* note;', "'", '*/', 'zqAM', "x';"],
    ['/* note;', "'", '*/', 'zqAN', "x';"],
    ['/*', 'GO -- next', "'", '*/', 'zqAO', "x';"],
  ]
  for (const lines of unsure) {
    const out = filterSql(lines.join('\n'), 'standard')
    if (/zq/.test(out)) throw new Error(`leak: ${JSON.stringify(lines)} -> ${JSON.stringify(out)}`)
    expect(out.split('\n').length).toBe(lines.length)
  }
})

test('SQL*Plus remarks and prompts never show, and a file that was not valid UTF-8 is blanked whole', async () => {
  expect(shownSqlLines(['PROMPT hello -', 'zq more -', 'zq last', 'SELECT 1;']).map(s => s.shown)).toEqual([false, false, false, true])
  // A comment that closes before a `;` leaves the statement's end as code.
  expect(shownSqlLines(['/* a', ' */ SELECT 1;', 'SELECT 2;']).map(s => s.shown)).toEqual([false, false, true])
  expect(shownSqlLines(['REM zq remark', 'PROMPT zq text', 'pro', 'SELECT 1;', 'PROCEDURE_X;']).map(s => s.shown)).toEqual([false, false, false, true, true])
  expect(filterSql("SELECT \uFFFD` a ` ' d ` '\nzq\n';", 'standard').split('\n').every(l => l.trim() === '…' || l.trim() === '')).toBe(true)
})

test('a long line of names and `$` is scanned in linear time', async () => {
  const src = Array(120).fill(`a${'$'.repeat(1999)}`).join('\n')
  const t = Date.now()
  filterSql(src, 'standard')
  expect(Date.now() - t < 1000).toBe(true)
})

test('a comment marker inside a string is string, and a quote inside a comment is comment', async () => {
  expect(shownSqlLines(["SELECT '--' AS a;", 'SELECT 1;']).map(s => s.shown)).toEqual([false, true])
  expect(shownSqlLines(["-- don't /*", 'SELECT 1;']).map(s => s.shown)).toEqual([false, true])
  expect(shownSqlLines(["/* it's */", 'SELECT 1;']).map(s => s.shown)).toEqual([false, true])
  expect(shownSqlLines(["SELECT 'it''s', \"a\"\"b\";", 'SELECT 1;']).map(s => s.shown)).toEqual([false, true])
  expect(shownSqlLines(['-----------', 'SELECT 1;']).map(s => s.shown)).toEqual([false, true])
  expect(shownSqlLines(['SELECT a #> b FROM t;', 'SELECT 1;']).map(s => s.shown)).toEqual([false, true])
})

test('fuzz: SQL strings and comments in any arrangement never leak', async () => {
  const pieces = [
    "'zqS'", '"zqS"', '`ok`', '[ok]', '`ok', 'ok`', '[ok', 'ok]', "'zqS", '"zqS', '/*zqS', 'zqS*/', ' $$zqS', ' $a$zqS', "E'zqS'", "q'[zqS]'", "nq'{zqS}'", ' $$zqS$$', ' $a$zqS$a$', '$a$', '$$', '$1', 'a$', '1$', '$x(', '@y(', ':z(',
    '/* zqS */', '/*', '*/', '/*!', '/*+', '-- zqS', '--zqS', '--', '# zqS', '#', '// zqS', '"', "'", '`', '[', ']', "'''", '"""',
    '\\', '\\\\', 'SELECT a', 'FROM t;', ';', '(', ')', 'zz = 3', '\r', "'a\\'zqS'", '"a\\"zqS"', "'a''zqS'", 'q', 'n', 'x',
  ]
  const rng = createRng(20261012)
  for (let n = 0; n < 20000; n += 1) {
    const lines: string[] = []
    for (let l = 0, count = 1 + rng.int(6); l < count; l += 1) {
      const parts: string[] = []
      for (let k = 0, m = 1 + rng.int(4); k < m; k += 1) parts.push(rng.pick(pieces))
      lines.push(parts.join(rng.pick([' ', ''])))
    }
    const src = lines.join('\n')
    const out = filterSql(src, 'standard')
    // Only `zqS` inside a literal or comment is secret (dollar pieces start with a space, as one glued to a
    // name is part of the name); a shown line never holds one.
    if (/zqS/i.test(out)) throw new Error(`leak: ${JSON.stringify(src)} -> ${JSON.stringify(out)}`)
    expect(out.split('\n').length).toBe(src.split('\n').length)
  }
})

test('a file with a line over the limit is blanked whole', async () => {
  const out = filterSql(`SELECT 1;\n${'a'.repeat(PUZZLE.maxLineChars + 1)}`, 'standard').split('\n')
  expect(out.every(l => l.trim() === '…')).toBe(true)
})

test('a long line of `$` and quotes is scanned in linear time', async () => {
  const line = `SELECT ${'a$'.repeat(900)} ${"'x' ".repeat(100)}`
  const t = Date.now()
  for (let k = 0; k < 50; k += 1) filterSql(Array(20).fill(line).join('\n'), 'standard')
  expect(Date.now() - t < 2000).toBe(true)
})

test('statement names: the verb and the first table or view', async () => {
  expect(sqlStatementName(['SELECT o.id', 'FROM orders o'])).toBe('select orders')
  expect(sqlStatementName(['insert into nova.visits (a)'])).toBe('insert nova.visits')
  expect(sqlStatementName(['UPDATE visits SET a = 1'])).toBe('update visits')
  expect(sqlStatementName(['CREATE OR REPLACE VIEW active_orders AS'])).toBe('view active_orders')
  expect(sqlStatementName(['WITH recent AS (', '  SELECT * FROM visits'])).toBe('with visits')
  expect(sqlStatementName(['SELECT 1'])).toBe('select')
  expect(sqlStatementName(['CREATE TABLE t (a int)'])).toBe(undefined)
  expect(sqlStatementName(['GRANT SELECT ON t TO r'])).toBe(undefined)
})

test('SQL units: query statements the diff touched, to their `;`, comments between them skipped', async () => {
  const src = [
    '-- monthly totals',
    'SELECT c.id, SUM(o.total) AS spent',
    'FROM customers c',
    '  LEFT JOIN orders o ON o.customer_id = c.id',
    "WHERE o.status = 'paid'",
    'GROUP BY c.id',
    'HAVING SUM(o.total) > 100;',
    '',
    'CREATE TABLE notes (',
    '  id int,',
    '  body text,',
    '  author int',
    ');',
    '',
    '/* untouched */',
    'UPDATE orders',
    '  SET total = total + 1',
    '  WHERE id IN (1, 2)',
    '    AND total IS NOT NULL;',
  ].join('\n')
  const filtered = filterSql(src, 'standard')
  const units = SQL_ADAPTER.units(filtered, new Set([3, 10]))
  expect(units.map(u => [u.lang, u.name, u.lines.length])).toEqual([['SQL', 'select customers', 6]])
  expect(units[0]!.lines[3]).toBe('…')
  expect(units[0]!.lines.at(-1)).toBe('HAVING SUM(o.total) > 100;')
  expect(SQL_ADAPTER.units(filtered, new Set([17])).map(u => u.name)).toEqual(['update orders'])
  // A statement with no `;` runs to the file's end.
  expect(SQL_ADAPTER.units('SELECT a\nFROM t\nWHERE a > 1\nORDER BY a', new Set([1])).map(u => u.lines.length)).toEqual([4])
})

test('the SQL adapter claims .sql files', async () => {
  for (const p of ['a.sql', 'db/migrations/001_init.sql']) expect(SQL_ADAPTER.claims(p)).toBe(true)
  for (const p of ['a.sqlite', 'a.psql', 'a.ts', 'sql']) expect(SQL_ADAPTER.claims(p)).toBe(false)
})

test('Bug Hunt in SQL injects one bad join or filter, never in a SET', async () => {
  const unit = {
    lang: 'SQL',
    name: 'select orders',
    lines: ['SELECT o.id, c.id', 'FROM orders o', '  INNER JOIN customers c ON c.id = o.customer_id', 'WHERE o.total >= 10', '  AND o.region_id IN (1, 2)', '  AND c.closed_at IS NULL;'],
  }
  for (let seed = 0; seed < 80; seed += 1) {
    const p = buildBugHunt([unit], createRng(seed))!
    expect(p.question).toBe('One line of the query was changed to bring in a bad join or filter. Which one?')
    const diff = p.code.map((l, i) => (l === unit.lines[i] ? -1 : i)).filter(i => i >= 0)
    expect(diff.length).toBe(1)
    expect(p.choices[p.answer]).toBe(`Line ${diff[0]! + 1}`)
  }
  const at = (from: string, line: string) => mutationSites(mutationsFor('SQL').find(m => m.from === from)!, line).length
  expect(at(' = ', '  SET total = 1')).toBe(0)
  expect(at(' = ', '  WHERE a = 1')).toBe(1)
  expect(at(' AND ', 'WHERE a BETWEEN 1 AND 2')).toBe(0)
  expect(at(' IN (', 'WHERE a NOT IN (1)')).toBe(0)
  expect(at(' IN (', 'WHERE a IN (1)')).toBe(1)
  expect(at('JOIN', 'LEFT JOIN b')).toBe(0)
  expect(at('JOIN', 'LEFT OUTER JOIN b')).toBe(0)
  expect(at('JOIN', '  JOIN b ON')).toBe(1)
  expect(at('is null', 'where a is not null')).toBe(0)
  expect(at('IS NOT NULL', 'WHERE a IS NOT NULL')).toBe(1)
})

test('Pattern ID asks for the query pattern of a SQL statement', async () => {
  const prompt = generatorPrompt({ lang: 'SQL', name: 'select orders', lines: ['SELECT a', 'FROM orders'] })
  expect(prompt).toContain('Here is a SQL statement.')
  expect(prompt).toContain('which query pattern this statement mainly uses')
})

test('Trace does not run SQL yet', async () => {
  expect(runnable({ lang: 'SQL', name: 'select t', lines: ['SELECT a', 'FROM t', 'WHERE a > 1', ';'] })).toBe(undefined)
})

test('mission material reads a changed .sql file through the SQL filter', async () => {
  const sql = ['-- report', 'SELECT v.id, v.owner', 'FROM visits v', "WHERE v.owner = 'Jane Roe'", '  AND v.seen_at IS NULL', 'ORDER BY v.id;'].join('\n')
  const io = {
    git: async (args: readonly string[]) => {
      if (args[0] === 'rev-list') return { exitCode: 0, stdout: 'abc\n' }
      if (args.includes('--raw')) return { exitCode: 0, stdout: ':100644 100644 a b M\0db/report.sql\0' }
      return { exitCode: 0, stdout: 'diff --git a/db/report.sql b/db/report.sql\n+++ b/db/report.sql\n@@ -5 +5 @@\n' }
    },
    read: async () => sql,
  }
  const units = await missionUnits(io, 0, 'strict')
  expect(units.map(u => [u.lang, u.name])).toEqual([['SQL', 'select visits']])
  expect(units[0]!.lines.join('\n')).not.toContain('Jane')
})

test('a query inside a dollar-quoted body is never a unit', async () => {
  const src = 'DO $$\nSELECT zq_secret\nFROM t\nWHERE a > 1\nAND b < 2;\n$$;'
  expect(SQL_ADAPTER.units(filterSql(src, 'standard'), new Set([2, 3, 4, 5])).length).toBe(0)
})
