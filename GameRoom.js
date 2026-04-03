import { createDeck, shuffleDeck, dealCards } from './utils/deck.js';

const jitterTime = (base) => base + (Math.floor(Math.random() * 70) - 35); 

export class GameRoom {
  constructor(roomCode, mode, numPlayers, io) {
    this.roomCode = roomCode;
    this.mode = mode; // 'offline_solo', 'local_multiplayer', 'online'
    this.maxPlayers = numPlayers;
    this.io = io; 
    
    this.status = 'lobby'; // 'lobby', 'playing', 'ended'
    this.players = [];     // Array of player objects
    this.centerPile = [];
    this.currentPlayerIndex = 0;
    
    this.quitMessage = null;
    this.toastMessage = null;
    
    this.matchState = {
      active: false,
      eligiblePlayerId: null,
      status: 'idle',
      message: '',
      grabbedById: null
    };

    this.grabLock = false;
    this.playLock = false;
    this.nextPlayerUnlockTime = 0;

    // Track timeouts to clean them up on resets/disconnects
    this.timers = new Set();
  }

  addTimer(callback, delay) {
    const id = setTimeout(() => {
      callback();
      this.timers.delete(id);
    }, delay);
    this.timers.add(id);
    return id;
  }

  clearTimers() {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
  }

  getPlayers() {
    return this.players;
  }

  getState() {
    return {
      status: this.status,
      mode: this.mode,
      maxPlayers: this.maxPlayers,
      players: this.players,
      centerPile: this.centerPile,
      currentPlayerIndex: this.currentPlayerIndex,
      matchState: this.matchState,
      quitMessage: this.quitMessage,
      toastMessage: this.toastMessage
    };
  }

  broadcast() {
    this.io.to(this.roomCode).emit('gameStateUpdate', this.getState());
  }

  addPlayer(socketId, name, isHuman) {
    const playerId = this.players.length;
    this.players.push({
      id: playerId,
      socketId,
      name: name,
      isHuman: this.mode === 'online' ? true : isHuman,
      cards: [],
      capturedCards: []
    });

    if (this.mode === 'offline_solo' && this.players.length === 1) {
      // Auto-fill CPU slots
      for (let i = 1; i < this.maxPlayers; i++) {
        this.players.push({
          id: i,
          socketId: null,
          name: `CPU ${i}`,
          isHuman: false,
          cards: [],
          capturedCards: []
        });
      }
    } else if (this.mode === 'local_multiplayer' && this.players.length === 1) {
       for (let i = 1; i < this.maxPlayers; i++) {
        this.players.push({
          id: i,
          socketId: null,
          name: `CPU ${i}`,
          isHuman: false,
          cards: [],
          capturedCards: []
        });
      }
    }
    
    return playerId;
  }

  removePlayer(socketId) {
    this.players = this.players.filter(p => p.socketId !== socketId);
  }

  // Apply edited names from the offline/local lobby before game starts
  patchPlayerNames(localNames) {
    if (!localNames) return;
    this.players.forEach(p => {
      if (localNames[p.id] && localNames[p.id].trim()) {
        p.name = localNames[p.id].trim();
      }
    });
  }

  handlePlayerQuit(socketId) {
    const playerIndex = this.players.findIndex(p => p.socketId === socketId);
    if (playerIndex === -1) return;

    const player = this.players[playerIndex];
    this.players.splice(playerIndex, 1);

    if (this.status === 'playing') {
      if (this.players.length <= 1) {
        this.status = 'ended';
        this.quitMessage = `${player.name} quit. You win!`;
        this.clearTimers();
      } else {
        if (this.currentPlayerIndex > playerIndex) {
          this.currentPlayerIndex--;
        } else if (this.currentPlayerIndex >= this.players.length) {
          this.currentPlayerIndex = 0;
        }

        this.toastMessage = `${player.name} quit. Game continues.`;

        // If it was the quitting player's turn, trigger next turn
        if (this.currentPlayerIndex === playerIndex || this.currentPlayerIndex === 0) {
          this.scheduleCPU();
        }
        
        // clear toast message automatically after a few seconds
        this.addTimer(() => {
          this.toastMessage = null;
          this.broadcast();
        }, 3000);
      }
    }

    this.broadcast();
  }

  initializeGame() {
    this.clearTimers();
    
    const deck = shuffleDeck(createDeck());
    const hands = dealCards(deck, this.maxPlayers);
    
    this.players.forEach((p, i) => {
      p.cards = hands[i] || [];
      p.capturedCards = [];
    });

    this.centerPile = [];
    this.currentPlayerIndex = 0;
    this.matchState = { active: false, eligiblePlayerId: null, status: 'idle', message: '', grabbedById: null };
    this.grabLock = false;
    this.playLock = false;
    this.nextPlayerUnlockTime = 0;
    this.quitMessage = null;
    this.toastMessage = null;
    
    this.status = 'playing';
    
    this.scheduleCPU();
  }

