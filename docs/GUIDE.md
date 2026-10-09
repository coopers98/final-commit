# Player's Guide

How The Final Commit plays: what earns what, what the numbers are, and what
to do when a creature turns up. The [README](../README.md) covers install,
work sources and privacy; [SPEC.md](SPEC.md) is the full design. Numbers
here are the current defaults (`src/config.ts`) and may change with tuning.

## The loop in one minute

1. **Chart an epic.** `/epic NOVA-1` turns the epic into a star system with
   its own Difflings: 9 fauna you can meet and contain, 4 flora you harvest.
2. **Run missions.** `/mission NOVA-2` (or checking out `feature/NOVA-2-x`)
   starts one. Work as usual: commits, test runs and reviews are noticed.
3. **Complete the mission.** `/mission complete`. You earn cells and flora,
   and you may get an **encounter**.
4. **Contain the creature.** `/contain` opens Seal the Lattice, a timing
   game. Contain it and it joins your collection.
5. **Survey the epic.** `/epic complete` when the epic is done: a
   guaranteed encounter (never a Common) and a Singularity Cell.

With a work source on (plan documents, GitHub Issues, Jira Cloud), steps 1,
2, 3 and 5 happen on their own as your tracker changes. See the README.

## Epics and star systems

`/epic NOVA-1` asks for the epic's title and description in a pane (the key
is all that goes in the transcript), then charts the system in the
background. The status line shows `/ charting NOVA-1 42s` meanwhile. A
mission typed while it charts waits and starts when the chart is done.

Each system has a name, a star class, 2 to 4 biomes, and its lifeforms:

| Kind | Common | Uncommon | Rare | Exotic | Legendary | Anomaly |
|---|---|---|---|---|---|---|
| Fauna | 3 | 2 | 1 | 1 | 1 | 1 (hidden) |
| Flora | 2 | | 1 | | 1 | |

**`/scan`** shows what your sensors know about the active system
(`/scan NOVA-1` for any charted one). Commons and Uncommons are named from
the start. Rarer ones show as unidentified signals until you meet them. A
mission that brings no encounter still resolves one hidden signal into a
silhouette, and a survey resolves all that are left. The Anomaly never
shows.

**`/epic complete`** surveys the active epic. It is refused while an
encounter is waiting, so the survey's guaranteed one is never lost:
`/contain` first. A surveyed system stays visitable: `/epic NOVA-1` makes it
active again.

## Missions

A mission is one issue's worth of work. Start one with `/mission NOVA-2`, by
checking out a branch whose name holds the key (`feature/NOVA-2-export`), or
through a work source. One runs at a time.

While it runs, the game counts:

- **Commits** (`git commit` in your session).
- **Test runs** and whether the last one passed. A plain `npm test` counts
  by its exit status. A piped or chained run (`npm test | tail`) counts by
  the runner's summary line, so keep that line in the output.
- **Lint and type checks** (eslint, tsc, ruff and the like): the last
  verdict.
- **A clean Tactical review** after your last commit (see the crew below).
  A commit after the review clears it: new code is unreviewed.

`/mission complete` asks first if tests or lint were never run or are
failing. Enter completes it anyway, Esc keeps it going.
`/mission complete anyway` skips the question.

### Mission quality

Quality runs from 0 to 1 and drives most rewards:

| You did | Quality |
|---|---|
| Neither of the below | 0 |
| Tests ran and the last run passed | +0.5 |
| Clean Tactical review after your last commit | +0.5 |

Higher quality means rarer encounters, more flora, and a small containment
bonus.

### What a completed mission gives

| Reward | When |
|---|---|
| Reinforced Cell | Tests green |
| Stasis Cell | Clean Tactical review |
| Flora samples | 1 at quality 0, 2 at 0.5, 3 at 1 |
| Encounter roll | Every time (see below) |

A mission closed without work attached gives none of these (see below).

A report pane opens with what happened. It stays until you dismiss it.

**Completed by mistake?** `/mission reopen NOVA-2` takes it out of the log
and takes back what it gave, as far as you still hold it (a spent cell
stays spent). Encounters it led to stay.

**Closed in the tracker without work?** A tracker's Done on a mission with
no commits (or with test runs alone, under 20 minutes) completes it without
rewards. This stops farming by bulk-closing tickets.

## Encounters

After each completed mission the game rolls for an encounter:

- **Your first mission ever:** guaranteed.
- **Otherwise:** 12%, plus 12% for each whole day since your last
  encounter (24% after a day, 60% after four).
- **Five days without one:** guaranteed.
- **At most 2 a day** from missions. Surveys don't count toward it.
- **One at a time.** While a creature waits, missions roll nothing; contain
  it (or let it go) first.

The creature's tier is rolled next. Quality makes rarer tiers likelier:

