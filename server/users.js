// Persistent user authentication and stats storage for Spellbound Chess.
// Data is stored directly on disk at server/data/users.json in clean, human-readable JSON.
// The server owner can directly open and edit users.json at any time.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RENDER_DISK_DIR = process.env.DATA_DIR || (fs.existsSync('/var/data') ? '/var/data' : null);
const DATA_DIR = RENDER_DISK_DIR || path.join(__dirname, 'data');
const USERS_FILE = process.env.USERS_FILE || path.join(DATA_DIR, 'users.json');
const BUNDLED_USERS_FILE = path.join(__dirname, 'data', 'users.json');

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URL || null;
const MONGODB_DB = process.env.MONGODB_DB || 'spellbound_chess';

const SKILL_CARDS = {
  quickPawn: {
    id: 'quickPawn',
    name: 'Quick Pawn',
    icon: '♟️',
    cost: 5,
    rarity: 'common',
    desc: 'Pawns can capture backwards and diagonally backwards for 1 turn.',
  },
  jumpOver: {
    id: 'jumpOver',
    name: 'Jump Over',
    icon: '🦘',
    cost: 10,
    rarity: 'rare',
    desc: 'Your pieces can jump over any opponent piece or the Event Horizon to empty squares (cannot capture).',
  },
  shieldWall: {
    id: 'shieldWall',
    name: 'Shield Wall',
    icon: '🛡️',
    cost: 12,
    rarity: 'rare',
    desc: 'Grant divine shield (+1 shield) to all your pawns on the board.',
  },
  portalSwap: {
    id: 'portalSwap',
    name: 'Portal Swap',
    icon: '🌀',
    cost: 18,
    rarity: 'epic',
    desc: 'Swap positions of any two of your own pieces on the board.',
  },
  timeWarp: {
    id: 'timeWarp',
    name: 'Time Warp',
    icon: '⏳',
    cost: 25,
    rarity: 'legendary',
    desc: 'Take an extra turn immediately after this move.',
  },
};

class UserManager {
  constructor(filePath = USERS_FILE, mongoUri = (filePath === USERS_FILE ? MONGODB_URI : null)) {
    this.filePath = filePath;
    this.dataDir = path.dirname(filePath);
    this.users = {}; // key: lowercase username -> user object
    this.tokens = new Map(); // token -> lowercase username
    this.lastMtime = 0;
    this.sessionSecret = null;
    this.mongoUri = mongoUri;
    this.mongoClient = null;
    this.mongoCollection = null;
    this.isMongoConnected = false;
    this.mongoInitPromise = null;

    this.ensureStorage();
    this.load();

    if (this.mongoUri) {
      this.initMongo().catch((err) => {
        console.error('[UserManager] MongoDB init error:', err.message);
      });
    }
  }

  getSessionSecret() {
    if (this.sessionSecret) return this.sessionSecret;
    if (process.env.SESSION_SECRET) {
      this.sessionSecret = process.env.SESSION_SECRET;
      return this.sessionSecret;
    }
    const secretFile = path.join(this.dataDir, '.secret');
    try {
      if (fs.existsSync(secretFile)) {
        this.sessionSecret = fs.readFileSync(secretFile, 'utf8').trim();
      } else {
        this.sessionSecret = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(secretFile, this.sessionSecret, 'utf8');
      }
    } catch {
      this.sessionSecret = 'sbc_render_permanent_secret_key_2026';
    }
    return this.sessionSecret;
  }

  ensureStorage() {
    if (!fs.existsSync(this.dataDir)) {
      try {
        fs.mkdirSync(this.dataDir, { recursive: true });
      } catch (err) {
        console.error('[UserManager] Failed to create data dir:', err.message);
      }
    }
    if (!fs.existsSync(this.filePath)) {
      // If mounted on Render persistent disk, seed from bundled file for default production storage
      if (RENDER_DISK_DIR && this.filePath === USERS_FILE && fs.existsSync(BUNDLED_USERS_FILE) && path.resolve(this.filePath) !== path.resolve(BUNDLED_USERS_FILE)) {
        try {
          fs.copyFileSync(BUNDLED_USERS_FILE, this.filePath);
          return;
        } catch {}
      }
      this.users = {};
      this.save(true);
    }
  }

