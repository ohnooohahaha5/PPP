const SUITS = ['♠', '♥', '♣', '♦'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

export const createDeck = () => {
  const deck = [];
  let id = 0;
  for (const suit of SUITS) {
    for (const value of VALUES) {
      deck.push({
        id: id++,
        suit,
        value,
        color: (suit === '♥' || suit === '♦') ? 'red' : 'black',
      });
    }
  }
  return deck;
};

export const shuffleDeck = (deck) => {
  const newDeck = [...deck];
  for (let i = newDeck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newDeck[i], newDeck[j]] = [newDeck[j], newDeck[i]];
  }
  return newDeck;
};

export const dealCards = (deck, numPlayers) => {
  const hands = Array.from({ length: numPlayers }, () => []);
  // Dealt evenly: 52 cards 
  // 2 players = 26 each
  // 4 players = 13 each
  let playerIdx = 0;
  deck.forEach(card => {
    hands[playerIdx].push(card);
    playerIdx = (playerIdx + 1) % numPlayers;
  });
  return hands;
};