| Tier | Glyph | Quality 0 | Quality 1 | Survey |
|---|---|---|---|---|
| Common | `·` | 50% | 40% | never |
| Uncommon | `◇` | 28% | 34% | 56% |
| Rare | `◆` | 14% | 17% | 28% |
| Exotic | `✦` | 6% | 7% | 12% |
| Legendary | `★` | 1.8% | 2.2% | 3.6% |
| Anomaly | `✺` | 0.2% | 0.2% | 0.4% |

Each tier has its own color too, but the glyph and name always say it, so
color is never the only signal.

About one creature in seven wears something: a scarf or goggles (11%), a
top hat or a cybernetic eye (3.5%), a crown or halo (0.5%). The catalog
tracks every species, tier and attachment you have seen.

## Containment

### Analyze Specimen (a puzzle first)

When a mission brings a creature, the game reads the functions you changed
in that mission and builds a quick multiple-choice question from one of
them. `/contain` asks it first:

- **Bug Hunt** (Exotic and up): one line of your function was changed to
  bring in a bug (a flipped comparison, an off-by-one, `&&` for `||`).
  Which line?
- **Pattern ID** (Common to Rare): which pattern or technique does this
  function use? The question is written by a model and checked by a second,
  independent call, so a question whose answer the two disagree on is
  thrown away.

Press **1** to **4** to answer, **s** to skip, **Esc** to come back later.
A right answer adds +10% (Common) up to +25% (Legendary), plus up to +5% for
answering fast (none after a minute). A wrong answer costs nothing and
explains why. The bonus counts for every attempt on that creature, and the
question is asked once.

The code is shown filtered, as the model sees it: string literals read
`"…"` and comments are gone. A survey's creature has no puzzle (a survey
has no code of its own), and neither does a mission that changed no
TypeScript or JavaScript yet (`.tsx` and `.jsx` files are not read). The `puzzles` setting in `/config` is `on`,
`local` (Bug Hunt only, so no code is sent anywhere) or `off`. Pattern ID
needs `privacyMode` set to `standard` or `off`: under the default `strict`,
no code leaves your machine, so every puzzle is a Bug Hunt.

### Seal the Lattice

`/contain` then opens **Seal the Lattice**. You can also press Enter on the
mission report to go straight there.

```
[------======|-----------------]
Locks [#--]
```

A needle (`|`) sweeps across a bar. Press **Space** while it is inside the
zone (`=`) to seal a lock. Seal every lock, then the cell is thrown.

| Key | Does |
|---|---|
| Space | Seal a lock |
| Enter | Throw the cell now, with the locks sealed so far |
| Esc | Pause. The creature keeps waiting; `/contain` resumes |

One seal per pass: after a seal, presses miss until the needle has left the
zone, so holding Space down does not work.

Rarer creatures are harder:

| Tier | Locks | Zone | Speed | Twist |
|---|---|---|---|---|
| Common | 1 | Wide | Slow | |
| Uncommon | 2 | Wide | Medium | |
| Rare | 3 | Medium | Medium | The zone moves after each lock |
| Exotic | 3 | Narrow | Fast | The needle reverses at random |
| Legendary | 4 | Narrow | Fast | A miss breaks a sealed lock |
| Anomaly | 5 | Very narrow | Erratic | The zone flickers |

**Playing over SSH or from a phone?** Run `/calibrate` once per device:
press Space on 8 beats, and the game shifts the timing window by your
measured delay.

### Your odds

Your chance to contain is the sum of:

| Part | Amount |
|---|---|
| The tier's base | Common 90%, Uncommon 70%, Rare 45%, Exotic 25%, Legendary 10%, Anomaly 5% |
| The cell | Standard +0%, Reinforced +15%, Stasis +30%, Singularity +50% |
| The lattice | Up to +20% for all locks sealed, +2% per dead-center hit, -3% per miss (0% to +25%) |
| Mission quality | Up to +10% |
| The puzzle | Up to +30% for a right answer (see above) |

The total is capped at 98%.

Example: a Rare (45%), a Reinforced Cell (+15%), all locks sealed with one
center hit (+22%) and quality 0.5 (+5%) gives 87%.

### When it fails

A failed attempt uses up the cell (Standard Cells are unlimited), then the
creature either:

- **broke free:** it is still here. Try again with `/contain`, ideally with
  a better cell; or
- **fled:** it is gone, logged in your catalog as escaped, with its
  silhouette.

The chance it flees after a failure: Common 10%, Uncommon 20%, Rare 35%,
Exotic 50%, Legendary 65%, Anomaly 80%. So on a rare creature, throw your
best cell first rather than retrying with Standard ones.

## Cells

