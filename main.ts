// werewolf-agent-01 entry: a scripted Werewolf agent (no model calls).
// It plays one seat in 30 games of 8-player Werewolf against seven house
// players (claude-haiku-5-5). Every decision is computed from that game's
// own view alone: a deterministic deduction engine that scores every living
// seat's suspicion from votes, speeches, deaths and revealed roles, then
// acts on it. No model calls, no wall clock, no unseeded randomness: ties
// break from MAKEFUN_TRIAL_SEED + the game number, so a trial replays
// byte for byte.
//
// Roles:
//   werewolf: kill the most dangerous villager (a seer claim first, then
//     accusers of me or my partner, then vocal players); as the second wolf
//     match the partner's pick so a kill happens. By day, accuse a villager
//     and vote with the village's suspicion to blend in. Every accusation
//     is grounded in the public record: the "voted for a villager" line is
//     only used when the target really did that, so the village cannot
//     catch the claim as a lie.
//   seer: inspect the most suspicious seat; when an inspection finds a
//     werewolf, say so in the debate and vote them out.
//   doctor: protect the most likely night-kill target: a revealed seer
//     first, then the villager who accused a revealed wolf the most (the
//     wolves kill those who threaten them), then the most talkative.
//     Never the same seat two nights running, never myself (the env never
//     offers my own seat as a protect option).
//   villager: vote the most suspicious seat and say why.
//
// The run loop is the starter's: POST /observe, answer every pending
// decision, repeat until "done". Node 22 standard library only.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

type Seat = number;
type Role = 'werewolf' | 'seer' | 'doctor' | 'villager';
type DecisionKind = 'speak' | 'vote' | 'kill' | 'protect' | 'inspect';

interface Player {
  seat: Seat;
  name: string;
  alive: boolean;
  role: Role | null;
}
interface LogEntry {
  seq: number;
  day: number;
  kind: string;
  seat?: Seat;
  text?: string;
  target?: Seat | null;
  died?: Seat | null;
  role?: Role | null;
  tally?: { seat: Seat; votes: number }[];
  [k: string]: unknown;
}
interface View {
  day: number;
  phase: string;
  you: {
    seat: Seat;
    name: string;
    role: Role;
    alive: boolean;
    partner: { seat: Seat; name: string; alive: boolean } | null;
  };
  players: Player[];
  seerResults: { night: number; seat: Seat; werewolf: boolean }[] | null;
  lastProtect: { night: number; seat: Seat } | null;
  wolfVotes: { night: number; seat: Seat; target: Seat | null }[] | null;
  log: LogEntry[];
  outcome: unknown;
  [k: string]: unknown;
}
interface Pending {
  game: number;
  decision: DecisionKind;
  options?: Seat[];
  max_chars?: number;
  view: View;
}
interface Observed {
  games: number;
  finished: number;
  done: boolean;
  pending: Pending[];
}

