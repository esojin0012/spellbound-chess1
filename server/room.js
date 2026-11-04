// A Room = one game between two players, identified by a 6-char Room ID.
const E = require('./engine');
const Cards = require('./cards');
const { users, SKILL_CARDS } = require('./users');
const { opp, FILES, row, col, sqName } = E;

function getDogLaneSquares(tele) {
  const laneSquares = [];
  if (!tele) return laneSquares;
  if (tele.type === 'rank') {
    for (let c = 0; c < 8; c++) laneSquares.push(tele.index * 8 + c);
  } else if (tele.type === 'file') {
    for (let r = 0; r < 8; r++) laneSquares.push(r * 8 + tele.index);
  } else if (tele.type === 'diagMain') {
    const k = tele.index; // col - row = k
    for (let r = 0; r < 8; r++) {
      const c = r + k;
      if (c >= 0 && c < 8) laneSquares.push(r * 8 + c);
    }
  } else if (tele.type === 'diagAnti') {
    const k = tele.index; // col + row = k
    for (let r = 0; r < 8; r++) {
      const c = k - r;
      if (c >= 0 && c < 8) laneSquares.push(r * 8 + c);
    }
  }
  return laneSquares;
}

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
    this.cardPhaseId = 0;
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

  isDefaultRarity() {
    const d = Cards.RARITY_WEIGHTS;
    const r = this.rarityWeights;
    return (
      r &&
      r.common === d.common &&
      r.rare === d.rare &&
      r.epic === d.epic &&
      r.legendary === d.legendary &&
      r.event === d.event
    );
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
    this.lastEffects = null;
    this.effectsId = 0;
    this.lastShotgun = null;
    this.shotgunId = 0;
    this.lastDogDash = null;
    this.dogDashId = 0;
    this.notice = null;
    this.noticeId = 0;
    this.statsRecorded = false;
    this.skillsUsed = { w: false, b: false };
    clearTimeout(this.cardTimer);
    clearTimeout(this.revealTimer);
    this.legal = E.legalMoves(this.state, 'w');
  }

  // ---------- players ----------
  join(socket, token, name, user = null) {
    user = user || socket.data.user || null;
    if (user && user.username) name = user.username;
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
      this.seats[color] = { token, name, user };
    }
    const seat = this.seats[color];
    if (seat.socket && seat.socket !== socket) seat.socket.disconnect(true);
    seat.socket = socket;
    seat.connected = true;
    seat.discAt = null;
    seat.name = name;
    if (user) seat.user = user;
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
    if (info.dogHit) {
      if (info.dogHit.killed) {
        this.pushNotice(`✨ The Devourer of Gods was defeated and withered into cosmic starlight!`);
      } else {
        this.pushNotice(`💥 ${NAME[color]} attacked The Devourer of Gods for ${info.dogHit.dmg} dmg! [${info.dogHit.dogHp}/100 HP]`);
      }
    }

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
  }

  executeDogAttack() {
    const s = this.state;
    if (!s.dog || !s.dog.active) return;
    const tele = s.dog.telegraph || { type: 'rank', index: Math.floor(Math.random() * 8) };
    const laneSquares = tele.squares || getDogLaneSquares(tele);

    const wiped = [];
    for (const sq of laneSquares) {
      const p = s.board[sq];
      if (!p) continue;
      if (E.hasType(p, 'k')) {
        let safeSq = -1;
        for (const dr of [-1, 0, 1]) {
          for (const dc of [-1, 0, 1]) {
            if (dr === 0 && dc === 0) continue;
            const nr = row(sq) + dr;
            const nc = col(sq) + dc;
            if (nr >= 0 && nr <= 7 && nc >= 0 && nc <= 7) {
              const test = nr * 8 + nc;
              if (!laneSquares.includes(test) && !s.board[test]) {
                safeSq = test;
                break;
              }
            }
          }
          if (safeSq !== -1) break;
        }
        if (safeSq === -1) {
          for (let cand = 0; cand < 64; cand++) {
            if (!laneSquares.includes(cand) && !s.board[cand]) { safeSq = cand; break; }
          }
        }
        if (safeSq !== -1) {
          s.board[safeSq] = p;
          s.board[sq] = null;
        }
      } else {
        E.recordLost(s, p);
        s.board[sq] = null;
        wiped.push({ sq, piece: p.t, color: p.c });
      }
    }
    E.updateCastling(s);

    // Attempt to curl around a 6-tile circular pattern (pieces on squares remain intact!)
    const curlPath = Cards.findDogCurlingPath(s.board, 6);
    if (curlPath && curlPath.length === 6) {
      s.dog.phase = 'coiled';
      s.dog.curlCycle = [...curlPath];
      s.dog.segments = curlPath.map((sq, i) => ({
        sq,
        type: i === 0 ? 'head' : i === 5 ? 'tail' : 'body',
        order: i,
      }));
      this.pushNotice(`🌌 The Devourer of Gods dashed and coiled onto the board! ATTACK IT NOW!`);
    } else {
      s.dog.phase = 'idle';
      s.dog.segments = [];
      s.dog.curlCycle = null;
      this.pushNotice(`🌌 The Devourer of Gods dashed through and vanished back into the cosmic void!`);
    }

    this.dogDashId++;
    this.lastDogDash = {
      id: this.dogDashId,
      lane: tele,
      wipedSquares: wiped,
      curled: s.dog.segments.length > 0,
      segments: [...s.dog.segments],
    };

    s.dog.turnsUntilAttack = 10;
    s.dog.telegraph = null;
  }

  tickDog(isCardTurn = false) {
    const s = this.state;
    if (!s.dog || !s.dog.active) return;
    s.dog.turnsUntilAttack--;

    // Coiled phase: spin segments around the circular pattern turn-by-turn!
    if (s.dog.phase === 'coiled' && s.dog.curlCycle && s.dog.curlCycle.length === 6 && s.dog.segments && s.dog.segments.length === 6 && s.dog.turnsUntilAttack > 6) {
      s.dog.segments = s.dog.segments.map((seg) => {
        const nextOrder = (seg.order + 1) % 6;
        return {
          ...seg,
          order: nextOrder,
          sq: s.dog.curlCycle[nextOrder],
        };
      });
    }

    // 6 turns until attack: signal telegraph lane and uncoil off-board
    if (s.dog.turnsUntilAttack === 6) {
      const types = ['rank', 'file', 'diagMain', 'diagAnti'];
      const chosenType = types[Math.floor(Math.random() * types.length)];
      let idx = 0;
      if (chosenType === 'rank' || chosenType === 'file') {
        idx = Math.floor(Math.random() * 8);
      } else if (chosenType === 'diagMain') {
        const kOptions = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
        idx = kOptions[Math.floor(Math.random() * kOptions.length)];
      } else {
        const kOptions = [3, 4, 5, 6, 7, 8, 9, 10, 11];
        idx = kOptions[Math.floor(Math.random() * kOptions.length)];
      }
      const tele = { type: chosenType, index: idx };
      tele.squares = getDogLaneSquares(tele);
      s.dog.telegraph = tele;
      s.dog.phase = 'telegraph';
      s.dog.segments = []; // Leaves the board to stalk from the void
      s.dog.curlCycle = null;

      let laneStr = '';
      if (chosenType === 'rank') {
        laneStr = `Rank ${idx + 1}`;
      } else if (chosenType === 'file') {
        laneStr = `File ${FILES[idx].toUpperCase()}`;
      } else {
        const sqs = tele.squares;
        laneStr = `Diagonal ${sqName(sqs[0]).toUpperCase()}–${sqName(sqs[sqs.length - 1]).toUpperCase()}`;
      }
      this.pushNotice(`⚠️ THE DEVOURER OF GODS is targeting ${laneStr}! (6 turns until strike)`);
    }

    // 0 turns until attack:
    if (s.dog.turnsUntilAttack <= 0) {
      if (isCardTurn) {
        s.dog.pendingAttackAfterCards = true;
      } else {
        this.executeDogAttack();
      }
    }
  }

  endTurn() {
    const s = this.state;
    const X = s.turn;
    const Y = opp(X);
    this.endTurnStatuses(X);
    this.state.activeSkill = null;
    s.turn = Y;
    this.turnsCount++;
    const isCardTurn = (this.turnsCount % this.halfMovesPerCardPhase === 0);
    if (s.dog && s.dog.active) {
      this.tickDog(isCardTurn);
    }
    const key = E.posKey(s);
    s.repetition[key] = (s.repetition[key] || 0) + 1;
    this.legal = E.legalMoves(s, Y);
    if (this.checkGameOver()) return;
    if (isCardTurn) return this.startCards();
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
    const isDefault = this.isDefaultRarity();
    const coinsAwarded = winner ? (isDefault ? 5 : 1) : 0;
    this.phase = 'over';
    this.result = { winner, reason, coinsAwarded, isDefaultRarity: isDefault };
    this.cards = null;
    clearTimeout(this.cardTimer);
    clearTimeout(this.revealTimer);

    if (!this.statsRecorded) {
      this.statsRecorded = true;
      const whiteUserId = this.seats.w?.user?.id || null;
      const blackUserId = this.seats.b?.user?.id || null;
      if (whiteUserId || blackUserId) {
        const updated = users.recordGameOutcome({
          whiteUserId,
          blackUserId,
          winnerColor: winner,
          coinsAwarded,
        });
        if (updated) {
          if (updated.white && this.seats.w) this.seats.w.user = updated.white;
          if (updated.black && this.seats.b) this.seats.b.user = updated.black;
        }
      }
    }

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
    if (id === 'devourerOfGods' && this.state.dog && this.state.dog.active) {
      this.pushNotice('⚠️ The Devourer of Gods is already active on the board!');
      return;
    }
    const before = this.snapBoard();
    const msg = Cards.applyCard(this.state, color, id);
    const after = this.snapBoard();
    const quadPerm = this.state.lastQuadPerm || null;
    const eventHorizonAction = this.state.lastEventHorizon || null;
    const dogEvent = this.state.lastDogEvent || null;
    this.state.lastQuadPerm = null;
    this.state.lastEventHorizon = null;
    this.state.lastDogEvent = null;
    this.state.repetition = {};
    this.state.repetition[E.posKey(this.state)] = 1;
    this.lastEffects = [{ color, card: Cards.publicCard(id), msg, auto: false, before, after, quadPerm, eventHorizonAction, dogEvent }];
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

  useSkill(color, params = {}) {
    if (this.phase !== 'play' || this.state.turn !== color) return { error: 'Can only use skill on your turn.' };
    if (this.skillsUsed && this.skillsUsed[color]) return { error: 'Skill already used this game.' };
    const seat = this.seats[color];
    const u = seat?.user ? (users.getUserById(seat.user.id) || seat.user) : null;
    const skillId = u?.equippedSkill;
    if (!skillId || !SKILL_CARDS[skillId]) return { error: 'No skill card equipped.' };

    this.skillsUsed[color] = true;
    const skill = SKILL_CARDS[skillId];

    if (skillId === 'quickPawn') {
      this.state.activeSkill = { type: 'quickPawn', color };
      this.pushNotice(`⚡ ${seat.name} activated Skill: Quick Pawn! Pawns can capture backwards this turn!`);
    } else if (skillId === 'jumpOver') {
      this.state.activeSkill = { type: 'jumpOver', color };
      this.pushNotice(`⚡ ${seat.name} activated Skill: Jump Over! Pieces can jump over enemies & Event Horizon!`);
    } else if (skillId === 'shieldWall') {
      let count = 0;
      for (const p of this.state.board) {
        if (p && p.c === color && E.hasType(p, 'p')) {
          p.shield = (p.shield || 0) + 1;
          count++;
        }
      }
      this.pushNotice(`🛡️ ${seat.name} activated Skill: Shield Wall! ${count} pawns gained divine shields!`);
    } else if (skillId === 'portalSwap') {
      const b = this.state.board;
      const ownNonKings = [];
      b.forEach((p, s) => { if (p && p.c === color && !E.hasType(p, 'k')) ownNonKings.push(s); });
      let s1 = params.sq1, s2 = params.sq2;
      if (s1 == null || s2 == null || s1 === s2 || !b[s1] || !b[s2] || b[s1].c !== color || b[s2].c !== color || E.hasType(b[s1], 'k') || E.hasType(b[s2], 'k')) {
        if (ownNonKings.length >= 2) {
          s1 = ownNonKings[0];
          s2 = ownNonKings[ownNonKings.length - 1];
        }
      }
      if (s1 != null && s2 != null && s1 !== s2 && b[s1] && b[s2]) {
        [b[s1], b[s2]] = [b[s2], b[s1]];
        this.pushNotice(`🌀 ${seat.name} activated Skill: Portal Swap! Swapped two pieces!`);
      } else {
        this.pushNotice(`🌀 ${seat.name} activated Skill: Portal Swap! (No pieces available to swap)`);
      }
    } else if (skillId === 'timeWarp') {
      this.state.extra[color] = (this.state.extra[color] || 0) + 1;
      this.pushNotice(`⏳ ${seat.name} activated Skill: Time Warp! Extra turn granted!`);
    }

    this.legal = E.legalMoves(this.state, color);
    this.broadcast();
    return { success: true };
  }

  pickCard(color, idxOrId) {
    if (this.phase !== 'cards' || !this.cards) return;
    const cs = this.cards;
    const need = cs.maxPicks[color] ?? 1;
    const arr = cs.picks[color];
    if (arr.length >= need) return;

    if (typeof idxOrId === 'string' && Cards.BY_ID[idxOrId]) {
      if (idxOrId === 'devourerOfGods' && this.state.dog && this.state.dog.active) return;
      const slot = arr.length < cs.hands[color].length ? arr.length : 0;
      cs.hands[color][slot] = idxOrId;
      arr.push(slot);
    } else {
      const idx = Number(idxOrId);
      if (!(idx >= 0 && idx < cs.hands[color].length)) return;
      if (cs.hands[color][idx] === 'devourerOfGods' && this.state.dog && this.state.dog.active) return;
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
          const dogEvent = this.state.lastDogEvent || null;
          this.state.lastQuadPerm = null;
          this.state.lastEventHorizon = null;
          this.state.lastDogEvent = null;
          effects.push({ color: c, card: Cards.publicCard(id), msg, auto: cs.auto[c], before, after, quadPerm, eventHorizonAction, dogEvent });
        }
      }
      this.state.repetition = {};
      this.state.repetition[E.posKey(this.state)] = 1;
      this.lastEffects = effects;
      this.effectsId++;
      this.cards = null;
      this.phase = 'play';
      if (this.state.dog && this.state.dog.active && this.state.dog.pendingAttackAfterCards) {
        this.state.dog.pendingAttackAfterCards = false;
        this.executeDogAttack();
      }
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
      for (const c of ['w', 'b']) {
        if (this.seats[c] && this.seats[c].socket) {
          if (!this.seats[c].socket.data) this.seats[c].socket.data = {};
          this.seats[c].socket.data.color = c;
        }
      }
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
      if (!st) return null;
      const u = st.user ? (users.getUserById(st.user.id) || st.user) : null;
      if (!u) return { name: st.name, connected: !!st.connected, user: null };
      const profile = users.publicProfile(u);
      return {
        name: st.name,
        connected: !!st.connected,
        user: {
          ...profile,
          skillCard: profile.equippedSkill ? SKILL_CARDS[profile.equippedSkill] : null,
          skillUsed: !!(this.skillsUsed && this.skillsUsed[c]),
        },
      };
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
      status: { extra: s.extra, skip: s.skip, fog: s.fog, nextCardPicks: s.nextCardPicks, eventHorizon: s.eventHorizon || 0 },
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
      equippedSkill: (() => {
        const u = this.seats[color]?.user ? (users.getUserById(this.seats[color].user.id) || this.seats[color].user) : null;
        const eqId = u ? (typeof u.equippedSkill === 'object' && u.equippedSkill ? u.equippedSkill.id : u.equippedSkill) : null;
        return eqId && SKILL_CARDS[eqId] ? SKILL_CARDS[eqId] : null;
      })(),
      skillUsed: !!(this.skillsUsed && this.skillsUsed[color]),
      activeSkill: this.state.activeSkill,
      dog: s.dog
        ? {
            active: s.dog.active,
            hp: s.dog.hp,
            maxHp: s.dog.maxHp,
            phase: s.dog.phase,
            turnsUntilAttack: s.dog.turnsUntilAttack,
            telegraph: s.dog.telegraph,
            segments: s.dog.segments,
            lastHit: s.dog.lastHit,
          }
        : null,
      dogDash: this.lastDogDash ? { id: this.dogDashId, ...this.lastDogDash } : null,
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
