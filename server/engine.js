// Spellbound Chess engine.
// Custom chess rules engine that supports card statuses:
//   piece.frozen  -> number of the owner's turns the piece cannot move (and it does not attack)
//   piece.shield  -> number of enemy turns the piece cannot be captured
//   piece.pink    -> king that moves like a queen ("Gender Bend")
// Board: array of 64, index = row*8 + col, row 0 = rank 1 (White's back rank).

const FILES = 'abcdefgh';
const row = (s) => s >> 3;
const col = (s) => s & 7;
const sqName = (s) => FILES[col(s)] + (row(s) + 1);
const opp = (c) => (c === 'w' ? 'b' : 'w');

const KN = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
const KG = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
// 8 compass directions in clockwise order starting from Up [0, 1]:
// 0: Up, 1: Top-Right, 2: Right, 3: Bottom-Right, 4: Down, 5: Bottom-Left, 6: Left, 7: Top-Left
const DIRS_8 = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]];
const ROOKD = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISD = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const PIECE_MAX_HP = { p: 1, n: 3, b: 3, r: 3, q: 5, k: 3 };
const maxHp = (p) => PIECE_MAX_HP[p && p.t] || 3;

function isLastKingStanding(state, c) {
  let k = null;
  let count = 0;
  for (const p of state.board) {
    if (p && p.c === c) {
      count++;
      if (p.t === 'k') k = p;
    }
  }
  return count === 1 && !!(k && k.shotgun);
}

let nextId = 1;
function mkPiece(t, c) {
  return { t, c, id: nextId++ };
}

function initialState() {
  const board = new Array(64).fill(null);
  const back = 'rnbqkbnr';
  for (let f = 0; f < 8; f++) {
    board[f] = mkPiece(back[f], 'w');
    board[8 + f] = mkPiece('p', 'w');
    board[48 + f] = mkPiece('p', 'b');
    board[56 + f] = mkPiece(back[f], 'b');
  }
  const s = {
    board,
    turn: 'w',
    castling: { wK: true, wQ: true, bK: true, bQ: true },
    ep: null,
    halfmove: 0,
    lost: { w: [], b: [] }, // piece types each color has lost
    mines: [], // {sq, owner}
    fog: { w: 0, b: 0 }, // fog[c] > 0 -> c's pieces hidden from the opponent
    extra: { w: 0, b: 0 }, // double move pending
    skip: { w: 0, b: 0 }, // skip next turn
    nextCardPicks: { w: 1, b: 1 }, // how many cards each player gets to pick on the next card phase
    eventHorizon: 0, // turns remaining where board is sliced in 2 horizontally (rank 1-4 vs rank 5-8)
    activeSkill: null, // { type, color } for 1-turn skill cards
    dog: null, // Devourer of Gods boss state
    repetition: {},
  };
  s.repetition[posKey(s)] = 1;
  return s;
}

function cloneState(s) {
  return {
    ...s,
    board: s.board.map((p) => (p ? { ...p } : null)),
    castling: { ...s.castling },
    lost: { w: [...s.lost.w], b: [...s.lost.b] },
    mines: s.mines.map((m) => ({ ...m })),
    fog: { ...s.fog },
    extra: { ...s.extra },
    skip: { ...s.skip },
    nextCardPicks: { ...(s.nextCardPicks || { w: 1, b: 1 }) },
    eventHorizon: s.eventHorizon || 0,
    activeSkill: s.activeSkill ? { ...s.activeSkill } : null,
    dog: s.dog
      ? {
          ...s.dog,
          telegraph: s.dog.telegraph ? { ...s.dog.telegraph } : null,
          segments: s.dog.segments ? s.dog.segments.map((seg) => ({ ...seg })) : [],
          lastHit: s.dog.lastHit ? { ...s.dog.lastHit } : null,
        }
      : null,
  };
}

function inBoardBounds(state, f, r) {
  return f >= 0 && f <= 7 && r >= 0 && r <= 7;
}
function inSqBounds(state, sq) {
  return sq >= 0 && sq < 64 && inBoardBounds(state, col(sq), row(sq));
}
function at(board, f, r, state) {
  if (!inBoardBounds(state, f, r)) return undefined;
  return board[r * 8 + f];
}
const hasType = (p, t) => !!(p && (p.t === t || (Array.isArray(p.layers) && p.layers.includes(t))));
const active = (p, c) => p && p.c === c && !(p.frozen > 0);
const canCapture = (p, c) => p && p.c !== c && !(p.shield > 0);
const sameHalf = (sqA, sqB) => (sqA >> 5) === (sqB >> 5);

