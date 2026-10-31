// A Room = one game between two players, identified by a 6-char Room ID.
const E = require('./engine');
const Cards = require('./cards');
const { opp } = E;

const DEFAULT_CARD_INTERVAL_TURNS = 5; // 5 full turns (both players move once = 1 turn)
const CARD_TIME_MS = 15000;
const REVEAL_MS = 2100; // time for exit animations before effects are applied
const RECONNECT_GRACE_MS = 60000;
const NAME = { w: 'White', b: 'Black' };

class Room {
  constructor(code, onDispose, cardIntervalTurns = DEFAULT_CARD_INTERVAL_TURNS, rarityWeights = null) {
    this.code = code;
    this.onDispose = onDispose;
    const n = Math.round(Number(cardIntervalTurns));
    this.cardIntervalTurns = Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : DEFAULT_CARD_INTERVAL_TURNS;
    this.halfMovesPerCardPhase = this.cardIntervalTurns * 2;
    this.rarityWeights = this.sanitizeWeights(rarityWeights);
    this.seats = { w: null, b: null }; // {token, name, socket, connected, discAt}
    this.chat = [];
    this.disposeTimer = null;
    this.colorOfCreator = Math.random() < 0.5 ? 'w' : 'b';
    this.resetGame();
  }

  sanitizeWeights(rw) {
    if (!rw || typeof rw !== 'object') return { ...Cards.RARITY_WEIGHTS };
    const clean = {
      common: Math.max(0, Math.min(1000, Math.round(Number(rw.common) || 0))),
      rare: Math.max(0, Math.min(1000, Math.round(Number(rw.rare) || 0))),
      epic: Math.max(0, Math.min(1000, Math.round(Number(rw.epic) || 0))),
      legendary: Math.max(0, Math.min(1000, Math.round(Number(rw.legendary) || 0))),
      event: Math.max(0, Math.min(1000, Math.round(Number(rw.event) || 0))),
    };
    const sum = clean.common + clean.rare + clean.epic + clean.legendary + clean.event;
    return sum > 0 ? clean : { ...Cards.RARITY_WEIGHTS };
  }

  resetGame() {
    this.state = E.initialState();
    this.phase = 'waiting';
    this.turnsCount = 0;
    this.moves = [];
    this.lastMove = null;
    this.result = null;
    this.drawOffer = null;
    this.rematch = { w: false, b: false };
    this.cards = null;
    this.cardPhaseId = 0;
    this.lastEffects = null;
    this.effectsId = 0;
    this.lastShotgun = null;
    this.shotgunId = 0;
    this.lastFourDimUnmerge = null;
    this.fourDimUnmergeId = 0;
    this.notice = null;
    this.noticeId = 0;
    clearTimeout(this.cardTimer);
    clearTimeout(this.revealTimer);
    this.legal = E.legalMoves(this.state, 'w');
  }

  // ---------- players ----------
  join(socket, token, name) {
    name = String(name || 'Player').slice(0, 20) || 'Player';
    let color = ['w', 'b'].find((c) => this.seats[c] && this.seats[c].token === token);
    if (!color) {
      if (!this.seats.w && !this.seats.b) color = this.colorOfCreator;
      else if (!this.seats.w) color = 'w';
      else if (!this.seats.b) color = 'b';
      else {
        // Both seats exist: allow rejoining a disconnected seat (prefer matching player name)
        const disc = ['w', 'b'].filter((c) => !this.seats[c].connected);
        color = disc.find((c) => this.seats[c].name.toLowerCase() === name.toLowerCase()) || disc[0] || null;
      }
      if (!color) return { error: 'This room is full.' };
      this.seats[color] = { token, name };
    }
    const seat = this.seats[color];
    if (seat.socket && seat.socket !== socket) seat.socket.disconnect(true);
    seat.socket = socket;
    seat.connected = true;
    seat.discAt = null;
    seat.name = name;
    socket.data.room = this;
    socket.data.color = color;
    clearTimeout(this.disposeTimer);
    if (this.phase === 'waiting' && this.seats.w && this.seats.b) {
      this.phase = 'play';
      const t = this.cardIntervalTurns;
      this.pushNotice(`Game started — good luck! Cards appear every ${t} turn${t === 1 ? '' : 's'}.`);
    }
    this.broadcast();
    return { color };
  }