  scheduleCPU() {
    if (this.status !== 'playing' || this.playLock) return;

    const totalCardsLeft = this.players.reduce((acc, p) => acc + p.cards.length, 0);
    if (totalCardsLeft === 0) {
      this.addTimer(() => {
        this.status = 'ended';
        this.broadcast();
      }, 1000);
      return;
    }

    const currPlayer = this.players[this.currentPlayerIndex];
    if (currPlayer.cards.length === 0) {
      this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
      this.broadcast();
      this.scheduleCPU();
      return;
    }

    // Server-side simulated AI thought triggers
    if (!currPlayer.isHuman) {
      const cpuThinkTime = jitterTime(Math.floor(Math.random() * (900 - 400 + 1)) + 400);
      this.addTimer(() => {
        this.attemptPlayCard(currPlayer.id);
      }, cpuThinkTime);
    }
  }

  attemptPlayCard(playerId) {
    if (this.status !== 'playing' || this.playLock) return;
    
    const currPlayer = this.players[this.currentPlayerIndex];
    if (currPlayer.id !== playerId || currPlayer.cards.length === 0) return;

    if (this.matchState.active) {
      if (Date.now() < this.nextPlayerUnlockTime) return; // Reaction delay block
      
      this.matchState = { active: false, eligiblePlayerId: null, status: 'idle', message: '', grabbedById: null };
      this.grabLock = true; 
    }

    this.playLock = true;
    this.broadcast(); // Send lock status instantly to dim play button
    
    const delay = jitterTime(Math.floor(Math.random() * (300 - 150 + 1)) + 150);
    this.addTimer(() => this.revealCard(playerId), delay);
  }

  revealCard(playerId) {
    const currPlayer = this.players[this.currentPlayerIndex];
    if (!currPlayer) { this.playLock = false; return; }

    const cardToPlay = currPlayer.cards.pop(); // Pop from end

    const radius = Math.random() * 15 + 10; 
    const angle = Math.random() * Math.PI * 2;
    const transformX = Math.cos(angle) * radius + ((Math.random() - 0.5) * 10);
    const transformY = Math.sin(angle) * radius + ((Math.random() - 0.5) * 10);
    const rotation = Math.random() * 360;
    const scale = 0.98 + Math.random() * 0.04; 
    const flightDur = Math.floor(Math.random() * (350 - 200 + 1)) + 200;

    const playedCard = {
      ...cardToPlay,
      playedBy: playerId,
      physics: { transformX, transformY, rotation, scale, flightDur }
    };

    this.centerPile.push(playedCard);
    this.playLock = false;

    let isMatch = false;
    if (this.centerPile.length > 1) {
      const prevCard = this.centerPile[this.centerPile.length - 2];
      if (prevCard.value === playedCard.value) isMatch = true;
    }

    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;

    if (isMatch) {
      this.handleMatchDetected(currPlayer.id);
    } else {
      this.scheduleCPU();
    }
    this.broadcast();
  }

  handleMatchDetected(eligiblePlayerId) {
    this.matchState = { active: true, eligiblePlayerId, status: 'detected', message: 'MATCH!', grabbedById: null };
    this.grabLock = false; 
    
    this.nextPlayerUnlockTime = Date.now() + Math.floor(Math.random() * 150) + 150; 
    
    const fairnessDelay = Math.floor(Math.random() * 40) + 80;
    this.addTimer(() => {
      if (!this.matchState.active) return; 
      
      this.matchState.status = 'waiting';
      this.broadcast();

      const player = this.players.find(p => p.id === eligiblePlayerId);
      if (!player.isHuman) {
        const cpuReaction = Math.floor(Math.random() * (700 - 350 + 1)) + 350;
        this.addTimer(() => {
          if (this.matchState.active && this.matchState.status === 'waiting') {
            this.attemptGrab(eligiblePlayerId);
          }
        }, cpuReaction);
      }
      
      // Failsafe if no match grabbed
      this.addTimer(() => {
        if (this.matchState.active && this.matchState.status === 'waiting') {
          this.matchState = { active: false, eligiblePlayerId: null, status: 'idle', message: '', grabbedById: null };
          this.broadcast();
          this.scheduleCPU();
        }
      }, 1200);

    }, fairnessDelay);
  }

  attemptGrab(playerId) {
    if (this.grabLock) return { success: false, reason: 'locked' };
    
    if (!this.matchState.active || this.matchState.status !== 'waiting' || this.matchState.eligiblePlayerId !== playerId) {
      return { success: false, reason: 'invalid' };
    }

    this.grabLock = true;
    this.matchState.active = false;
    this.matchState.status = 'success';
    this.matchState.message = '';
    this.matchState.grabbedById = playerId;
    
    this.broadcast();

    const sweepDuration = jitterTime(Math.floor(Math.random() * (300 - 200 + 1)) + 200);

    this.addTimer(() => {
      const p = this.players.find(pl => pl.id === playerId);
      if (p) p.capturedCards.push(...this.centerPile);
      
      this.centerPile = [];
      this.matchState = { active: false, eligiblePlayerId: null, status: 'idle', message: '', grabbedById: null };
      
      this.broadcast();
      this.scheduleCPU();
    }, sweepDuration);

    return { success: true };
  }
}