function isAttacked(state, sq, by) {
  const b = state.board;
  const f = col(sq);
  const r = row(sq);
  const eh = (state.eventHorizon || 0) > 0;
  const dogSegs = state.dog && state.dog.active && state.dog.segments && state.dog.segments.length ? new Set(state.dog.segments.map((x) => x.sq)) : null;
  const dir = by === 'w' ? 1 : -1;
  for (const df of [-1, 1]) {
    const rr = r - dir;
    if (eh && (rr >= 4) !== (r >= 4)) continue;
    const pSq = rr * 8 + (f + df);
    if (dogSegs && dogSegs.has(pSq)) continue;
    const p = at(b, f + df, rr, state);
    if (active(p, by) && hasType(p, 'p')) return true;
  }
  for (const [df, dr] of KN) {
    const rr = r + dr;
    if (eh && (rr >= 4) !== (r >= 4)) continue;
    const pSq = rr * 8 + (f + df);
    if (dogSegs && dogSegs.has(pSq)) continue;
    const p = at(b, f + df, rr, state);
    if (active(p, by) && hasType(p, 'n')) return true;
  }
  for (const [df, dr] of KG) {
    const rr = r + dr;
    if (eh && (rr >= 4) !== (r >= 4)) continue;
    const pSq = rr * 8 + (f + df);
    if (dogSegs && dogSegs.has(pSq)) continue;
    const p = at(b, f + df, rr, state);
    if (active(p, by) && hasType(p, 'k')) return true;
  }
  const slide = (dirs, types) => {
    for (const [df, dr] of dirs) {
      let ff = f + df;
      let rr = r + dr;
      while (inBoardBounds(state, ff, rr)) {
        if (eh && (rr >= 4) !== (r >= 4)) break;
        const targetSq = rr * 8 + ff;
        if (dogSegs && dogSegs.has(targetSq)) break;
        const p = b[targetSq];
        if (p) {
          if (active(p, by) && ([...types].some((t) => hasType(p, t)) || (hasType(p, 'k') && p.pink))) return true;
          break;
        }
        ff += df;
        rr += dr;
      }
    }
    return false;
  };
  return slide(ROOKD, 'rq') || slide(BISD, 'bq');
}

function kingSq(state, c) {
  return state.board.findIndex((p) => p && hasType(p, 'k') && p.c === c);
}

function inCheck(state, c) {
  const k = kingSq(state, c);
  return k >= 0 && isAttacked(state, k, opp(c));
}