  leave(socket) {
    const color = socket.data.color;
    const seat = this.seats[color];
    if (!seat || seat.socket !== socket) return;
    seat.connected = false;
    seat.socket = null;
    seat.discAt = Date.now();
    setTimeout(() => this.broadcast(), RECONNECT_GRACE_MS + 200);
    this.broadcast();
    if (!['w', 'b'].some((c) => this.seats[c] && this.seats[c].connected)) {
      clearTimeout(this.disposeTimer);
      this.disposeTimer = setTimeout(() => this.dispose(), 10 * 60 * 1000);
    }
  }

  dispose() {
    clearTimeout(this.cardTimer);
    clearTimeout(this.revealTimer);
    this.onDispose(this.code);
  }

  snapBoard() {
    return this.state.board.map((p) =>
      p
        ? {
            id: p.id,
            t: p.t,
            c: p.c,
            layers: p.layers ? [...p.layers] : undefined,
            pink: !!p.pink,
            shotgun: !!p.shotgun,
            dmg: p.dmg || 0,
            frozen: p.frozen || 0,
            shield: p.shield || 0,
          }
        : null
    );
  }

  // ---------- game flow ----------
  move(color, { from, to, promo }) {
    if (this.phase !== 'play' || this.state.turn !== color) return;
    const cands = this.legal.filter((m) => m.from === from && m.to === to);
    if (!cands.length) return;
    const m = cands.find((x) => (x.promo || null) === (promo || null)) || cands.find((x) => x.promo === 'q') || cands[0];
    const s = this.state;
    const san = E.toSan(s, m, this.legal);
    const hidden = s.fog[color] > 0;
    const before = this.snapBoard();
    const info = E.makeMove(s, m);
    const after = this.snapBoard();
    if (info.shotgun) {
      this.shotgunId++;
      this.lastShotgun = { ...info.shotgun, before, after };
    }
    this.lastMove = { from: m.from, to: m.to, color };
    this.drawOffer = null;
    const oppC = opp(color);
    const check = E.inCheck(s, oppC);
    const entry = { san: san + (info.shotgun ? '🔫' : ''), color, hidden, capture: !!info.captured, castle: info.castle, exploded: info.exploded, check, promo: !!info.promo, shotgun: !!info.shotgun };
    this.moves.push(entry);
    if (info.exploded) this.pushNotice(`💥 ${NAME[color]}'s piece stepped on a landmine!`);

    if (info.kingCaptured) {
      entry.san += '#';
      return this.finish(color, 'king captured');
    }
    if (check) {
      const mate = E.legalMoves(s, oppC).length === 0;
      entry.san += mate ? '#' : '+';
    }
    // Double Move card
    if (s.extra[color] > 0) {
      s.extra[color] = 0;
      if (!check) {
        this.legal = E.legalMoves(s, color);
        if (this.legal.length) {
          this.pushNotice(`⏩ ${NAME[color]} moves again!`);
          return this.broadcast();
        }
      }
    }
    this.endTurn();
  }

  endTurnStatuses(X) {
    const Y = opp(X);
    for (const p of this.state.board) {
      if (!p) continue;
      if (p.c === X && p.frozen > 0) p.frozen--;
      if (p.c === Y && p.shield > 0) p.shield--;
    }
    if (this.state.fog[Y] > 0) this.state.fog[Y]--;
    if (this.state.eventHorizon > 0) {
      this.state.eventHorizon--;
      if (this.state.eventHorizon === 0) {
        this.pushNotice('🌌 The Event Horizon collapsed — the board is united again!');
      }
    }
    if (this.state.fourDim > 0) {
      this.state.fourDim--;
      if (this.state.fourDim === 0) {
        // Expand the pieces from 4D back to their respective quadrants on the 8x8 board
        const before = this.snapBoard();
        Cards.unmergeFourDim(this.state);
        const after = this.snapBoard();
        this.fourDimUnmergeId++;
        this.lastFourDimUnmerge = { id: this.fourDimUnmergeId, before, after };
        this.pushNotice('💠 4 Dimensional Layer collapsed — space unfolded back to 8×8!');
      }
    }
  }