const CONCURRENCY = 10;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** A small deterministic PRNG from a string seed (mulberry32 over a hash). */
function rngFrom(seedText: string): () => number {
  const h = createHash('sha256').update(seedText).digest();
  let a = h.readUInt32LE(0);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fold a statement the env's way and cut it to max chars. */
function foldStatement(text: string): string {
  return text
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .trim();
}
function cutStatement(text: string, max: number): string {
  const folded = foldStatement(text);
  const pts = [...folded];
  return pts.length > max ? pts.slice(0, max).join('').trim() : folded;
}

/** The public record of one game, reduced to what the strategy needs. */
interface GameState {
  me: Seat;
  myRole: Role;
  partner: Seat | null;
  alive: Seat[];
  deadRole: Map<Seat, Role>;
  /** day -> voter -> target (null = abstain). */
  votesByDay: Map<number, Map<Seat, Seat | null>>;
  /** day -> seat -> text of that seat's speeches. */
  speechesByDay: Map<number, Map<Seat, string[]>>;
  /** Seats a revealed seer (me) found to be werewolves / not. */
  myWolfFinds: Set<Seat>;
  myClearFinds: Set<Seat>;
  /** Seats that claimed to be the seer in a speech, with the seat they named. */
  seerClaims: { seat: Seat; named: Seat | null; day: number }[];
  /** Seats that claimed to be the doctor. */
  doctorClaims: Set<Seat>;
  /** Night deaths in order: {night, died, role}. */
  nightDeaths: { night: number; died: Seat; role: Role | null }[];
  /** The current night's wolf votes (seat -> target). */
  tonightWolfVotes: Map<Seat, Seat | null>;
  lastProtectSeat: Seat | null;
  day: number;
}

function analyse(view: View): GameState {
  const me = view.you.seat;
  const myRole = view.you.role;
  const partner = view.you.partner ? view.you.partner.seat : null;
  const alive = view.players.filter((p) => p.alive).map((p) => p.seat);
  const deadRole = new Map<Seat, Role>();
  for (const p of view.players) {
    if (!p.alive && p.role) deadRole.set(p.seat, p.role);
  }
  const votesByDay = new Map<number, Map<Seat, Seat | null>>();
  const speechesByDay = new Map<number, Map<Seat, string[]>>();
  const seerClaims: GameState['seerClaims'] = [];
  const doctorClaims = new Set<Seat>();
  const nightDeaths: GameState['nightDeaths'] = [];
  for (const e of view.log) {
    if (e.kind === 'vote' && typeof e.seat === 'number') {
      let day = votesByDay.get(e.day);
      if (!day) {
        day = new Map();
        votesByDay.set(e.day, day);
      }
      day.set(e.seat, typeof e.target === 'number' ? e.target : null);
    } else if (e.kind === 'speech' && typeof e.seat === 'number' && typeof e.text === 'string') {
      let day = speechesByDay.get(e.day);
      if (!day) {
        day = new Map();
        speechesByDay.set(e.day, day);
      }
      const list = day.get(e.seat) ?? [];
      list.push(e.text);
      day.set(e.seat, list);
      const t = e.text.toLowerCase();
      if (/\b(i am|i'm|im) the seer\b/.test(t) || /\bseer here\b/.test(t)) {
        const m = t.match(/seat\s*(\d+)/);
        seerClaims.push({ seat: e.seat, named: m ? Number(m[1]) : null, day: e.day });
      }
      if (/\b(i am|i'm|im) the doctor\b/.test(t) || /\bdoctor here\b/.test(t)) {
        doctorClaims.add(e.seat);
      }
    } else if (e.kind === 'dawn' && typeof e.died === 'number') {
      nightDeaths.push({ night: e.day - 1, died: e.died, role: (e.role as Role | null) ?? null });
    }
  }
  const myWolfFinds = new Set<Seat>();
  const myClearFinds = new Set<Seat>();
  for (const r of view.seerResults ?? []) {
    if (r.werewolf) myWolfFinds.add(r.seat);
    else myClearFinds.add(r.seat);
  }
  const tonightWolfVotes = new Map<Seat, Seat | null>();
  for (const v of view.wolfVotes ?? []) {
    if (v.night === view.day) tonightWolfVotes.set(v.seat, v.target);
  }
  return {
    me,
    myRole,
    partner,
    alive,
    deadRole,
    votesByDay,
    speechesByDay,
    myWolfFinds,
    myClearFinds,
    seerClaims,
    doctorClaims,
    nightDeaths,
    tonightWolfVotes,
    lastProtectSeat: view.lastProtect ? view.lastProtect.seat : null,
    day: view.day,
  };
}

/** How many speeches a seat made, and how many accused someone (named a seat). */
function speechStats(st: GameState, seat: Seat): { count: number; accused: Set<Seat> } {
  let count = 0;
  const accused = new Set<Seat>();
  for (const day of st.speechesByDay.values()) {
    for (const text of day.get(seat) ?? []) {
      count += 1;
      const low = text.toLowerCase();
      for (const m of low.matchAll(/seat\s*(\d+)/g)) accused.add(Number(m[1]));
      if (/\b(suspect|wolf|werewolf|vote (him|her|them|out)|exile)\b/.test(low)) {
        // An accusation names a seat; the seat numbers above are the targets.
      }
    }
  }
  return { count, accused };
}

/**
 * Suspicion of each living seat, from the village's point of view.
 * Positive = more likely a werewolf. A seer-confirmed wolf scores 1000,
 * a seer-cleared seat -1000.
 */
function suspicion(st: GameState): Map<Seat, number> {
  const score = new Map<Seat, number>();
  const living = st.alive.filter((s) => s !== st.me);
  for (const s of living) score.set(s, 0);
  const add = (seat: Seat, n: number) => {
    if (score.has(seat)) score.set(seat, (score.get(seat) ?? 0) + n);
  };
  // Seer results are certain.
  for (const s of st.myWolfFinds) score.set(s, 1000);
  for (const s of st.myClearFinds) score.set(s, -1000);
  // Votes: voting to exile a revealed villager is damning; voting to exile
  // a revealed werewolf clears. Voting for a confirmed wolf is good.
  for (const day of st.votesByDay.values()) {
    for (const [voter, target] of day) {
      if (target === null || voter === st.me) continue;
      const role = st.deadRole.get(target);
      if (role === 'villager' || role === 'seer' || role === 'doctor') add(voter, 3);
      else if (role === 'werewolf') add(voter, -3);
    }
  }
  // Speeches: accusing a revealed villager is damning; accusing a revealed
  // werewolf clears. (Accusations are the "seat N" mentions in speeches.)
  for (const day of st.speechesByDay.values()) {
    for (const [speaker, texts] of day) {
      if (speaker === st.me) continue;
      for (const text of texts) {
        const low = text.toLowerCase();
        if (!/\b(suspect|wolf|werewolf|vote|exile)\b/.test(low)) continue;
        for (const m of low.matchAll(/seat\s*(\d+)/g)) {
          const target = Number(m[1]);
          const role = st.deadRole.get(target);
          if (role === 'villager' || role === 'seer' || role === 'doctor') add(speaker, 2);
          else if (role === 'werewolf') add(speaker, -2);
        }
      }
    }
  }
  // Seer claims: a claimer whose named seat turned out to be a werewolf is
  // likely the real seer (clear them); one whose named seat turned out to
  // be a villager is likely a lying wolf.
  for (const c of st.seerClaims) {
    if (c.named === null) continue;
    const role = st.deadRole.get(c.named);
    if (role === 'werewolf') add(c.seat, -4);
    else if (role === 'villager' || role === 'seer' || role === 'doctor') add(c.seat, 4);
  }
  // Night kills: the wolves kill players dangerous to them. A player who
  // accused someone and then died that night lends that someone suspicion.
  for (const d of st.nightDeaths) {
    const victim = d.died;
    // Who had the victim accused (in the day before the death)?
    for (const [dayNum, day] of st.speechesByDay) {
      if (dayNum !== d.night) continue;
      for (const text of day.get(victim) ?? []) {
        const low = text.toLowerCase();
        for (const m of low.matchAll(/seat\s*(\d+)/g)) {
          add(Number(m[1]), 1);
        }
      }
    }
  }
  // A dead werewolf's partner is the other wolf: if a revealed werewolf
  // often voted with a living seat, that seat is suspect. (Weak signal.)
  return score;
}

/** Living seats sorted by suspicion, highest first; ties break by seat. */
function rankedSuspects(st: GameState, exclude: Set<Seat>, rng: () => number): Seat[] {
  const score = suspicion(st);
  const seats = st.alive.filter((s) => s !== st.me && !exclude.has(s));
  const jitter = new Map<Seat, number>();
  for (const s of seats) jitter.set(s, rng());
  return seats.sort((a, b) => {
    const d = (score.get(b) ?? 0) - (score.get(a) ?? 0);
    if (d !== 0) return d;
    return (jitter.get(a) ?? 0) - (jitter.get(b) ?? 0);
  });
}

/** The most talkative living villager (a good night-kill target for wolves). */
function mostTalkative(st: GameState, exclude: Set<Seat>): Seat | null {
  let best: Seat | null = null;
  let bestCount = -1;
  for (const s of st.alive) {
    if (s === st.me || exclude.has(s)) continue;
    const c = speechStats(st, s).count;
    if (c > bestCount) {
      bestCount = c;
      best = s;
    }
  }
  return best;
}

/** A seat that claimed seer and is alive (dangerous to the wolves). */
function livingSeerClaim(st: GameState): Seat | null {
  for (const c of st.seerClaims) {
    if (st.alive.includes(c.seat) && c.seat !== st.me) return c.seat;
  }
  return null;
}

/** Did a seat ever vote for a seat that turned out to be a villager, seer or doctor? */
function votedForVillager(st: GameState, seat: Seat): boolean {
  for (const day of st.votesByDay.values()) {
    const target = day.get(seat);
    if (target !== null && target !== undefined) {
      const role = st.deadRole.get(target);
      if (role === 'villager' || role === 'seer' || role === 'doctor') return true;
    }
  }
  return false;
}

/** How many times a seat accused a seat that turned out to be a werewolf. */
function wolfAccusations(st: GameState, seat: Seat): number {
  let n = 0;
  for (const day of st.speechesByDay.values()) {
    for (const text of day.get(seat) ?? []) {
      const low = text.toLowerCase();
      if (!/\b(suspect|wolf|werewolf|vote|exile)\b/.test(low)) continue;
      for (const m of low.matchAll(/seat\s*(\d+)/g)) {
        if (st.deadRole.get(Number(m[1])) === 'werewolf') n += 1;
      }
    }
  }
  return n;
}

/** A seat that accused me or my partner in a speech. */
function accusersOf(st: GameState, target: Seat): Seat[] {
  const out: Seat[] = [];
  for (const day of st.speechesByDay.values()) {
    for (const [speaker, texts] of day) {
      if (speaker === st.me || speaker === target) continue;
      for (const text of texts) {
        const low = text.toLowerCase();
        if (low.includes(`seat ${target}`) && /\b(suspect|wolf|werewolf|vote|exile)\b/.test(low)) {
          out.push(speaker);
          break;
        }
      }
    }
  }
  return [...new Set(out)];
}

function decideKill(st: GameState, options: Seat[]): Seat | null {
  // Second wolf: match the partner's pick so the kill happens.
  if (st.partner !== null) {
    const partnerPick = st.tonightWolfVotes.get(st.partner);
    if (partnerPick !== null && partnerPick !== undefined && options.includes(partnerPick)) {
      return partnerPick;
    }
  }
  // First wolf (or partner abstained): pick the most dangerous villager.
  const exclude = new Set<Seat>([st.me, ...(st.partner !== null ? [st.partner] : [])]);
  const seerClaim = livingSeerClaim(st);
  if (seerClaim !== null && options.includes(seerClaim)) return seerClaim;
  const accusers = [...accusersOf(st, st.me), ...(st.partner !== null ? accusersOf(st, st.partner) : [])];
  for (const a of accusers) {
    if (options.includes(a)) return a;
  }
  const talkative = mostTalkative(st, exclude);
  if (talkative !== null && options.includes(talkative)) return talkative;
  return options.length > 0 ? options[0] : null;
}

function decideProtect(st: GameState, options: Seat[]): Seat | null {
  // Protect a revealed seer first (they guide the village), then the
  // villager the wolves most want dead: whoever accused a revealed wolf
  // the most (the wolves kill those who threaten them). Then the most
  // talkative villager. Never the same seat as last night, never myself.
  // (The env never offers my own seat as a protect option, so self-protect
  // is not possible at all.)
  const allowed = options.filter((s) => s !== st.lastProtectSeat && s !== st.me);
  if (allowed.length === 0) return null;
  const seerClaim = livingSeerClaim(st);
  if (seerClaim !== null && allowed.includes(seerClaim)) return seerClaim;
  let best: Seat | null = null;
  let bestN = 0;
  for (const s of allowed) {
    const n = wolfAccusations(st, s);
    if (n > bestN) {
      bestN = n;
      best = s;
    }
  }
  if (best !== null) return best;
  const talkative = mostTalkative(st, new Set([st.me]));
  if (talkative !== null && allowed.includes(talkative)) return talkative;
  return allowed[0];
}

function decideInspect(st: GameState, options: Seat[], rng: () => number): Seat | null {
  // Inspect the most suspicious seat I have not already inspected.
  const done = new Set([...st.myWolfFinds, ...st.myClearFinds]);
  const ranked = rankedSuspects(st, done, rng);
  for (const s of ranked) {
    if (options.includes(s)) return s;
  }
  return options.length > 0 ? options[0] : null;
}

function decideVote(st: GameState, options: Seat[], rng: () => number): Seat | null {
  if (st.myRole === 'werewolf') {
    // Vote for the most suspicious villager: the village's consensus target.
    // Never vote for my partner.
    const exclude = new Set<Seat>(st.partner !== null ? [st.partner] : []);
    const ranked = rankedSuspects(st, exclude, rng);
    for (const s of ranked) {
      if (options.includes(s)) return s;
    }
    return null;
  }
  // Village side: vote the most suspicious seat (a seer-confirmed wolf first).
  const ranked = rankedSuspects(st, new Set(), rng);
  for (const s of ranked) {
    if (options.includes(s)) return s;
  }
  return null;
}

function decideSpeak(st: GameState, maxChars: number, rng: () => number): string | null {
  const name = (seat: Seat): string => `seat ${seat}`;
  if (st.myRole === 'werewolf') {
    // Accuse the most suspicious villager, keep it short and plausible.
    // Only make a claim the record supports: the "voted for a villager"
    // line needs the target to have actually done that, and the "quiet"
    // line needs the target to have barely spoken. An ungrounded claim is
    // a tell the village can check against the public log.
    const exclude = new Set<Seat>(st.partner !== null ? [st.partner] : []);
    const ranked = rankedSuspects(st, exclude, rng);
    const target = ranked.find((s) => st.alive.includes(s));
    if (target === undefined) return null;
    const lines: string[] = [];
    if (votedForVillager(st, target)) {
      lines.push(`${name(target)} voted for a villager yesterday and keeps deflecting. I think ${name(target)} is a wolf.`);
    }
    if (speechStats(st, target).count <= 1) {
      lines.push(`${name(target)} has been quiet when it mattered and pointed at villagers. My vote is ${name(target)}.`);
    }
    lines.push(`Watch ${name(target)}: their votes do not add up. I suspect ${name(target)}.`);
    return cutStatement(lines[Math.floor(rng() * lines.length)], maxChars);
  }
  if (st.myRole === 'seer' && st.myWolfFinds.size > 0) {
    // Reveal a confirmed wolf.
    const wolf = [...st.myWolfFinds].find((s) => st.alive.includes(s));
    if (wolf !== undefined) {
      return cutStatement(
        `I am the seer. I inspected ${name(wolf)} and they are a werewolf. Vote ${name(wolf)} out.`,
        maxChars,
      );
    }
  }
  if (st.myRole === 'seer' && st.seerClaims.some((c) => c.seat !== st.me && st.alive.includes(c.seat))) {
    // Another seer claim exists; stay quiet about my own role for now.
  }
  // Village side (villager, doctor, or seer without a find): accuse the
  // most suspicious seat and give a reason. The vote-based reason is only
  // used when the target really did vote for a revealed villager.
  const ranked = rankedSuspects(st, new Set(), rng);
  const target = ranked.find((s) => st.alive.includes(s));
  if (target === undefined) return null;
  const reason =
    votedForVillager(st, target)
      ? `${name(target)} voted against villagers who turned out innocent.`
      : `${name(target)} has been deflecting instead of helping find the wolves.`;
  return cutStatement(`I suspect ${name(target)}: ${reason} My vote is ${name(target)}.`, maxChars);
}

/** One decision, computed from that game's view alone. */
function decide(p: Pending, seed: string): Record<string, unknown> {
  const rng = rngFrom(`${seed}|game-${p.game}`);
  const st = analyse(p.view);
  const options = p.options ?? [];
  switch (p.decision) {
    case 'kill':
      return { game: p.game, decision: 'kill', target: decideKill(st, options) };
    case 'protect':
      return { game: p.game, decision: 'protect', target: decideProtect(st, options) };
    case 'inspect':
      return { game: p.game, decision: 'inspect', target: decideInspect(st, options, rng) };
    case 'vote':
      return { game: p.game, decision: 'vote', target: decideVote(st, options, rng) };
    case 'speak': {
      const text = decideSpeak(st, p.max_chars ?? 500, rng);
      return text === null
        ? { game: p.game, decision: 'speak', pass: true }
        : { game: p.game, decision: 'speak', text };
    }
  }
}

const fallbackFor = (p: Pending): Record<string, unknown> =>
  p.decision === 'speak'
    ? { game: p.game, decision: 'speak', pass: true }
    : { game: p.game, decision: p.decision, target: null };

async function main(): Promise<void> {
  const env = process.env;
  const envUrl = (env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (envUrl === '') throw new Error('MAKEFUN_ENV_URL is needed');
  const seed = env.MAKEFUN_TRIAL_SEED ?? 'werewolf-agent-01';
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const envPost = async (path: string, body: unknown) => {
    const res = await fetch(`${envUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  let decisions = 0;
  const keyOf = (p: Pending): string => `${p.game}:${p.decision}:${p.view.log.length}`;
  const inFlight = new Map<string, Promise<void>>();
  const started = new Set<string>();
  const errors: string[] = [];
  for (;;) {
    const r = await envPost('/observe', {});
    if (r.status !== 200 || !isRecord(r.body)) throw new Error(`POST /observe answered ${r.status}`);
    const obs = r.body as unknown as Observed;
    if (obs.done) break;
    for (const p of obs.pending) {
      const key = keyOf(p);
      if (started.has(key) || inFlight.size >= CONCURRENCY) continue;
      started.add(key);
      const task = (async () => {
        decisions += 1;
        let act: Record<string, unknown>;
        try {
          act = decide(p, seed);
        } catch {
          act = fallbackFor(p);
        }
        let posted = await envPost('/act', act);
        if (posted.status === 400 && JSON.stringify(act) !== JSON.stringify(fallbackFor(p))) {
          posted = await envPost('/act', fallbackFor(p));
        }
        if (posted.status !== 200) {
          throw new Error(`POST /act for game ${p.game} answered ${posted.status}`);
        }
      })()
        .catch((err: unknown) => {
          errors.push(`game ${p.game}: ${(err as Error).message}`);
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, task);
    }
    const waiting = obs.pending.some((p) => !started.has(keyOf(p)));
    if (inFlight.size > 0 && (inFlight.size >= CONCURRENCY || !waiting)) {
      await Promise.race(inFlight.values());
    } else if (inFlight.size === 0 && obs.pending.length > 0 && !waiting) {
      await sleep(250);
    }
    if (errors.length > 0) break;
  }
  await Promise.all(inFlight.values());
  if (errors.length > 0) throw new Error(`the env failed: ${errors.join('; ')}`);
  process.stdout.write(`werewolf-agent: ${decisions} decisions answered, scripted (no model calls)\n`);
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    await main();
    process.exitCode = 0;
  } catch (err) {
    process.stderr.write(`werewolf-agent: ${(err as Error).stack ?? String(err)}\n`);
    process.exitCode = 1;
  }
}