  // Reloads data from disk if the file has been modified externally (e.g. by git pull or editor)
  checkReload() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const stat = fs.statSync(this.filePath);
      if (stat.mtimeMs > this.lastMtime) {
        this.load();
      }
    } catch (err) {
      console.error('[UserManager] checkReload error:', err.message);
    }
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8').trim();
        this.users = raw ? JSON.parse(raw) : {};
        const stat = fs.statSync(this.filePath);
        this.lastMtime = stat.mtimeMs;
        // Re-index persistent user tokens so active sessions survive restarts
        for (const [k, u] of Object.entries(this.users)) {
          if (u && u.lastToken) {
            this.tokens.set(u.lastToken, k);
          }
        }
      } else {
        this.users = {};
      }
    } catch (err) {
      console.error('[UserManager] Failed to read users file:', err.message);
      if (!this.users) this.users = {};
    }
  }

  async initMongo() {
    if (!this.mongoUri) return;
    if (this.mongoInitPromise) return this.mongoInitPromise;

    this.mongoInitPromise = (async () => {
      try {
        const { MongoClient } = require('mongodb');
        this.mongoClient = new MongoClient(this.mongoUri, {
          serverSelectionTimeoutMS: 8000,
          connectTimeoutMS: 10000,
        });
        await this.mongoClient.connect();
        const db = this.mongoClient.db(MONGODB_DB);
        this.mongoCollection = db.collection('users');
        this.isMongoConnected = true;
        console.log('[UserManager] Successfully connected to MongoDB Atlas cloud database.');
        await this.syncFromMongo();
      } catch (err) {
        console.error('[UserManager] Failed to connect to MongoDB Atlas:', err.message);
        this.isMongoConnected = false;
      }
    })();

    return this.mongoInitPromise;
  }

  async syncFromMongo() {
    if (!this.isMongoConnected || !this.mongoCollection) return;
    try {
      const docs = await this.mongoCollection.find({}).toArray();
      if (docs.length === 0) {
        // Cloud collection is empty. Seed local users (like esojin0012) into MongoDB Atlas
        console.log('[UserManager] Cloud collection empty. Seeding local users to MongoDB Atlas...');
        await this.persistAllToMongo();
      } else {
        // Sync cloud users into in-memory dictionary
        for (const doc of docs) {
          const key = (doc._id || doc.username || '').toLowerCase();
          if (key) {
            const userObj = { ...doc };
            delete userObj._id;
            this.users[key] = userObj;
            if (userObj.lastToken) {
              this.tokens.set(userObj.lastToken, key);
            }
          }
        }
        // Save back to local cache file as backup
        try {
          const json = JSON.stringify(this.users, null, 2);
          const tmpFile = `${this.filePath}.tmp.${Date.now()}`;
          fs.writeFileSync(tmpFile, json, 'utf8');
          fs.renameSync(tmpFile, this.filePath);
          const stat = fs.statSync(this.filePath);
          this.lastMtime = stat.mtimeMs;
        } catch {}
        console.log(`[UserManager] Loaded ${docs.length} user account(s) from MongoDB Atlas.`);
      }
    } catch (err) {
      console.error('[UserManager] Failed to sync from MongoDB Atlas:', err.message);
    }
  }

  async persistUserToMongo(key) {
    if (this.mongoInitPromise && !this.isMongoConnected) {
      try { await this.mongoInitPromise; } catch {}
    }
    if (!this.isMongoConnected || !this.mongoCollection || !key) return;
    const user = this.users[key];
    if (!user) return;
    try {
      const doc = { ...user, _id: key, updatedAt: new Date().toISOString() };
      await this.mongoCollection.updateOne({ _id: key }, { $set: doc }, { upsert: true });
    } catch (err) {
      console.error(`[UserManager] Failed to persist user ${key} to MongoDB Atlas:`, err.message);
    }
  }

  async persistAllToMongo() {
    if (this.mongoInitPromise && !this.isMongoConnected) {
      try { await this.mongoInitPromise; } catch {}
    }
    if (!this.isMongoConnected || !this.mongoCollection) return;
    const keys = Object.keys(this.users);
    if (keys.length === 0) return;
    try {
      const ops = keys.map((key) => ({
        updateOne: {
          filter: { _id: key },
          update: { $set: { ...this.users[key], _id: key, updatedAt: new Date().toISOString() } },
          upsert: true,
        },
      }));
      await this.mongoCollection.bulkWrite(ops);
      console.log(`[UserManager] Persisted ${keys.length} user account(s) to MongoDB Atlas.`);
    } catch (err) {
      console.error('[UserManager] Failed to bulk persist users to MongoDB Atlas:', err.message);
    }
  }

  async closeMongo() {
    if (this.mongoClient) {
      try {
        await this.mongoClient.close();
      } catch {}
      this.mongoClient = null;
      this.mongoCollection = null;
      this.isMongoConnected = false;
      this.mongoInitPromise = null;
    }
  }

  save(force = false) {
    try {
      const json = JSON.stringify(this.users, null, 2);
      const tmpFile = `${this.filePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpFile, json, 'utf8');
      fs.renameSync(tmpFile, this.filePath);
      const stat = fs.statSync(this.filePath);
      this.lastMtime = stat.mtimeMs;
    } catch (err) {
      console.error('[UserManager] Failed to save users file:', err.message);
    }

    if (this.isMongoConnected) {
      this.persistAllToMongo().catch(() => {});
    }
  }

  hashPassword(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  }

  validateUsername(username) {
    const u = String(username || '').trim();
    if (u.length < 3 || u.length > 20) {
      return { valid: false, error: 'Username must be between 3 and 20 characters.' };
    }
    if (!/^[a-zA-Z0-9_\-]+$/.test(u)) {
      return { valid: false, error: 'Username can only contain letters, numbers, hyphens, and underscores.' };
    }
    return { valid: true, username: u };
  }

  validatePassword(password) {
    const p = String(password || '');
    if (p.length < 6) {
      return { valid: false, error: 'Password must be at least 6 characters long.' };
    }
    return { valid: true, password: p };
  }

  publicProfile(user) {
    if (!user) return null;
    const stats = user.stats || { wins: 0, losses: 0, draws: 0, gamesPlayed: 0 };
    const gamesPlayed = (stats.wins || 0) + (stats.losses || 0) + (stats.draws || 0);
    const winRate = gamesPlayed > 0 ? Math.round(((stats.wins || 0) / gamesPlayed) * 100) : 0;

    return {
      id: user.id,
      username: user.username,
      customTitle: user.customTitle || '',
      coins: user.coins || 0,
      skills: Array.isArray(user.skills) ? [...user.skills] : [],
      equippedSkill: user.equippedSkill || null,
      createdAt: user.createdAt,
      stats: {
        wins: stats.wins || 0,
        losses: stats.losses || 0,
        draws: stats.draws || 0,
        gamesPlayed,
        winRate,
      },
    };
  }

  register(rawUsername, rawPassword) {
    this.checkReload();
    const uVal = this.validateUsername(rawUsername);
    if (!uVal.valid) return { error: uVal.error };

    const pVal = this.validatePassword(rawPassword);
    if (!pVal.valid) return { error: pVal.error };

    const username = uVal.username;
    const key = username.toLowerCase();

    if (this.users[key]) {
      return { error: 'Username is already taken.' };
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = this.hashPassword(pVal.password, salt);
    const id = 'usr_' + crypto.randomBytes(8).toString('hex');
    const now = new Date().toISOString();

    const user = {
      id,
      username,
      passwordHash,
      salt,
      createdAt: now,
      lastLogin: now,
      customTitle: 'Novice Wizard',
      coins: 0,
      skills: [],
      equippedSkill: null,
      stats: {
        wins: 0,
        losses: 0,
        draws: 0,
        gamesPlayed: 0,
      },
    };

    const token = this.createToken(key);
    user.lastToken = token;
    this.users[key] = user;
    this.save();
    this.persistUserToMongo(key);

    return { token, user: this.publicProfile(user) };
  }

  createToken(key) {
    const secret = this.getSessionSecret();
    const user = this.users[key];
    const userId = user ? user.id : key;
    const payload = `${key}:${userId}:${Date.now()}`;
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const token = `${Buffer.from(payload).toString('base64url')}.${sig}`;
    this.tokens.set(token, key);
    return token;
  }

  login(rawUsername, rawPassword) {
    this.checkReload();
    const username = String(rawUsername || '').trim();
    const password = String(rawPassword || '');
    const key = username.toLowerCase();

    const user = this.users[key];
    if (!user) {
      return { error: 'Invalid username or password.' };
    }

    const testHash = this.hashPassword(password, user.salt);
    if (testHash !== user.passwordHash) {
      return { error: 'Invalid username or password.' };
    }

    user.lastLogin = new Date().toISOString();
    const token = this.createToken(key);
    user.lastToken = token;
    this.save();
    this.persistUserToMongo(key);

    return { token, user: this.publicProfile(user) };
  }

  getUserByToken(token) {
    if (!token || typeof token !== 'string') return null;
    this.checkReload();

    let key = this.tokens.get(token);

    // Cryptographic HMAC token verification (survives process restarts / file changes / redeployments!)
    if (!key && token.includes('.')) {
      try {
        const [b64Payload, sig] = token.split('.');
        if (b64Payload && sig) {
          const payload = Buffer.from(b64Payload, 'base64url').toString('utf8');
          const expectedSig = crypto.createHmac('sha256', this.getSessionSecret()).update(payload).digest('hex');
          if (sig.length === expectedSig.length && crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'))) {
            const parts = payload.split(':');
            const candidateKey = (parts[0] || '').toLowerCase();
            if (candidateKey && this.users[candidateKey]) {
              key = candidateKey;
              this.tokens.set(token, key);
            }
          }
        }
      } catch (err) {}
    }

    // Fallback: check if token matches user.lastToken on any user
    if (!key) {
      for (const k of Object.keys(this.users)) {
        if (this.users[k].lastToken === token) {
          key = k;
          this.tokens.set(token, key);
          break;
        }
      }
    }

    if (!key || !this.users[key]) return null;
    return this.publicProfile(this.users[key]);
  }

  getUserById(id) {
    if (!id) return null;
    this.checkReload();
    for (const key of Object.keys(this.users)) {
      if (this.users[key].id === id) {
        return this.users[key];
      }
    }
    return null;
  }

  logout(token) {
    if (!token) return;
    const key = this.tokens.get(token);
    this.tokens.delete(token);
    if (key && this.users[key] && this.users[key].lastToken === token) {
      this.users[key].lastToken = null;
      this.save();
      this.persistUserToMongo(key);
    }
  }

  recordGameOutcome({ whiteUserId, blackUserId, winnerColor, coinsAwarded = 0 }) {
    this.checkReload();
    let changed = false;

    const wUser = whiteUserId ? this.getUserById(whiteUserId) : null;
    const bUser = blackUserId ? this.getUserById(blackUserId) : null;

    if (!wUser && !bUser) return;

    const ensureStats = (u) => {
      if (!u.stats) u.stats = { wins: 0, losses: 0, draws: 0, gamesPlayed: 0 };
      if (u.coins == null) u.coins = 0;
    };

    if (wUser) {
      ensureStats(wUser);
      if (winnerColor === 'w') {
        wUser.stats.wins = (wUser.stats.wins || 0) + 1;
        if (coinsAwarded > 0) wUser.coins = (wUser.coins || 0) + coinsAwarded;
      } else if (winnerColor === 'b') {
        wUser.stats.losses = (wUser.stats.losses || 0) + 1;
      } else {
        wUser.stats.draws = (wUser.stats.draws || 0) + 1;
      }
      wUser.stats.gamesPlayed = (wUser.stats.wins || 0) + (wUser.stats.losses || 0) + (wUser.stats.draws || 0);
      changed = true;
    }

    if (bUser) {
      ensureStats(bUser);
      if (winnerColor === 'b') {
        bUser.stats.wins = (bUser.stats.wins || 0) + 1;
        if (coinsAwarded > 0) bUser.coins = (bUser.coins || 0) + coinsAwarded;
      } else if (winnerColor === 'w') {
        bUser.stats.losses = (bUser.stats.losses || 0) + 1;
      } else {
        bUser.stats.draws = (bUser.stats.draws || 0) + 1;
      }
      bUser.stats.gamesPlayed = (bUser.stats.wins || 0) + (bUser.stats.losses || 0) + (bUser.stats.draws || 0);
      changed = true;
    }

    if (changed) {
      this.save();
      if (wUser && wUser.username) this.persistUserToMongo(wUser.username.toLowerCase());
      if (bUser && bUser.username) this.persistUserToMongo(bUser.username.toLowerCase());
    }

    return {
      white: wUser ? this.publicProfile(wUser) : null,
      black: bUser ? this.publicProfile(bUser) : null,
    };
  }

  getShopCatalog() {
    return Object.values(SKILL_CARDS);
  }

  buySkill(userId, skillId) {
    this.checkReload();
    const user = this.getUserById(userId);
    if (!user) return { error: 'User not found.' };

    const skill = SKILL_CARDS[skillId];
    if (!skill) return { error: 'Skill card not found.' };

    if (!Array.isArray(user.skills)) user.skills = [];
    if (user.skills.includes(skillId)) return { error: 'You already own this skill card!' };

    const cost = skill.cost || 0;
    const currentCoins = user.coins || 0;
    if (currentCoins < cost) {
      return { error: `Not enough coins. Need ${cost} coins, but you have ${currentCoins}.` };
    }

    user.coins = currentCoins - cost;
    user.skills.push(skillId);
    if (!user.equippedSkill) {
      user.equippedSkill = skillId;
    }
    this.save();
    if (user.username) this.persistUserToMongo(user.username.toLowerCase());

    return { success: true, user: this.publicProfile(user), skill };
  }

  equipSkill(userId, skillId) {
    this.checkReload();
    const user = this.getUserById(userId);
    if (!user) return { error: 'User not found.' };

    if (skillId !== null) {
      const skill = SKILL_CARDS[skillId];
      if (!skill) return { error: 'Skill card not found.' };
      if (!Array.isArray(user.skills) || !user.skills.includes(skillId)) {
        return { error: 'You do not own this skill card.' };
      }
      user.equippedSkill = skillId;
    } else {
      user.equippedSkill = null;
    }

    this.save();
    if (user.username) this.persistUserToMongo(user.username.toLowerCase());
    return { success: true, user: this.publicProfile(user) };
  }

  addCoins(userId, amount) {
    this.checkReload();
    const user = this.getUserById(userId);
    if (!user) return null;
    user.coins = Math.max(0, (user.coins || 0) + (Number(amount) || 0));
    this.save();
    if (user.username) this.persistUserToMongo(user.username.toLowerCase());
    return this.publicProfile(user);
  }
}

const defaultManager = new UserManager();

module.exports = {
  UserManager,
  users: defaultManager,
  SKILL_CARDS,
};