  endTurn() {
    const s = this.state;
    const X = s.turn;
    const Y = opp(X);
    this.endTurnStatuses(X);
    s.turn = Y;
    this.turnsCount++;
    const key = E.posKey(s);
    s.repetition[key] = (s.repetition[key] || 0) + 1;
    this.legal = E.legalMoves(s, Y);
    if (this.checkGameOver()) return;
    if (this.turnsCount % this.halfMovesPerCardPhase === 0) return this.startCards();
    this.beginTurn();
  }

  beginTurn() {
    const s = this.state;
    const X = s.turn;
    if (s.skip[X] > 0) {
      s.skip[X] = 0;
      if (!E.inCheck(s, X)) {
        this.pushNotice(`⏸️ ${NAME[X]} is frozen in time — turn skipped!`);
        this.moves.push({ san: '⏸️', color: X, skipped: true });
        return this.endTurn();
      }
    }
    this.legal = E.legalMoves(s, X);
    if (this.legal.length === 0 && s.eventHorizon > 0 && !E.inCheck(s, X)) {
      this.pushNotice(`🕳️ ${NAME[X]} has no moves on their side of the Event Horizon — turn passed!`);
      this.moves.push({ san: '🕳️', color: X, skipped: true });
      return this.endTurn();
    }
    if (this.checkGameOver()) return;
    this.broadcast();
  }

  checkGameOver() {
    const s = this.state;
    const c = s.turn;
    if (this.legal.length === 0) {
      if (E.inCheck(s, c)) this.finish(opp(c), 'checkmate');
      else if (s.eventHorizon > 0) return false;
      else this.finish(null, 'stalemate');
      return true;
    }
    if (s.halfmove >= 100) return this.finish(null, '50-move rule'), true;
    if ((s.repetition[E.posKey(s)] || 0) >= 3) return this.finish(null, 'threefold repetition'), true;
    if (E.insufficientMaterial(s)) return this.finish(null, 'insufficient material'), true;
    return false;
  }

  finish(winner, reason) {
    this.phase = 'over';
    this.result = { winner, reason };
    this.cards = null;
    clearTimeout(this.cardTimer);
    clearTimeout(this.revealTimer);
    this.broadcast();
  }

  // ---------- cards ----------
  startCards() {
    const wLMS = E.isLastKingStanding(this.state, 'w');
    const bLMS = E.isLastKingStanding(this.state, 'b');
    const maxPicks = {
      w: wLMS ? 0 : this.state.nextCardPicks?.w || 1,
      b: bLMS ? 0 : this.state.nextCardPicks?.b || 1,
    };
    this.state.nextCardPicks = { w: 1, b: 1 };
    if (maxPicks.w === 0 && maxPicks.b === 0) {
      return this.beginTurn();
    }
    this.phase = 'cards';
    this.cardPhaseId++;
    this.cards = {
      id: this.cardPhaseId,
      hands: {
        w: maxPicks.w > 0 ? Cards.rollHand(this.state, 'w', this.rarityWeights) : [],
        b: maxPicks.b > 0 ? Cards.rollHand(this.state, 'b', this.rarityWeights) : [],
      },
      maxPicks,
      picks: { w: [], b: [] },
      auto: { w: false, b: false },
      wheel: null,
      deadline: Date.now() + CARD_TIME_MS,
    };
    clearTimeout(this.cardTimer);
    this.cardTimer = setTimeout(() => this.resolveCards(), CARD_TIME_MS);
    this.broadcast();
  }

  skipToCards(color) {
    if (this.phase !== 'play') return;
    this.pushNotice(`⚡ ${NAME[color]} skipped directly to the card phase!`);
    this.startCards();
  }