function pseudoMoves(state, c) {
  const b = state.board;
  const moves = [];
  const eh = (state.eventHorizon || 0) > 0;
  const skill = state.activeSkill && state.activeSkill.color === c ? state.activeSkill.type : null;
  const dogActive = state.dog && state.dog.active && state.dog.segments && state.dog.segments.length > 0;
  const dogSegs = dogActive ? new Set(state.dog.segments.map((x) => x.sq)) : null;

  for (let s = 0; s < 64; s++) {
    if (!inSqBounds(state, s)) continue;
    const p = b[s];
    if (!p || p.c !== c || p.frozen > 0) continue;
    if (dogSegs && dogSegs.has(s)) continue; // Trapped in DoG body, cannot move!

    const f = col(s);
    const r = row(s);
    const add = (to, extra) => {
      if (!inSqBounds(state, to)) return;
      if (dogSegs && dogSegs.has(to) && (!extra || !extra.attackDog)) return;
      if (eh && !sameHalf(s, to) && !(skill === 'jumpOver' && !b[to])) return;
      const pr = (extra && extra.promo) || null;
      if (moves.some((m) => m.from === s && m.to === to && (m.promo || null) === pr && !!m.attackDog === !!(extra && extra.attackDog))) return;
      moves.push(Object.assign({ from: s, to }, extra));
    };

    if (hasType(p, 'p')) {
      const dir = c === 'w' ? 1 : -1;
      const last = c === 'w' ? 7 : 0;
      const start = c === 'w' ? 1 : 6;
      const purePawn = !p.layers || p.layers.every((lt) => lt === 'p');
      const pushP = (to, extra) => {
        if (row(to) === last) {
          if (purePawn) {
            for (const pr of 'qrbn') add(to, { ...extra, promo: pr });
          } else {
            add(to, { ...extra, promo: 'q' });
          }
        } else {
          add(to, extra);
        }
      };
      const r1 = r + dir;
      if (inBoardBounds(state, f, r1) && (!eh || (r1 >= 4) === (r >= 4))) {
        const straightSq = r1 * 8 + f;
        if (dogSegs && dogSegs.has(straightSq)) {
          add(straightSq, { attackDog: true });
        } else if (!b[straightSq]) {
          pushP(straightSq);
          const r2 = r + 2 * dir;
          const twoSq = r2 * 8 + f;
          if (r === start && inBoardBounds(state, f, r2) && (!eh || (r2 >= 4) === (r >= 4)) && !b[twoSq] && (!dogSegs || !dogSegs.has(twoSq))) {
            add(twoSq, { double: true });
          }
        }
        for (const df of [-1, 1]) {
          const ff = f + df;
          if (!inBoardBounds(state, ff, r1)) continue;
          const t = r1 * 8 + ff;
          if (dogSegs && dogSegs.has(t)) {
            add(t, { attackDog: true });
          } else {
            const q = b[t];
            if (q) {
              if (canCapture(q, c)) pushP(t);
            } else if (state.ep === t) {
              const cap = b[r * 8 + ff];
              if (cap && hasType(cap, 'p') && cap.c !== c && !(cap.shield > 0)) add(t, { ep: true });
            }
          }
        }
      }

      // Quick Pawn: can capture backwards and diagonally backwards for 1 turn
      if (skill === 'quickPawn') {
        const rBack = r - dir;
        if (inBoardBounds(state, f, rBack) && (!eh || (rBack >= 4) === (r >= 4))) {
          const tStraight = rBack * 8 + f;
          if (dogSegs && dogSegs.has(tStraight)) {
            add(tStraight, { attackDog: true });
          } else {
            const qStraight = b[tStraight];
            if (qStraight && canCapture(qStraight, c)) add(tStraight);
          }
          for (const df of [-1, 1]) {
            const ff = f + df;
            if (inBoardBounds(state, ff, rBack)) {
              const tDiag = rBack * 8 + ff;
              if (dogSegs && dogSegs.has(tDiag)) {
                add(tDiag, { attackDog: true });
              } else {
                const qDiag = b[tDiag];
                if (qDiag && canCapture(qDiag, c)) add(tDiag);
              }
            }
          }
        }
      }

      // Jump Over: pawns can jump 1 or 2 squares forward over pieces/EH to empty squares
      if (skill === 'jumpOver') {
        for (let step = 1; step <= 2; step++) {
          const rStep = r + step * dir;
          if (inBoardBounds(state, f, rStep)) {
            const targetSq = rStep * 8 + f;
            if (!b[targetSq] && (!dogSegs || !dogSegs.has(targetSq))) pushP(targetSq);
          }
        }
      }
    }

    if (hasType(p, 'n')) {
      for (const [df, dr] of KN) {
        if (!inBoardBounds(state, f + df, r + dr)) continue;
        const targetSq = (r + dr) * 8 + f + df;
        if (dogSegs && dogSegs.has(targetSq)) {
          add(targetSq, { attackDog: true });
          continue;
        }
        const q = b[targetSq];
        if (!q || canCapture(q, c)) add(targetSq);
      }
    }

    let dirs = null;
    if (hasType(p, 'q') || (hasType(p, 'k') && p.pink)) {
      dirs = [...ROOKD, ...BISD];
    } else {
      const hasR = hasType(p, 'r');
      const hasB = hasType(p, 'b');
      if (hasR && hasB) dirs = [...ROOKD, ...BISD];
      else if (hasR) dirs = ROOKD;
      else if (hasB) dirs = BISD;
    }
    if (dirs) {
      for (const [df, dr] of dirs) {
        let ff = f + df;
        let rr = r + dr;
        let hasJumped = false;
        while (inBoardBounds(state, ff, rr)) {
          const crossedEH = eh && (rr >= 4) !== (r >= 4);
          if (crossedEH && skill !== 'jumpOver') break;
          if (crossedEH) hasJumped = true;

          const to = rr * 8 + ff;
          if (dogSegs && dogSegs.has(to)) {
            if (!hasType(p, 'k')) {
              add(to, { attackDog: true });
            }
            break; // DoG blocks slider ray
          }
          const q = b[to];
          if (!q) {
            add(to);
          } else if (q.c === c) {
            break;
          } else {
            if (!hasJumped && canCapture(q, c)) {
              add(to);
            }
            if (skill === 'jumpOver') {
              hasJumped = true;
            } else {
              break;
            }
          }
          ff += df;
          rr += dr;
        }
      }
    }
    if (hasType(p, 'k')) {
      if (!p.pink) {
        for (const [df, dr] of KG) {
          if (!inBoardBounds(state, f + df, r + dr)) continue;
          const targetSq = (r + dr) * 8 + f + df;
          if (dogSegs && dogSegs.has(targetSq)) continue; // King cannot enter or attack DoG
          const q = b[targetSq];
          if (!q || canCapture(q, c)) add(targetSq);
        }
        if (skill === 'jumpOver') {
          for (const [df, dr] of KG) {
            const r2 = r + 2 * dr;
            const f2 = f + 2 * df;
            if (inBoardBounds(state, f2, r2)) {
              const sq2 = r2 * 8 + f2;
              if (!b[sq2] && (!dogSegs || !dogSegs.has(sq2))) add(sq2);
            }
          }
        }
      }
      // castling (disabled when 4D layered board is active)
      const home = c === 'w' ? 4 : 60;
      if (s === home && !inCheck(state, c)) {
        const o = opp(c);
        const rk = b[home + 3];
        if (state.castling[c + 'K'] && rk && rk.t === 'r' && rk.c === c && !(rk.frozen > 0) &&
            !b[home + 1] && (!dogSegs || !dogSegs.has(home + 1)) &&
            !b[home + 2] && (!dogSegs || !dogSegs.has(home + 2)) &&
            !isAttacked(state, home + 1, o) && !isAttacked(state, home + 2, o)) {
          removeDup(moves, s, home + 2);
          add(home + 2, { castle: 'K' });
        }
        const rq = b[home - 4];
        if (state.castling[c + 'Q'] && rq && rq.t === 'r' && rq.c === c && !(rq.frozen > 0) &&
            !b[home - 1] && (!dogSegs || !dogSegs.has(home - 1)) &&
            !b[home - 2] && (!dogSegs || !dogSegs.has(home - 2)) &&
            !b[home - 3] && (!dogSegs || !dogSegs.has(home - 3)) &&
            !isAttacked(state, home - 1, o) && !isAttacked(state, home - 2, o)) {
          removeDup(moves, s, home - 2);
          add(home - 2, { castle: 'Q' });
        }
      }
    }
  }
  return moves;
}

