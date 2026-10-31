// Spellbound Chess cards.
// Every card's apply(state, color) mutates a cloned state and returns a message.
// applyCard() wraps it: if the effect would create a NEW check on either king, it retries
// (random targets may differ) and finally fizzles, so card effects never cause instant king captures.

const E = require('./engine');
const { row, col, opp, mkPiece, cloneState, inCheck, updateCastling, VALUES } = E;

const RARITY_WEIGHTS = { common: 60, rare: 40, epic: 20, legendary: 10, event: 1 };

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const NAME = { w: 'White', b: 'Black' };
const promoRow = (c, s) => (s && s.fourDim ? (c === 'w' ? 5 : 2) : c === 'w' ? 7 : 0);
const backRow = (c, s) => (s && s.fourDim ? (c === 'w' ? 2 : 5) : c === 'w' ? 0 : 7);
const fwd = (c) => (c === 'w' ? 8 : -8);
const PIECE_NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

function squares(state, pred) {
  const res = [];
  state.board.forEach((p, s) => {
    if (state.fourDim && !E.inSqBounds(state, s)) return;
    if (pred(p, s)) res.push(s);
  });
  return res;
}
const mine = (state, s) => state.mines.some((m) => m.sq === s);
const ownOf = (c, types) => (p) =>
  p &&
  p.c === c &&
  (!types || ((!E.hasType(p, 'k') || types.includes('k')) && [...types].some((t) => E.hasType(p, t))));
const emptyFree = (state) => (p, s) => !p && !mine(state, s);

function removeAt(state, s) {
  const p = state.board[s];
  if (!p || E.hasType(p, 'k')) return;
  E.recordLost(state, p);
  state.board[s] = null;
}
function demote(state, s) {
  const p = state.board[s];
  if (!p || E.hasType(p, 'k')) return;
  if (row(s) === promoRow(p.c, state)) removeAt(state, s);
  else {
    p.t = 'p';
    if (Array.isArray(p.layers)) p.layers = ['p'];
  }
}
// Effect movement. Enemy landmines still go off.
function placeMove(state, from, to) {
  const b = state.board;
  const p = b[from];
  b[to] = p;
  b[from] = null;
  const mi = state.mines.findIndex((x) => x.sq === to && x.owner !== p.c);
  if (mi >= 0) {
    state.mines.splice(mi, 1);
    if (!E.hasType(p, 'k')) {
      removeAt(state, to);
      return true;
    }
  }
  return false;
}
function normalize(state) {
  state.board.forEach((p, s) => {
    if (p && E.hasType(p, 'p') && row(s) === promoRow(p.c, state)) {
      if (Array.isArray(p.layers) && p.layers.length) {
        p.layers = p.layers.map((lt) => (lt === 'p' ? 'q' : lt));
      }
      if (p.t === 'p') p.t = 'q';
    }
  });
  updateCastling(state);
}
const checks = (state) => ({ w: inCheck(state, 'w'), b: inCheck(state, 'b') });
const newCheck = (state, before) => ['w', 'b'].some((c) => !before[c] && inCheck(state, c));

function convertPieceType(p, from, to) {
  if (!p) return;
  if (Array.isArray(p.layers) && p.layers.length) {
    p.layers = p.layers.map((lt) => ([...from].includes(lt) ? to : lt));
  }
  if ([...from].includes(p.t) && p.t !== 'k') p.t = to;
}

function convertAll(state, c, from, to) {
  const list = squares(state, ownOf(c, from));
  list.forEach((s) => convertPieceType(state.board[s], from, to));
  return list.length;
}
function convertOne(state, c, from, to) {
  const list = squares(state, ownOf(c, from));
  if (!list.length) return null;
  const s = pick(list);
  convertPieceType(state.board[s], from, to);
  return s;
}