  testCard(color, id) {
    if (this.phase !== 'play' || !Cards.BY_ID[id]) return;
    const before = this.snapBoard();
    const msg = Cards.applyCard(this.state, color, id);
    const after = this.snapBoard();
    const quadPerm = this.state.lastQuadPerm || null;
    const eventHorizonAction = this.state.lastEventHorizon || null;
    this.state.lastQuadPerm = null;
    this.state.lastEventHorizon = null;
    this.state.repetition = {};
    this.state.repetition[E.posKey(this.state)] = 1;
    this.lastEffects = [{ color, card: Cards.publicCard(id), msg, auto: false, before, after, quadPerm, eventHorizonAction }];
    this.effectsId++;
    this.beginTurn();
  }

  forceLastKing(color) {
    if (this.phase !== 'play') return;
    const s = this.state;
    const before = this.snapBoard();
    for (let sq = 0; sq < 64; sq++) {
      const p = s.board[sq];
      if (!p) continue;
      if (p.c === color && p.t !== 'k') {
        s.lost[color].push(p.t);
        s.board[sq] = null;
      } else if (p.c === color && p.t === 'k') {
        p.pink = false;
        p.shotgun = true;
      } else if (p.t === 'k') {
        p.shotgun = false;
      }
    }
    E.updateCastling(s);
    s.turn = color;
    this.legal = E.legalMoves(s, color);
    const after = this.snapBoard();
    s.repetition = {};
    s.repetition[E.posKey(s)] = 1;
    this.lastEffects = [
      {
        color,
        card: Cards.publicCard('shotgunKing'),
        msg: `🔫 ${NAME[color]} is now the Last King Standing with a SHOTGUN!`,
        auto: false,
        before,
        after,
      },
    ];
    this.effectsId++;
    this.broadcast();
  }

  pickCard(color, idxOrId) {
    if (this.phase !== 'cards' || !this.cards) return;
    const cs = this.cards;
    const need = cs.maxPicks[color] ?? 1;
    const arr = cs.picks[color];
    if (arr.length >= need) return;

    if (typeof idxOrId === 'string' && Cards.BY_ID[idxOrId]) {
      const slot = arr.length < cs.hands[color].length ? arr.length : 0;
      cs.hands[color][slot] = idxOrId;
      arr.push(slot);
    } else {
      const idx = Number(idxOrId);
      if (!(idx >= 0 && idx < cs.hands[color].length)) return;
      if (arr.includes(idx)) return; // don't pick the same slot twice
      arr.push(idx);
    }

    const wDone = cs.picks.w.length >= (cs.maxPicks.w ?? 1);
    const bDone = cs.picks.b.length >= (cs.maxPicks.b ?? 1);
    if (wDone && bDone) {
      clearTimeout(this.cardTimer);
      this.resolveCards();
    } else this.broadcast();
  }