function removeDup(moves, from, to) {
  const i = moves.findIndex((m) => m.from === from && m.to === to);
  if (i >= 0) moves.splice(i, 1);
}

function updateCastling(state, touched = []) {
  const b = state.board;
  const chk = (key, kSq, rSq, c) => {
    if (!state.castling[key]) return;
    const k = b[kSq];
    const r = b[rSq];
    if (touched.includes(kSq) || touched.includes(rSq) || !k || k.t !== 'k' || k.c !== c || !r || r.t !== 'r' || r.c !== c) {
      state.castling[key] = false;
    }
  };
  chk('wK', 4, 7, 'w');
  chk('wQ', 4, 0, 'w');
  chk('bK', 60, 63, 'b');
  chk('bQ', 60, 56, 'b');
}

function recordLost(state, p) {
  if (!p) return;
  if (Array.isArray(p.parts) && p.parts.length) {
    // A captured 4D stack takes EVERY layered piece down with it (each counted for its own side)
    for (const part of p.parts) state.lost[part.c].push(part.t);
  } else if (Array.isArray(p.layers) && p.layers.length) {
    for (const lt of p.layers) state.lost[p.c].push(lt);
  } else {
    state.lost[p.c].push(p.t);
  }
}

function dogDamage(p) {
  if (!p) return 0;
  if (hasType(p, 'k')) return 0;
  if (hasType(p, 'q')) return 10;
  if (hasType(p, 'r') || hasType(p, 'b')) return 5;
  if (hasType(p, 'n')) return 3;
  if (hasType(p, 'p')) return 1;
  return 0;
}