const CARDS = [
  // ---------------- COMMON ----------------
  {
    id: 'sprint', name: 'Sprint', rarity: 'common', icon: '🏃',
    desc: 'A random pawn of yours dashes forward up to 2 squares.',
    canPlay: (s, c) => squares(s, (p, sq) => ownOf(c, 'p')(p) && E.inSqBounds(s, sq + fwd(c)) && !s.board[sq + fwd(c)] && row(sq + fwd(c)) !== promoRow(c, s)).length > 0,
    apply(s, c) {
      const list = squares(s, (p, sq) => ownOf(c, 'p')(p) && E.inSqBounds(s, sq + fwd(c)) && !s.board[sq + fwd(c)] && row(sq + fwd(c)) !== promoRow(c, s));
      if (!list.length) return `${NAME[c]} had no pawn able to sprint.`;
      const from = pick(list);
      let to = from + fwd(c);
      const two = to + fwd(c);
      if (E.inSqBounds(s, two) && !s.board[two] && row(two) !== promoRow(c, s)) to = two;
      const boom = placeMove(s, from, to);
      return boom ? `${NAME[c]}'s pawn sprinted straight onto a landmine! 💥` : `${NAME[c]}'s pawn sprinted forward!`;
    },
  },
  {
    id: 'pothole', name: 'Pothole', rarity: 'common', icon: '🕳️',
    desc: 'A random enemy pawn falls into a pothole and is gone.',
    canPlay: (s, c) => squares(s, ownOf(opp(c), 'p')).length > 0,
    apply(s, c) {
      const list = squares(s, ownOf(opp(c), 'p'));
      if (!list.length) return `No ${NAME[opp(c)]} pawns to swallow.`;
      removeAt(s, pick(list));
      return `A ${NAME[opp(c)]} pawn fell into a pothole!`;
    },
  },
  {
    id: 'reinforce', name: 'Reinforcements', rarity: 'common', icon: '🪖',
    desc: 'Spawn a new pawn on a random empty square of your 2nd rank.',
    canPlay: (s, c) => {
      const r = s.fourDim ? (c === 'w' ? 3 : 4) : (c === 'w' ? 1 : 6);
      return squares(s, (p, sq) => row(sq) === r && emptyFree(s)(p, sq)).length > 0;
    },
    apply(s, c) {
      const r = s.fourDim ? (c === 'w' ? 3 : 4) : (c === 'w' ? 1 : 6);
      const list = squares(s, (p, sq) => row(sq) === r && emptyFree(s)(p, sq));
      if (!list.length) return `${NAME[c]}'s 2nd rank is full — no room for reinforcements.`;
      s.board[pick(list)] = mkPiece('p', c);
      return `${NAME[c]} received a fresh pawn!`;
    },
  },
  {
    id: 'pawnStorm', name: 'Pawn Storm', rarity: 'common', icon: '🌪️',
    desc: 'All your pawns step forward 1 square if it is free.',
    canPlay: (s, c) => squares(s, (p, sq) => ownOf(c, 'p')(p) && E.inSqBounds(s, sq + fwd(c)) && !s.board[sq + fwd(c)] && row(sq + fwd(c)) !== promoRow(c, s)).length > 0,
    apply(s, c) {
      const list = squares(s, ownOf(c, 'p')).sort((a, b) => (c === 'w' ? b - a : a - b));
      let n = 0;
      for (const from of list) {
        const to = from + fwd(c);
        if (!E.inSqBounds(s, to) || s.board[to] || row(to) === promoRow(c, s)) continue;
        const before = checks(s);
        const s2 = cloneState(s);
        placeMove(s2, from, to);
        if (newCheck(s2, before)) continue;
        Object.assign(s, s2);
        n++;
      }
      return `${n} ${NAME[c]} pawn${n === 1 ? '' : 's'} stormed forward!`;
    },
  },
  {
    id: 'slippery', name: 'Slippery Floor', rarity: 'common', icon: '🧼',
    desc: 'Up to 2 random enemy pawns slide back 1 square.',
    canPlay: (s, c) => {
      const o = opp(c);
      return squares(s, (p, sq) => ownOf(o, 'p')(p) && E.inSqBounds(s, sq - fwd(o)) &&
        !s.board[sq - fwd(o)] && row(sq - fwd(o)) !== backRow(o, s)).length > 0;
    },
    apply(s, c) {
      const o = opp(c);
      const list = shuffle(squares(s, (p, sq) => ownOf(o, 'p')(p) && E.inSqBounds(s, sq - fwd(o)) &&
        !s.board[sq - fwd(o)] && row(sq - fwd(o)) !== backRow(o, s)));
      const chosen = list.slice(0, 2);
      chosen.forEach((sq) => placeMove(s, sq, sq - fwd(o)));
      return chosen.length ? `${chosen.length} ${NAME[o]} pawn${chosen.length > 1 ? 's' : ''} slipped backwards!` : 'Nobody slipped.';
    },
  },
  {
    id: 'freeze', name: 'Freeze Ray', rarity: 'common', icon: '❄️',
    desc: 'A random enemy piece (not the king) is frozen for 2 turns.',
    canPlay: (s, c) => squares(s, (p) => p && p.c === opp(c) && p.t !== 'k').length > 0,
    apply(s, c) {
      const list = squares(s, (p) => p && p.c === opp(c) && p.t !== 'k');
      if (!list.length) return 'Nothing to freeze.';
      const sq = pick(list);
      s.board[sq].frozen = 2;
      return `${NAME[opp(c)]}'s ${PIECE_NAME[s.board[sq].t]} got frozen solid! ❄️`;
    },
  },
  {
    id: 'bodyguard', name: 'Bodyguard', rarity: 'common', icon: '🛡️',
    desc: "A random piece of yours can't be captured for 2 enemy turns.",
    canPlay: (s, c) => squares(s, (p) => p && p.c === c && p.t !== 'k').length > 0,
    apply(s, c) {
      const list = squares(s, (p) => p && p.c === c && p.t !== 'k');
      if (!list.length) return 'Nobody to protect.';
      const sq = pick(list);
      s.board[sq].shield = Math.max(s.board[sq].shield || 0, 2);
      return `${NAME[c]}'s ${PIECE_NAME[s.board[sq].t]} hired a bodyguard!`;
    },
  },
  {
    id: 'knighthood', name: 'Knighthood', rarity: 'common', icon: '🐴',
    desc: 'A random pawn of yours becomes a knight.',
    canPlay: (s, c) => squares(s, ownOf(c, 'p')).length > 0,
    apply(s, c) {
      return convertOne(s, c, 'p', 'n') != null ? `A ${NAME[c]} pawn was knighted!` : `${NAME[c]} has no pawns to knight.`;
    },
  },
  {
    id: 'holyOrders', name: 'Holy Orders', rarity: 'common', icon: '⛪',
    desc: 'A random pawn of yours becomes a bishop.',
    canPlay: (s, c) => squares(s, ownOf(c, 'p')).length > 0,
    apply(s, c) {
      return convertOne(s, c, 'p', 'b') != null ? `A ${NAME[c]} pawn joined the clergy!` : `${NAME[c]} has no pawns to ordain.`;
    },
  },
  {
    id: 'landmine', name: 'Landmine', rarity: 'common', icon: '💣',
    desc: 'Hide a mine on a random empty square in enemy territory. Enemy pieces (not kings) that step on it explode.',
    canPlay: (s, c) => {
      const rows = s.fourDim ? (c === 'w' ? [4, 5] : [2, 3]) : c === 'w' ? [4, 5, 6, 7] : [0, 1, 2, 3];
      return squares(s, (p, sq) => rows.includes(row(sq)) && emptyFree(s)(p, sq)).length > 0;
    },
    apply(s, c) {
      const rows = s.fourDim ? (c === 'w' ? [4, 5] : [2, 3]) : c === 'w' ? [4, 5, 6, 7] : [0, 1, 2, 3];
      const list = squares(s, (p, sq) => rows.includes(row(sq)) && emptyFree(s)(p, sq));
      if (!list.length) return 'No room for a mine.';
      s.mines.push({ sq: pick(list), owner: c });
      return `${NAME[c]} buried a hidden landmine somewhere... 💣`;
    },
  },
  {
    id: 'banana', name: 'Banana Peel', rarity: 'common', icon: '🍌',
    desc: 'A random enemy piece slips 1 square in a random direction.',
    canPlay: (s, c) => {
      const o = opp(c);
      return squares(s, (p) => p && p.c === o && !E.hasType(p, 'k')).some((sq) => {
        for (const [df, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const f = col(sq) + df;
          const r = row(sq) + dr;
          if (!E.inBoardBounds(s, f, r)) continue;
          const to = r * 8 + f;
          if (s.board[to]) continue;
          if (E.hasType(s.board[sq], 'p') && (r === backRow('w', s) || r === backRow('b', s))) continue;
          return true;
        }
        return false;
      });
    },
    apply(s, c) {
      const o = opp(c);
      const options = [];
      squares(s, (p) => p && p.c === o && !E.hasType(p, 'k')).forEach((sq) => {
        for (const [df, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const f = col(sq) + df;
          const r = row(sq) + dr;
          if (!E.inBoardBounds(s, f, r)) continue;
          const to = r * 8 + f;
          if (s.board[to]) continue;
          if (E.hasType(s.board[sq], 'p') && (r === backRow('w', s) || r === backRow('b', s))) continue;
          options.push([sq, to]);
        }
      });
      if (!options.length) return 'Nobody slipped on the banana.';
      const [from, to] = pick(options);
      const t = s.board[from].t;
      const boom = placeMove(s, from, to);
      return `${NAME[o]}'s ${PIECE_NAME[t]} slipped on a banana!${boom ? ' ...right onto a landmine 💥' : ''}`;
    },
  },
  // ---------------- RARE ----------------
  {
    id: 'fog', name: 'Fog of War', rarity: 'rare', icon: '🌫️',
    desc: 'Your opponent cannot see your pieces (except your king) on their next turn.',
    canPlay: (s, c) => squares(s, (p) => p && p.c === c && p.t !== 'k').length > 0,
    apply(s, c) {
      s.fog[c] = 1;
      return `A thick fog hides ${NAME[c]}'s army! 🌫️`;
    },
  },
  {
    id: 'rust', name: 'Rust', rarity: 'rare', icon: '🦠',
    desc: 'A random enemy knight or bishop rusts into a pawn.',
    canPlay: (s, c) => squares(s, ownOf(opp(c), 'nb')).length > 0,
    apply(s, c) {
      const list = squares(s, ownOf(opp(c), 'nb'));
      if (!list.length) return `${NAME[opp(c)]} has no knights or bishops to rust.`;
      const sq = pick(list);
      const t = s.board[sq].t;
      demote(s, sq);
      return `${NAME[opp(c)]}'s ${PIECE_NAME[t]} rusted into a pawn!`;
    },
  },
  {
    id: 'rookLift', name: 'Rook Lift', rarity: 'rare', icon: '🏰',
    desc: 'A random pawn of yours becomes a rook.',
    canPlay: (s, c) => squares(s, ownOf(c, 'p')).length > 0,
    apply(s, c) {
      return convertOne(s, c, 'p', 'r') != null ? `A ${NAME[c]} pawn became a rook!` : `${NAME[c]} has no pawns.`;
    },
  },
  {
    id: 'conscription', name: 'Conscription', rarity: 'rare', icon: '📜',
    desc: 'A random enemy pawn switches to your side.',
    canPlay: (s, c) => squares(s, ownOf(opp(c), 'p')).length > 0,
    apply(s, c) {
      const list = squares(s, ownOf(opp(c), 'p'));
      if (!list.length) return `${NAME[opp(c)]} has no pawns to draft.`;
      s.board[pick(list)].c = c;
      return `A ${NAME[opp(c)]} pawn was drafted into ${NAME[c]}'s army!`;
    },
  },
  {
    id: 'doubleMove', name: 'Double Move', rarity: 'rare', icon: '⏩',
    desc: 'Make 2 moves on your next turn (if the first gives check, your turn ends).',
    canPlay: (s, c) => !s.extra[c],
    apply(s, c) {
      s.extra[c] = 1;
      return `${NAME[c]} will move twice next turn! ⏩`;
    },
  },
  {
    id: 'earthquake', name: 'Earthquake', rarity: 'rare', icon: '🌋',
    desc: '3 random pawns (from either side) are destroyed.',
    canPlay: (s) => squares(s, (p) => p && p.t === 'p').length > 0,
    apply(s, c) {
      const list = shuffle(squares(s, (p) => p && p.t === 'p')).slice(0, 3);
      list.forEach((sq) => removeAt(s, sq));
      return `An earthquake swallowed ${list.length} pawn${list.length === 1 ? '' : 's'}! 🌋`;
    },
  },
  {
    id: 'castleSwap', name: 'Castle Swap', rarity: 'rare', icon: '🔄',
    desc: 'Your king swaps places with one of your rooks.',
    canPlay: (s, c) => squares(s, ownOf(c, 'r')).length > 0,
    apply(s, c) {
      const k = E.kingSq(s, c);
      const rooks = squares(s, ownOf(c, 'r'));
      if (!rooks.length) return `${NAME[c]} has no rook to swap with.`;
      const r = pick(rooks);
      [s.board[k], s.board[r]] = [s.board[r], s.board[k]];
      return `${NAME[c]}'s king swapped places with a rook!`;
    },
  },
  {
    id: 'iceAge', name: 'Ice Age', rarity: 'rare', icon: '🧊',
    desc: '3 random enemy pieces (not the king) are frozen for 1 turn.',
    canPlay: (s, c) => squares(s, (p) => p && p.c === opp(c) && p.t !== 'k').length > 0,
    apply(s, c) {
      const list = shuffle(squares(s, (p) => p && p.c === opp(c) && p.t !== 'k')).slice(0, 3);
      list.forEach((sq) => (s.board[sq].frozen = Math.max(s.board[sq].frozen || 0, 1)));
      return `An ice age froze ${list.length} ${NAME[opp(c)]} piece${list.length === 1 ? '' : 's'}! 🧊`;
    },
  },
  {
    id: 'clone', name: 'Clone', rarity: 'rare', icon: '🧬',
    desc: 'A random piece of yours (not the king) is cloned onto a free square next to it.',
    canPlay: (s, c) => {
      return squares(s, (p) => p && p.c === c && !E.hasType(p, 'k')).some((sq) => {
        for (const [df, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const f = col(sq) + df;
          const r = row(sq) + dr;
          if (!E.inBoardBounds(s, f, r)) continue;
          const to = r * 8 + f;
          if (s.board[to] || mine(s, to)) continue;
          if (E.hasType(s.board[sq], 'p') && (r === backRow('w', s) || r === backRow('b', s))) continue;
          return true;
        }
        return false;
      });
    },
    apply(s, c) {
      const options = [];
      squares(s, (p) => p && p.c === c && !E.hasType(p, 'k')).forEach((sq) => {
        for (const [df, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const f = col(sq) + df;
          const r = row(sq) + dr;
          if (!E.inBoardBounds(s, f, r)) continue;
          const to = r * 8 + f;
          if (s.board[to] || mine(s, to)) continue;
          if (E.hasType(s.board[sq], 'p') && (r === backRow('w', s) || r === backRow('b', s))) continue;
          options.push([sq, to]);
        }
      });
      if (!options.length) return 'No room to clone anything.';
      const [from, to] = pick(options);
      const cloneP = mkPiece(s.board[from].t, c);
      if (s.board[from].layers) cloneP.layers = [...s.board[from].layers];
      s.board[to] = cloneP;
      return `${NAME[c]} cloned a ${PIECE_NAME[s.board[from].t]}! 🧬`;
    },
  },
  // ---------------- EPIC ----------------
  {
    id: 'suitUp', name: 'Suit Up', rarity: 'epic', icon: '🦄',
    desc: 'All your pawns become knights.',
    canPlay: (s, c) => squares(s, ownOf(c, 'p')).length > 0,
    apply(s, c) {
      const n = convertAll(s, c, 'p', 'n');
      return `${NAME[c]} suited up — ${n} pawn${n === 1 ? '' : 's'} became knights!`;
    },
  },
  {
    id: 'genderBend', name: 'Gender Bend', rarity: 'epic', icon: '💅',
    desc: 'Your king turns pink and moves like a queen. (If it gets captured, you still lose!)',
    canPlay: (s, c) => {
      const k = E.kingSq(s, c);
      return k >= 0 && !s.board[k].pink && !s.board[k].shotgun;
    },
    apply(s, c) {
      const k = E.kingSq(s, c);
      if (k < 0 || s.board[k].pink || s.board[k].shotgun) return `${NAME[c]}'s king cannot use Gender Bend.`;
      s.board[k].pink = true;
      return `${NAME[c]}'s king is now pink and moves like a queen! 💅`;
    },
  },
  {
    id: 'mutiny', name: 'Mutiny', rarity: 'epic', icon: '🏴‍☠️',
    desc: 'A random enemy knight, bishop or rook switches to your side.',
    canPlay: (s, c) => squares(s, ownOf(opp(c), 'nbr')).length > 0,
    apply(s, c) {
      const list = squares(s, ownOf(opp(c), 'nbr'));
      if (!list.length) return `${NAME[opp(c)]} has nobody left to mutiny.`;
      const sq = pick(list);
      s.board[sq].c = c;
      s.board[sq].frozen = 0;
      return `${NAME[opp(c)]}'s ${PIECE_NAME[s.board[sq].t]} mutinied and joined ${NAME[c]}! 🏴‍☠️`;
    },
  },
  {
    id: 'backstab', name: 'Backstab', rarity: 'epic', icon: '🗡️',
    desc: 'An enemy queen is demoted to a pawn.',
    canPlay: (s, c) => squares(s, ownOf(opp(c), 'q')).length > 0,
    apply(s, c) {
      const list = squares(s, ownOf(opp(c), 'q'));
      if (!list.length) return `${NAME[opp(c)]} has no queen to backstab.`;
      demote(s, pick(list));
      return `${NAME[opp(c)]}'s queen got backstabbed into a pawn! 🗡️`;
    },
  },
  {
    id: 'necromancy', name: 'Necromancy', rarity: 'epic', icon: '💀',
    desc: 'Your most valuable lost piece rises from the dead.',
    canPlay: (s, c) => s.lost[c].some((t) => t !== 'k') && squares(s, emptyFree(s)).length > 0,
    apply(s, c) {
      const lost = s.lost[c].filter((t) => t !== 'k');
      if (!lost.length) return `${NAME[c]} has no fallen pieces to raise.`;
      const t = lost.sort((a, b) => VALUES[b] - VALUES[a])[0];
      const homes = { q: [3], r: [0, 7], b: [2, 5], n: [1, 6], p: [8, 9, 10, 11, 12, 13, 14, 15] }[t];
      const flip = (sq) => (c === 'w' ? sq : sq ^ 56);
      const free = (sq) => E.inSqBounds(s, sq) && !s.board[sq] && !mine(s, sq);
      let target = s.fourDim ? null : homes.map(flip).find(free);
      if (target == null) {
        const pref = squares(s, (p, sq) => free(sq) && (t === 'p' ? row(sq) !== backRow('w', s) && row(sq) !== backRow('b', s) : true));
        pref.sort((a, b) => Math.abs(row(a) - backRow(c, s)) - Math.abs(row(b) - backRow(c, s)));
        target = pref[0];
      }
      if (target == null) return 'No room for the undead.';
      s.lost[c].splice(s.lost[c].indexOf(t), 1);
      s.board[target] = mkPiece(t, c);
      return `${NAME[c]} raised a ${PIECE_NAME[t]} from the dead! 💀`;
    },
  },
  {
    id: 'holyShield', name: 'Holy Shield', rarity: 'epic', icon: '✨',
    desc: "None of your pieces can be captured on your opponent's next turn.",
    canPlay: (s, c) => squares(s, (p) => p && p.c === c && p.t !== 'k').length > 0,
    apply(s, c) {
      squares(s, (p) => p && p.c === c && p.t !== 'k').forEach((sq) => (s.board[sq].shield = Math.max(s.board[sq].shield || 0, 1)));
      return `${NAME[c]}'s army is blessed with a Holy Shield! ✨`;
    },
  },
  {
    id: 'timeStop', name: 'Time Stop', rarity: 'epic', icon: '⏸️',
    desc: 'Your opponent skips their next turn (unless they are in check).',
    canPlay: (s, c) => !s.skip[opp(c)],
    apply(s, c) {
      s.skip[opp(c)] = 1;
      return `ZA WARUDO! ${NAME[opp(c)]} will skip their next turn! ⏸️`;
    },
  },
  {
    id: 'doublePick', name: 'Pot of Greed', rarity: 'epic', icon: '🃏',
    desc: 'In the next card selection, you get to choose 2 cards instead of 1!',
    canPlay: (s, c) => (s.nextCardPicks?.[c] || 1) < 2,
    apply(s, c) {
      s.nextCardPicks[c] = 2;
      return `🃏 ${NAME[c]} will choose 2 cards in the next card phase!`;
    },
  },
  // ---------------- LEGENDARY ----------------
  {
    id: 'smite', name: 'I Cast Death Upon Your Soldiers', rarity: 'legendary', icon: '☠️',
    desc: 'Smite ALL enemy pawns.',
    canPlay: (s, c) => squares(s, ownOf(opp(c), 'p')).length > 0,
    apply(s, c) {
      const list = squares(s, ownOf(opp(c), 'p'));
      let count = 0;
      for (const sq of list) {
        const saved = s.board[sq];
        removeAt(s, sq);
        // Only spare an enemy pawn if removing it would expose the caster's OWN king to an illegal discovered check when it isn't the caster's turn
        if (s.turn !== c && inCheck(s, c)) {
          s.board[sq] = saved;
          s.lost[saved.c].pop();
        } else {
          count++;
        }
      }
      return `☠️ ${NAME[c]} cast death upon ${count} ${NAME[opp(c)]} soldiers!`;
    },
  },
  {
    id: 'queensGambit', name: "Queen's Gambit", rarity: 'legendary', icon: '👑',
    desc: 'All your pawns become queens.',
    canPlay: (s, c) => squares(s, ownOf(c, 'p')).length > 0,
    apply(s, c) {
      const n = convertAll(s, c, 'p', 'q');
      return `👑 ${n} ${NAME[c]} pawn${n === 1 ? '' : 's'} became QUEENS!`;
    },
  },
  {
    id: 'thanos', name: 'Thanos Snap', rarity: 'legendary', icon: '🫰',
    desc: "Half of the enemy's pieces (not the king) turn to dust.",
    canPlay: (s, c) => squares(s, (p) => p && p.c === opp(c) && p.t !== 'k').length > 0,
    apply(s, c) {
      const list = shuffle(squares(s, (p) => p && p.c === opp(c) && p.t !== 'k'));
      const gone = list.slice(0, Math.ceil(list.length / 2));
      gone.forEach((sq) => removeAt(s, sq));
      return `🫰 *snap* — ${gone.length} ${NAME[opp(c)]} pieces turned to dust.`;
    },
  },
  {
    id: 'royalDecree', name: 'Royal Decree', rarity: 'legendary', icon: '📯',
    desc: 'All enemy rooks, bishops and knights are demoted to pawns.',
    canPlay: (s, c) => squares(s, ownOf(opp(c), 'rbn')).length > 0,
    apply(s, c) {
      const list = squares(s, ownOf(opp(c), 'rbn'));
      list.forEach((sq) => demote(s, sq));
      return `📯 By royal decree, ${list.length} ${NAME[opp(c)]} officers were demoted to pawns!`;
    },
  },
  {
    id: 'armyOfDarkness', name: 'Army of Darkness', rarity: 'legendary', icon: '🦇',
    desc: 'Fill your 3rd rank with pawns. All your pawns are uncapturable for 2 turns.',
    canPlay: (s, c) => {
      const r = s.fourDim ? (c === 'w' ? 3 : 4) : c === 'w' ? 2 : 5;
      return squares(s, (p, sq) => row(sq) === r && emptyFree(s)(p, sq)).length > 0 || squares(s, ownOf(c, 'p')).length > 0;
    },
    apply(s, c) {
      const r = s.fourDim ? (c === 'w' ? 3 : 4) : c === 'w' ? 2 : 5;
      const list = squares(s, (p, sq) => row(sq) === r && emptyFree(s)(p, sq));
      list.forEach((sq) => (s.board[sq] = mkPiece('p', c)));
      squares(s, ownOf(c, 'p')).forEach((sq) => (s.board[sq].shield = Math.max(s.board[sq].shield || 0, 2)));
      return `🦇 ${list.length} dark soldiers rose for ${NAME[c]}, and all their pawns are shielded!`;
    },
  },
  {
    id: 'shotgunKing', name: 'King with a Shotgun', rarity: 'legendary', icon: '🔫',
    desc: 'Give king a shotgun (last piece). Shoots a 3-bullet spread: 1-shots & pierces pawns! (N/B/R/K = 3 HP, Queen = 5 HP)',
    canPlay: (s, c) => {
      if (s.board.some((p) => p && p.t === 'k' && p.shotgun)) return false;
      const k = E.kingSq(s, c);
      return k >= 0 && !s.board[k].pink;
    },
    apply(s, c) {
      if (s.board.some((p) => p && p.t === 'k' && p.shotgun)) return 'Another king already holds the shotgun!';
      const k = E.kingSq(s, c);
      if (k < 0 || s.board[k].pink) return `${NAME[c]}'s king cannot wield the shotgun.`;
      s.board[k].shotgun = true;
      return `🔫 ${NAME[c]}'s King is now armed with a SHOTGUN for Last King Standing!`;
    },
  },
  // ---------------- EVENT ----------------
  {
    id: 'distortedView', name: 'Distorted View', rarity: 'event', icon: '🌀',
    desc: 'Cut the chessboard into 4 quadrants (4×4) and shuffle them around (horizontally, vertically, and diagonally)!',
    canPlay: () => true,
    apply(s) {
      // 4 quadrants: 0 = Bottom-Left, 1 = Bottom-Right, 2 = Top-Left, 3 = Top-Right
      // Candidate permutations (perm[newQ] = oldQ) where all 4 quadrants move, heavily featuring diagonal swaps:
      const CANDIDATES = [
        [3, 2, 1, 0], // Pure X-diagonal swap: BL <-> TR and BR <-> TL (all 4 move diagonally!)
        [3, 2, 1, 0], // Extra weight for pure X-diagonal swap
        [3, 2, 1, 0], // Extra weight for pure X-diagonal swap
        [2, 3, 1, 0], // Diagonal + vertical: BL -> TR, BR -> TL, TL -> BL, TR -> BR
        [3, 2, 0, 1], // Diagonal + vertical: TL -> BR, TR -> BL, BL -> TL, BR -> TR
        [1, 2, 3, 0], // Diagonal + horizontal: BL -> TR, TL -> BR, BR -> BL, TR -> TL
        [3, 0, 1, 2], // Diagonal + horizontal: BR -> TL, TR -> BL, BL -> BR, TL -> TR
        [2, 0, 3, 1], // 4-way cycle (rotational shuffle)
        [1, 3, 0, 2], // 4-way cycle (counter-rotational shuffle)
        [2, 3, 0, 1], // Vertical swap: BL <-> TL and BR <-> TR
        [1, 0, 3, 2], // Horizontal swap: BL <-> BR and TL <-> TR
      ];

      const chosenPerm = pick(CANDIDATES);
      const mapSq = (oldSq) => {
        const r = row(oldSq);
        const f = col(oldSq);
        if (s.fourDim) {
          if (!E.inBoardBounds(s, f, r)) return oldSq;
          const lr = r - 2;
          const lf = f - 2;
          const qr = lr >= 2 ? 1 : 0;
          const qf = lf >= 2 ? 1 : 0;
          const oldQ = qr * 2 + qf;
          const newQ = chosenPerm.indexOf(oldQ);
          const nqr = newQ >> 1;
          const nqf = newQ & 1;
          const nr = 2 + nqr * 2 + (lr & 1);
          const nf = 2 + nqf * 2 + (lf & 1);
          return nr * 8 + nf;
        }
        const qr = r >= 4 ? 1 : 0;
        const qf = f >= 4 ? 1 : 0;
        const oldQ = qr * 2 + qf;
        const newQ = chosenPerm.indexOf(oldQ);
        const nqr = newQ >> 1;
        const nqf = newQ & 1;
        const nr = nqr * 4 + (r & 3);
        const nf = nqf * 4 + (f & 3);
        return nr * 8 + nf;
      };

      const newBoard = new Array(64).fill(null);
      for (let sq = 0; sq < 64; sq++) {
        if (s.board[sq]) newBoard[mapSq(sq)] = s.board[sq];
      }
      s.board = newBoard;
      s.mines = s.mines.map((m) => ({ ...m, sq: mapSq(m.sq) }));
      s.ep = null;
      s.lastQuadPerm = chosenPerm;

      // If the two kings landed on adjacent squares (e.g. during a pure X-diagonal swap on the starting board),
      // swap one king with the opposite corner file of its same quadrant rank (`sq ^ 3` or `sq ^ 1`) so they aren't touching.
      const wk = E.kingSq(s, 'w');
      const bk = E.kingSq(s, 'b');
      if (wk >= 0 && bk >= 0 && Math.abs(row(wk) - row(bk)) <= 1 && Math.abs(col(wk) - col(bk)) <= 1) {
        const altSq = s.fourDim ? row(bk) * 8 + (7 - col(bk)) : bk ^ 3;
        [s.board[bk], s.board[altSq]] = [s.board[altSq], s.board[bk]];
      }

      // If any non-king piece landed where it immediately checks a king across the rift,
      // freeze that piece for 1 turn so applyCard doesn't reject diagonal/vertical swaps!
      for (const kingColor of ['w', 'b']) {
        if (inCheck(s, kingColor)) {
          const enemy = opp(kingColor);
          for (let sq = 0; sq < 64; sq++) {
            const p = s.board[sq];
            if (!p || p.c !== enemy || E.hasType(p, 'k') || p.frozen > 0) continue;
            p.frozen = 1;
            if (!inCheck(s, kingColor)) break;
            p.frozen = 0;
          }
          // If multiple pieces check the king simultaneously, freeze all enemy non-king attackers
          if (inCheck(s, kingColor)) {
            for (let sq = 0; sq < 64; sq++) {
              const p = s.board[sq];
              if (p && p.c === enemy && !E.hasType(p, 'k')) p.frozen = Math.max(p.frozen || 0, 1);
            }
          }
        }
      }

      return `🌀 Reality fractured! The 4 quadrants of the board were cut and shuffled around!`;
    },
  },
  {
    id: 'eventHorizon', name: 'Event Horizon', rarity: 'event', icon: '🕳️',
    desc: 'Slice the board in 2! Prevent both sides from moving to each other for 10 turns (activating again clears it).',
    ignoreCheck: true,
    canPlay: () => true,
    apply(s) {
      if ((s.eventHorizon || 0) > 0) {
        s.eventHorizon = 0;
        s.lastEventHorizon = 'cleared';
        return `🌌 Event Horizon activated again — the dimensional rift collapsed and the board is united!`;
      }
      s.eventHorizon = 10;
      s.ep = null;
      s.lastEventHorizon = 'sliced';
      return `🕳️ EVENT HORIZON! The board is sliced in 2 — neither side can cross the rift for 10 turns!`;
    },
  },
  {
    id: 'fourDimLayer', name: '4 Dimensional Layer', rarity: 'event', icon: '💠',
    desc: 'Cut the board into 4 pieces and layer them on top of each other for 1 turn! All pieces become 25% opacity and overlapping pieces merge! Afterwards everything unfolds back to its own quadrant.',
    ignoreCheck: true,
    canPlay: (s) => !s.fourDim,
    apply(s, color) {
      const RANK_PRIORITY = { k: 100, q: 9, r: 5, b: 3, n: 3, p: 1 };
      // Ensure the two kings don't map to the exact same (lr, lf) cell when the 4 quadrants stack
      const wk0 = E.kingSq(s, 'w');
      let bk0 = E.kingSq(s, 'b');
      if (wk0 >= 0 && bk0 >= 0 && (row(wk0) & 3) === (row(bk0) & 3) && (col(wk0) & 3) === (col(bk0) & 3)) {
        const altBk = bk0 ^ 1;
        [s.board[bk0], s.board[altBk]] = [s.board[altBk], s.board[bk0]];
        bk0 = altBk;
      }

      // Every original piece is remembered as a "part" (with the quadrant it came from),
      // so the stack can be unlayered back to the right place when the 4th dimension collapses.
      const toPart = (p, sq) => ({
        id: p.id,
        t: p.t,
        c: p.c,
        qr: row(sq) >> 2,
        qf: col(sq) >> 2,
        pink: !!p.pink,
        shotgun: !!p.shotgun,
        dmg: p.dmg || 0,
        frozen: p.frozen || 0,
        shield: p.shield || 0,
      });

      const mergeStack = (entries) => {
        if (!entries.length) return null;
        const pieces = entries.map((en) => en.p);
        const parts = entries.map((en) => toPart(en.p, en.sq));
        if (pieces.length === 1) {
          const p0 = pieces[0];
          return { ...p0, layers: [p0.t], parts };
        }
        let winColor = color || 'w';
        const kingPiece = pieces.find((p) => E.hasType(p, 'k'));
        if (kingPiece) {
          winColor = kingPiece.c;
        } else {
          let wScore = 0;
          let bScore = 0;
          for (const p of pieces) {
            const val = (VALUES[p.t] || 1) + 10;
            if (p.c === 'w') wScore += val;
            else bScore += val;
          }
          if (wScore > bScore) winColor = 'w';
          else if (bScore > wScore) winColor = 'b';
        }

        const combinedLayers = [];
        let pink = false;
        let shotgun = false;
        let shield = 0;
        let frozen = 0;
        for (const p of pieces) {
          if (p.c === winColor) {
            if (p.pink) pink = true;
            if (p.shotgun) shotgun = true;
            if (p.shield > shield) shield = p.shield;
          }
          if (p.t === 'k' && p.c !== winColor) continue;
          combinedLayers.push(p.t);
        }
        if (!combinedLayers.length) combinedLayers.push(pieces[0].t);
        let bestT = combinedLayers[0];
        for (const lt of combinedLayers) {
          if ((RANK_PRIORITY[lt] || 0) > (RANK_PRIORITY[bestT] || 0)) bestT = lt;
        }
        const merged = mkPiece(bestT, winColor);
        merged.layers = combinedLayers;
        merged.parts = parts;
        if (pink) merged.pink = true;
        if (shotgun) merged.shotgun = true;
        if (shield > 0) merged.shield = shield;
        if (frozen > 0) merged.frozen = frozen;
        return merged;
      };

      const newBoard = new Array(64).fill(null);
      for (let lr = 0; lr < 4; lr++) {
        for (let lf = 0; lf < 4; lf++) {
          const sqs = [
            lr * 8 + lf,
            lr * 8 + (lf + 4),
            (lr + 4) * 8 + lf,
            (lr + 4) * 8 + (lf + 4),
          ];
          const stack = sqs.filter((sq) => s.board[sq]).map((sq) => ({ p: s.board[sq], sq }));
          const destSq = (lr + 2) * 8 + (lf + 2);
          newBoard[destSq] = mergeStack(stack);
        }
      }

      s.board = newBoard;
      s.fourDim = 2; // 1 full turn: each player gets one move inside the 4th dimension
      s.castling = { wK: false, wQ: false, bK: false, bQ: false };
      s.ep = null;
      s.mines = s.mines.map((m) => ({
        ...m,
        qr: row(m.sq) >> 2,
        qf: col(m.sq) >> 2,
        sq: ((row(m.sq) & 3) + 2) * 8 + ((col(m.sq) & 3) + 2),
      }));

      // Ensure the two kings didn't land on adjacent squares of the 4x4 grid
      const wk = E.kingSq(s, 'w');
      const bk = E.kingSq(s, 'b');
      if (wk >= 0 && bk >= 0 && Math.abs(row(wk) - row(bk)) <= 1 && Math.abs(col(wk) - col(bk)) <= 1) {
        const targetRow = row(wk) <= 3 ? 5 : 2;
        const targetCol = col(wk) <= 3 ? 5 : 2;
        const altSq = targetRow * 8 + targetCol;
        [s.board[bk], s.board[altSq]] = [s.board[altSq], s.board[bk]];
      }

      // Freeze any non-king piece that immediately checks a king right out of the 4D merge for 1 turn
      for (const kingColor of ['w', 'b']) {
        if (inCheck(s, kingColor)) {
          const enemy = opp(kingColor);
          for (let sq = 0; sq < 64; sq++) {
            const p = s.board[sq];
            if (!p || p.c !== enemy || E.hasType(p, 'k') || p.frozen > 0) continue;
            p.frozen = 1;
            if (!inCheck(s, kingColor)) break;
            p.frozen = 0;
          }
          if (inCheck(s, kingColor)) {
            for (let sq = 0; sq < 64; sq++) {
              const p = s.board[sq];
              if (p && p.c === enemy && !E.hasType(p, 'k')) p.frozen = Math.max(p.frozen || 0, 1);
            }
          }
        }
      }

      return `💠 4 DIMENSIONAL LAYER! The 4 quadrants stacked onto each other for 1 turn — overlapping pieces merged into 4D hybrids!`;
    },
  },
];

const BY_ID = Object.fromEntries(CARDS.map((c) => [c.id, c]));

// Collapse the 4th dimension: every stacked piece is unlayered back into its OWN quadrant.
// A stack that moved during 4D carries all its parts with it, so each part lands at
// (its original quadrant) + (the stack's current local position in the 4×4).
function unmergeFourDim(s) {
  const oldBoard = s.board;
  const newBoard = new Array(64).fill(null);
  const orphans = [];
  for (let r = 2; r <= 5; r++) {
    for (let f = 2; f <= 5; f++) {
      const p = oldBoard[r * 8 + f];
      if (!p) continue;
      const lr = r - 2;
      const lf = f - 2;
      if (!Array.isArray(p.parts) || !p.parts.length) {
        orphans.push({ p, lr, lf });
        continue;
      }
      for (const part of p.parts) {
        const dest = (part.qr * 4 + lr) * 8 + (part.qf * 4 + lf);
        const piece = { id: part.id, t: part.t, c: part.c };
        if (part.pink) piece.pink = true;
        if (part.shotgun) piece.shotgun = true;
        if (part.dmg) piece.dmg = part.dmg;
        // Statuses applied to the merged stack carry over to the parts that share its color
        const frozen = part.c === p.c ? Math.max(part.frozen || 0, p.frozen || 0) : part.frozen || 0;
        const shield = part.c === p.c ? Math.max(part.shield || 0, p.shield || 0) : part.shield || 0;
        if (frozen > 0) piece.frozen = frozen;
        if (shield > 0) piece.shield = shield;
        if (newBoard[dest]) orphans.push({ p: piece, lr, lf });
        else newBoard[dest] = piece;
      }
    }
  }
  // Anything without an origin (should be rare) goes to its own side's quadrant, or the nearest free square
  for (const { p, lr, lf } of orphans) {
    const clean = { ...p };
    delete clean.layers;
    delete clean.parts;
    const qr = p.c === 'w' ? 0 : 1;
    const tries = [
      (qr * 4 + lr) * 8 + lf,
      (qr * 4 + lr) * 8 + lf + 4,
      ((1 - qr) * 4 + lr) * 8 + lf,
      ((1 - qr) * 4 + lr) * 8 + lf + 4,
    ];
    let dest = tries.find((sq) => !newBoard[sq]);
    if (dest == null) dest = newBoard.findIndex((x) => !x);
    if (dest >= 0) newBoard[dest] = clean;
  }
  s.board = newBoard;
  s.mines = s.mines.map((m) => {
    const lr = row(m.sq) - 2;
    const lf = col(m.sq) - 2;
    const sq = m.qr != null && lr >= 0 && lr < 4 && lf >= 0 && lf < 4 ? (m.qr * 4 + lr) * 8 + (m.qf * 4 + lf) : m.sq;
    return { sq, owner: m.owner };
  });
  s.mines = s.mines.filter((m) => !newBoard[m.sq]);
  s.fourDim = 0;
  s.ep = null;

  // Ensure the two kings don't end up on adjacent squares after unmerging
  const wk = E.kingSq(s, 'w');
  const bk = E.kingSq(s, 'b');
  if (wk >= 0 && bk >= 0 && Math.abs(row(wk) - row(bk)) <= 1 && Math.abs(col(wk) - col(bk)) <= 1) {
    const altSq = bk ^ 3;
    [s.board[bk], s.board[altSq]] = [s.board[altSq], s.board[bk]];
  }

  normalize(s);

  // Unfolding must never hand anyone a free king capture: briefly stun any piece giving a surprise check.
  for (const kingColor of ['w', 'b']) {
    if (!inCheck(s, kingColor)) continue;
    const enemy = opp(kingColor);
    for (let sq = 0; sq < 64 && inCheck(s, kingColor); sq++) {
      const p = s.board[sq];
      if (!p || p.c !== enemy || p.t === 'k' || p.frozen > 0) continue;
      p.frozen = 1;
      if (inCheck(s, kingColor)) p.frozen = 0;
    }
  }
}

function rollHand(state, color, customWeights) {
  const playable = CARDS.filter((c) => !state || !color || !c.canPlay || c.canPlay(state, color));
  const hand = [];
  const weights = customWeights && typeof customWeights === 'object' ? customWeights : RARITY_WEIGHTS;
  const total = Object.values(weights).reduce((a, b) => a + Math.max(0, Number(b) || 0), 0);
  const activeWeights = total > 0 ? weights : RARITY_WEIGHTS;
  const activeTotal = Object.values(activeWeights).reduce((a, b) => a + Math.max(0, Number(b) || 0), 0);
  let guard = 0;
  const conflictsWithHand = (id) =>
    (id === 'genderBend' && hand.includes('shotgunKing')) ||
    (id === 'shotgunKing' && hand.includes('genderBend'));
  while (hand.length < 3 && guard++ < 200) {
    let x = Math.random() * activeTotal;
    let rarity = 'common';
    for (const [r, rawW] of Object.entries(activeWeights)) {
      const w = Math.max(0, Number(rawW) || 0);
      if (x < w) {
        rarity = r;
        break;
      }
      x -= w;
    }
    let pool = playable.filter((c) => c.rarity === rarity && !hand.includes(c.id) && !conflictsWithHand(c.id));
    if (!pool.length) {
      // Fallback: pick from any rarity that actually has weight > 0 first
      pool = playable.filter(
        (c) => (Number(activeWeights[c.rarity]) || 0) > 0 && !hand.includes(c.id) && !conflictsWithHand(c.id)
      );
    }
    if (!pool.length) pool = playable.filter((c) => !hand.includes(c.id) && !conflictsWithHand(c.id));
    if (pool.length) hand.push(pick(pool).id);
  }
  return hand;
}

function publicCard(id) {
  const c = BY_ID[id];
  return { id: c.id, name: c.name, rarity: c.rarity, icon: c.icon, desc: c.desc };
}

function applyCard(state, color, id) {
  const card = BY_ID[id];
  const before = checks(state);
  let lastState = null;
  let lastMsg = '';
  for (let i = 0; i < 12; i++) {
    const s2 = cloneState(state);
    const msg = card.apply(s2, color);
    normalize(s2);
    lastState = s2;
    lastMsg = msg;
    if (card.ignoreCheck || !newCheck(s2, before)) {
      Object.assign(state, s2);
      return msg;
    }
  }
  // Never fizzle deterministic cards like Smite, Gender Bend, Suit Up, Queen's Gambit, etc. — apply them!
  if (lastState) {
    Object.assign(state, lastState);
    return lastMsg;
  }
  return `${card.name} fizzled — the magic was unstable!`;
}

module.exports = { CARDS, BY_ID, RARITY_WEIGHTS, rollHand, publicCard, applyCard, unmergeFourDim };