  resolveCards() {
    if (this.phase !== 'cards') return;
    const cs = this.cards;
    for (const c of ['w', 'b']) {
      const need = cs.maxPicks[c] ?? 1;
      while (cs.picks[c].length < need) {
        const avail = [0, 1, 2].filter((i) => i < cs.hands[c].length && !cs.picks[c].includes(i));
        if (!avail.length) break;
        cs.picks[c].push(avail[Math.floor(Math.random() * avail.length)]);
        cs.auto[c] = true;
      }
    }

    // Check if BOTH teams chose King with a Shotgun at the same time -> Wheel of Fate!
    const wPickedShotgun = cs.picks.w.some((idx) => cs.hands.w[idx] === 'shotgunKing');
    const bPickedShotgun = cs.picks.b.some((idx) => cs.hands.b[idx] === 'shotgunKing');
    if (wPickedShotgun && bPickedShotgun) {
      const winner = Math.random() < 0.5 ? 'w' : 'b';
      cs.wheel = {
        winner,
        wName: this.seats.w?.name || 'White',
        bName: this.seats.b?.name || 'Black',
      };
    }

    this.phase = 'reveal';
    this.broadcast();
    const waitMs = cs.wheel ? REVEAL_MS + 4200 : REVEAL_MS;
    this.revealTimer = setTimeout(() => {
      const effects = [];
      for (const c of ['w', 'b']) {
        for (const pickIdx of cs.picks[c]) {
          const id = cs.hands[c][pickIdx];
          if (!id) continue;
          // If both picked King with a Shotgun, only the wheel winner gets it!
          if (id === 'shotgunKing' && cs.wheel && cs.wheel.winner !== c) continue;
          const before = this.snapBoard();
          const msg = Cards.applyCard(this.state, c, id);
          const after = this.snapBoard();
          const quadPerm = this.state.lastQuadPerm || null;
          const eventHorizonAction = this.state.lastEventHorizon || null;
          this.state.lastQuadPerm = null;
          this.state.lastEventHorizon = null;
          effects.push({ color: c, card: Cards.publicCard(id), msg, auto: cs.auto[c], before, after, quadPerm, eventHorizonAction });
        }
      }
      this.state.repetition = {};
      this.state.repetition[E.posKey(this.state)] = 1;
      this.lastEffects = effects;
      this.effectsId++;
      this.cards = null;
      this.phase = 'play';
      this.beginTurn();
    }, waitMs);
  }

  // ---------- meta actions ----------
  resign(color) {
    if (this.phase === 'over' || this.phase === 'waiting') return;
    this.finish(opp(color), 'resignation');
  }

  offerDraw(color) {
    if (this.phase === 'over' || this.phase === 'waiting') return;
    if (this.drawOffer === opp(color)) return this.finish(null, 'agreement');
    this.drawOffer = color;
    this.broadcast();
  }

  respondDraw(color, accept) {
    if (this.drawOffer !== opp(color) || this.phase === 'over') return;
    if (accept) return this.finish(null, 'agreement');
    this.drawOffer = null;
    this.pushNotice('Draw offer declined.');
    this.broadcast();
  }

  requestRematch(color) {
    if (this.phase !== 'over') return;
    this.rematch[color] = true;
    if (this.rematch.w && this.rematch.b) {
      [this.seats.w, this.seats.b] = [this.seats.b, this.seats.w];
      for (const c of ['w', 'b']) if (this.seats[c] && this.seats[c].socket) this.seats[c].socket.data.color = c;
      this.resetGame();
      this.phase = 'play';
      this.pushNotice('Rematch! Colors have been swapped.');
    }
    this.broadcast();
  }

  claimWin(color) {
    const o = this.seats[opp(color)];
    if (this.phase === 'over' || this.phase === 'waiting' || !o || o.connected) return;
    if (Date.now() - o.discAt < RECONNECT_GRACE_MS) return;
    this.finish(color, 'abandonment');
  }

  sendChat(color, text) {
    text = String(text || '').trim().slice(0, 200);
    if (!text) return;
    this.chat.push({ color, name: this.seats[color].name, text });
    if (this.chat.length > 100) this.chat.shift();
    this.broadcast();
  }

  pushNotice(text) {
    this.notice = text;
    this.noticeId++;
  }