| Cell | Bonus | How you get it |
|---|---|---|
| Standard | +0% | Unlimited |
| Reinforced | +15% | A mission with green tests, or craft from 3 Common flora |
| Stasis | +30% | A mission with a clean Tactical review, or craft from 2 Rare flora |
| Singularity | +50% | Surveying an epic. Needs a Legendary flora sample to use, and spends it |

To pick a cell:

- `/contain reinforced` (or `stasis`, `singularity`), or the short keys
  `/contain r`, `s`, `x`.
- On the mission report, type `r`, `s` or `x`, then Enter. The report
  offers only the cells you can use.
- Asking for a cell you don't have loads a Standard Cell and says so.

## Flora and crafting

Flora are plants: they are harvested, never contained, and never flee.
Every completed mission with work harvests 1 to 3 samples by quality from
the active system's flora. Each sample is Common about 76% of the time,
Rare 21%, Legendary 3%. The report names what you picked, and `/scan`
names the species from then on.

`/craft` spends samples on cells:

| Command | Costs | Makes |
|---|---|---|
| `/craft reinforced` | 3 Common samples | 1 Reinforced Cell |
| `/craft stasis` | 2 Rare samples | 1 Stasis Cell |

`/craft` on its own lists the recipes and what you hold. Samples from any
system count. Legendary samples can't be crafted with: keep them to arm
Singularity Cells.

## Your collection

**`/bay`** opens the Specimen Bay: the cells and flora you hold, then every
specimen you have contained with its tier, level and attachment.
`/bay companion 3` makes specimen 3 your companion. Your first contained
creature becomes your companion on its own.

**Your companion** sits in the band above the prompt: its sprite, name,
tier, mood and the current mission. Its mood follows your session:

| Mood | When |
|---|---|
| content | A test run just passed (it ate) |
| startled | A command just failed (it flinched) |
| asleep | Nothing has happened for 10 minutes |
| idle | Otherwise |

**Levels:** every specimen is level 1 for now. Companion XP from missions,
and evolution at levels 10 and 25 (each fauna already has its later sprites
drawn), are planned but not built yet.

## The Bridge and the crew

**`/bridge`** shows the active system and mission, and three gauges:

- **Hull:** this session's test pass rate.
- **Shields:** the last lint or type-check verdict.
- **Fuel:** the context window left.

It also shows the crew's status, the latest captain's log, and your
companion at the foot.

**The crew** are three read-only subagents that you, or Claude, can
dispatch. They never change files, commit or push.

| Officer | Bridge key | Does |
|---|---|---|
| Engineering | `e` tests, `l` lint | Runs and explains your tests; runs lint and type checks |
| Science | `s` | Answers a question about the code |
| Tactical | `t` | Reviews your branch for security issues before a push |

A clean Tactical verdict after your last commit counts toward mission
quality and earns a Stasis Cell. On the Bridge, `1`, `2` and `3` reopen each
officer's last report.

**Red alert:** a failed test run, or another failed tool call, during a
mission flashes `! RED ALERT` on the status line for 8 seconds. A toast
comes at most once every 5 minutes. A shell command that merely exits
non-zero, such as a `grep` with no match, doesn't count.

**`/captains-log`** writes a short summary of the session, stamped with a
stardate, and shows it in a pane. It makes good standup notes. The last 20
are kept.

## The status line

The status line under the prompt shows the most urgent thing first, joined
by `·`:

| Shows | Means |
|---|---|
| `! RED ALERT` | Something just failed (for 8 seconds) |
| `★ /contain` | A creature is waiting (its tier's glyph) |
| `/ charting NOVA-1 42s` | A system is being charted |
| `NOVA-12 · Kessa Reach` | The current mission and system |

## Coming later

- **More puzzles:** Trace (predict a function's output, checked by running
  it) and Complexity Read, more languages (PHP, Python, SQL, Markdown), and
  `/dossier` for your accuracy by category.
- **Companion XP and evolution**, with perks that change game odds (never
  your code).
- **Design Probe and Deep Expedition** puzzles for the rarest creatures.

## Quick reference

| Command | Does |
|---|---|
| `/epic NOVA-1` | Chart an epic as a star system |
| `/epic complete` | Survey it: an encounter and a Singularity Cell |
| `/mission NOVA-2` | Start a mission |
| `/mission complete [anyway]` | Finish it |
| `/mission reopen NOVA-2` | Undo a completion |
| `/contain [r\|s\|x]` | Contain a waiting creature, with a cell |
| `/craft [reinforced\|stasis]` | Turn flora into cells |
| `/calibrate` | Measure this device's key delay |
| `/bay`, `/bay companion N` | Your collection and companion |
| `/scan [KEY]` | What the sensors know about a system |
| `/bridge` | Gauges, crew and log |
| `/captains-log` | Write a session summary |
| `/setup` | Choose and set up work sources |