// Mutates state. Returns info about what happened.
function makeMove(state, m) {
  const b = state.board;
  const p = b[m.from];
  const c = p.c;
  const origType = p.t;

  if (m.attackDog) {
    const dmg = dogDamage(p);
    let killed = false;
    if (state.dog && state.dog.active) {
      state.dog.hp = Math.max(0, state.dog.hp - dmg);
      killed = state.dog.hp <= 0;
      if (killed) {
        state.dog.active = false;
        state.dog.phase = 'dead';
        state.dog.segments = [];
        state.dog.telegraph = null;
      }
      state.dog.lastHit = {
        dmg,
        sq: m.to,
        from: m.from,
        color: c,
        piece: origType,
        dogHp: state.dog.hp,
        killed,
      };
    }
    state.halfmove = 0;
    return {
      captured: null,
      exploded: false,
      kingCaptured: null,
      castle: false,
      promo: null,
      shotgun: null,
      attackDog: true,
      dogHit: state.dog ? state.dog.lastHit : null,
    };
  }

  const info = { captured: null, exploded: false, kingCaptured: null, castle: !!m.castle, promo: m.promo || null, shotgun: null };
  let cap = b[m.to];
  if (m.ep) {
    const capSq = m.to + (c === 'w' ? -8 : 8);
    cap = b[capSq];
    b[capSq] = null;
  }
  if (cap) {
    info.captured = cap.t;
    recordLost(state, cap);
    if (hasType(cap, 'k')) info.kingCaptured = cap.c;
  }
  b[m.to] = p;
  b[m.from] = null;
  if (m.promo) {
    if (Array.isArray(p.layers) && p.layers.length) {
      p.layers = p.layers.map((lt) => (lt === 'p' ? m.promo : lt));
      if (p.t !== 'k') p.t = m.promo;
    } else {
      p.t = m.promo;
    }
    if (Array.isArray(p.parts)) {
      for (const part of p.parts) if (part.t === 'p' && part.c === c) part.t = m.promo;
    }
  }
  if (m.castle) {
    const rf = m.castle === 'K' ? m.from + 3 : m.from - 4;
    const rt = m.castle === 'K' ? m.from + 1 : m.from - 1;
    b[rt] = b[rf];
    b[rf] = null;
  }
  // enemy landmines
  const mi = state.mines.findIndex((x) => x.sq === m.to && x.owner !== c);
  if (mi >= 0) {
    state.mines.splice(mi, 1);
    if (!hasType(p, 'k')) {
      b[m.to] = null;
      recordLost(state, p);
      info.exploded = true;
    }
  }

  // King with a Shotgun (Last King Standing): fires a 3-bullet cone in the direction moved!
  if (!info.kingCaptured && hasType(p, 'k') && p.shotgun && isLastKingStanding(state, c)) {
    const df = Math.sign(col(m.to) - col(m.from));
    const dr = Math.sign(row(m.to) - row(m.from));
    const dirIdx = DIRS_8.findIndex(([x, y]) => x === df && y === dr);
    if (dirIdx >= 0) {
      const coneDirs = [
        DIRS_8[(dirIdx + 7) % 8],
        DIRS_8[dirIdx],
        DIRS_8[(dirIdx + 1) % 8],
      ];
      const f0 = col(m.to);
      const r0 = row(m.to);
      const eh = (state.eventHorizon || 0) > 0;
      const rays = [];
      for (const [bf, br] of coneDirs) {
        let ff = f0 + bf;
        let rr = r0 + br;
        let endSq = m.to;
        const hits = [];
        while (inBoardBounds(state, ff, rr)) {
          if (eh && (rr >= 4) !== (r0 >= 4)) break;
          const sq = rr * 8 + ff;
          endSq = sq;
          const target = b[sq];
          if (target) {
            if (target.c !== c && !(target.shield > 0)) {
              const isPawn = target.t === 'p' && (!target.layers || target.layers.every((lt) => lt === 'p'));
              const mHp = maxHp(target);
              target.dmg = (target.dmg || 0) + 1;
              const killed = target.dmg >= mHp;
              const hitObj = { sq, piece: target.t, color: target.c, dmg: target.dmg, maxHp: mHp, killed, pierced: isPawn && killed };
              hits.push(hitObj);
              if (killed) {
                b[sq] = null;
                recordLost(state, target);
                if (!info.captured) info.captured = target.t;
                if (hasType(target, 'k')) info.kingCaptured = target.c;
              }
              // One-shot pawns are pierced through! Other pieces stop the bullet.
              if (isPawn && killed) {
                ff += bf;
                rr += br;
                continue;
              }
            } else {
              hits.push({ sq, piece: target.t, color: target.c, dmg: target.dmg || 0, maxHp: maxHp(target), killed: false, blocked: true });
            }
            break;
          }
          ff += bf;
          rr += br;
        }
        rays.push({ bf, br, endSq, hits, hit: hits[hits.length - 1] || null });
      }
      info.shotgun = { color: c, from: m.from, to: m.to, df, dr, rays };
    }
  }

  state.ep = m.double ? (m.from + m.to) / 2 : null;
  state.halfmove = origType === 'p' || cap || info.captured ? 0 : state.halfmove + 1;
  updateCastling(state, [m.from, m.to]);
  return info;
}