  // ---------- views ----------
  view(color) {
    const s = this.state;
    const o = opp(color);
    const fogged = s.fog[o] > 0 && this.phase !== 'over';
    const maskBoard = (arr) =>
      arr.map((p) => {
        if (!p) return null;
        if (fogged && p.c === o && !E.hasType(p, 'k')) return null;
        return {
          id: p.id,
          t: p.t,
          c: p.c,
          layers: p.layers ? [...p.layers] : undefined,
          pink: !!p.pink,
          shotgun: !!p.shotgun,
          dmg: p.dmg || 0,
          frozen: p.frozen || 0,
          shield: p.shield || 0,
        };
      });
    const board = maskBoard(s.board);
    let lastMove = this.lastMove;
    if (lastMove && fogged && lastMove.color === o) lastMove = null;
    let checkSq = null;
    if (E.inCheck(s, s.turn)) checkSq = E.kingSq(s, s.turn);
    const seatInfo = (c) => {
      const st = this.seats[c];
      return st ? { name: st.name, connected: !!st.connected } : null;
    };
    const opSeat = this.seats[o];
    let cards = null;
    if (this.cards && (this.phase === 'cards' || this.phase === 'reveal')) {
      const cs = this.cards;
      cards = {
        id: cs.id,
        hand: cs.hands[color].map(Cards.publicCard),
        picked: cs.picks[color], // array of chosen indices, e.g. [0] or [0, 2]
        maxPicks: cs.maxPicks[color] ?? 1,
        oppPicked: cs.picks[o].length >= (cs.maxPicks[o] ?? 1),
        remaining: cs.deadline ? Math.max(0, cs.deadline - Date.now()) : null,
        revealed: this.phase === 'reveal',
        auto: cs.auto[color],
        wheel: cs.wheel || null,
      };
    }
    const turnsLeft = this.halfMovesPerCardPhase - (this.turnsCount % this.halfMovesPerCardPhase);
    const lmsW = E.isLastKingStanding(s, 'w');
    const lmsB = E.isLastKingStanding(s, 'b');
    return {
      code: this.code,
      you: color,
      players: { w: seatInfo('w'), b: seatInfo('b') },
      phase: this.phase,
      turn: s.turn,
      board,
      fogged,
      lmsActive: (lmsW || lmsB) && this.phase !== 'over',
      lmsColor: lmsW ? 'w' : lmsB ? 'b' : null,
      mines: s.mines.filter((m) => m.owner === color).map((m) => m.sq),
      legal: this.phase === 'play' && s.turn === color ? this.legal.map((m) => ({ from: m.from, to: m.to, promo: m.promo || null })) : [],
      lastMove,
      checkSq,
      moves: this.moves.map((m) => ({ ...m, san: m.hidden && m.color === o ? '🌫️' : m.san })),
      lost: s.lost,
      status: { extra: s.extra, skip: s.skip, fog: s.fog, nextCardPicks: s.nextCardPicks, eventHorizon: s.eventHorizon || 0, fourDim: !!s.fourDim },
      result: this.result,
      drawOffer: this.drawOffer,
      rematch: this.rematch,
      cards,
      shotgunFire: this.lastShotgun
        ? {
            id: this.shotgunId,
            ...this.lastShotgun,
            before: this.lastShotgun.before ? maskBoard(this.lastShotgun.before) : null,
            after: this.lastShotgun.after ? maskBoard(this.lastShotgun.after) : null,
          }
        : null,
      fourDimUnmerge: this.lastFourDimUnmerge
        ? {
            id: this.fourDimUnmergeId,
            before: this.lastFourDimUnmerge.before ? maskBoard(this.lastFourDimUnmerge.before) : null,
            after: this.lastFourDimUnmerge.after ? maskBoard(this.lastFourDimUnmerge.after) : null,
          }
        : null,
      effects: this.lastEffects
        ? {
            id: this.effectsId,
            list: this.lastEffects.map((ef) => ({
              ...ef,
              before: ef.before ? maskBoard(ef.before) : null,
              after: ef.after ? maskBoard(ef.after) : null,
            })),
          }
        : null,
      notice: this.notice ? { id: this.noticeId, text: this.notice } : null,
      cardInterval: this.cardIntervalTurns,
      rarityWeights: this.rarityWeights,
      fullMovesUntilCards: Math.ceil(turnsLeft / 2),
      allCards: Cards.CARDS.map((c) => Cards.publicCard(c.id)),
      canClaim: !!(opSeat && !opSeat.connected && opSeat.discAt && Date.now() - opSeat.discAt >= RECONNECT_GRACE_MS && this.phase !== 'over' && this.phase !== 'waiting'),
      chat: this.chat,
    };
  }

  broadcast() {
    for (const c of ['w', 'b']) {
      const seat = this.seats[c];
      if (seat && seat.socket) seat.socket.emit('state', this.view(c));
    }
  }
}

module.exports = { Room };