function legalMoves(state, c) {
  const res = [];
  for (const m of pseudoMoves(state, c)) {
    const s2 = cloneState(state);
    const info = makeMove(s2, m);
    if (info.kingCaptured || !inCheck(s2, c)) res.push(m);
  }
  return res;
}

function posKey(state) {
  let k = '';
  for (const p of state.board) {
    const lStr = p && p.layers && p.layers.length > 1 ? `[${p.layers.join('')}]` : '';
    k += p ? (p.c === 'w' ? p.t.toUpperCase() : p.t) + lStr + (p.pink ? '!' : '') + (p.shotgun ? 'S' : '') + (p.dmg ? p.dmg : '') : '.';
  }
  const cs = state.castling;
  const dogK = state.dog && state.dog.active ? `:D${state.dog.hp},${state.dog.turnsUntilAttack}` : '';
  return k + state.turn + (cs.wK ? 'K' : '') + (cs.wQ ? 'Q' : '') + (cs.bK ? 'k' : '') + (cs.bQ ? 'q' : '') + (state.ep ?? '-') + (state.eventHorizon > 0 ? ':EH' : '') + dogK;
}

function insufficientMaterial(state) {
  const rest = [];
  for (const p of state.board) {
    if (!p) continue;
    if (Array.isArray(p.layers) && p.layers.length > 1) {
      for (const lt of p.layers) {
        if (lt !== 'k') rest.push(lt);
      }
      if (p.pink || p.shotgun) return false;
      continue;
    }
    if (p.t === 'k') {
      if (p.pink || p.shotgun) return false;
      continue;
    }
    rest.push(p.t);
  }
  return rest.length === 0 || (rest.length === 1 && (rest[0] === 'n' || rest[0] === 'b'));
}

// SAN without check suffix. `legal` = legal moves for the mover in `state` (before the move).
function toSan(state, m, legal) {
  const p = state.board[m.from];
  if (m.attackDog) {
    return (p ? (p.t === 'p' ? FILES[col(m.from)] : p.t.toUpperCase()) : '') + 'xDoG(' + sqName(m.to) + ')';
  }
  if (m.castle) return m.castle === 'K' ? 'O-O' : 'O-O-O';
  const capture = !!state.board[m.to] || !!m.ep;
  if (p.t === 'p' && (!p.layers || p.layers.every((lt) => lt === 'p'))) {
    return (capture ? FILES[col(m.from)] + 'x' : '') + sqName(m.to) + (m.promo ? '=' + m.promo.toUpperCase() : '');
  }
  const others = legal.filter((o) => o.to === m.to && o.from !== m.from && state.board[o.from].t === p.t);
  let dis = '';
  if (others.length) {
    if (!others.some((o) => col(o.from) === col(m.from))) dis = FILES[col(m.from)];
    else if (!others.some((o) => row(o.from) === row(m.from))) dis = String(row(m.from) + 1);
    else dis = sqName(m.from);
  }
  return p.t.toUpperCase() + dis + (capture ? 'x' : '') + sqName(m.to);
}

function perft(state, depth) {
  if (depth === 0) return 1;
  let n = 0;
  for (const m of legalMoves(state, state.turn)) {
    const s2 = cloneState(state);
    makeMove(s2, m);
    s2.turn = opp(s2.turn);
    n += perft(s2, depth - 1);
  }
  return n;
}

module.exports = {
  FILES, row, col, sqName, opp, VALUES, PIECE_MAX_HP, maxHp, DIRS_8, inBoardBounds, inSqBounds, hasType, recordLost, isLastKingStanding, mkPiece, initialState, cloneState, isAttacked, kingSq, inCheck,
  pseudoMoves, legalMoves, makeMove, updateCastling, posKey, insufficientMaterial, toSan, perft, dogDamage,
};
