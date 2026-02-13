/**
 * nicknames.js — Pool pun name generator
 *
 * Bar-tested pool puns. No corporate cringe. These should make
 * someone at a bar chuckle when they see them on the board.
 */

const names = [
  // Hustler energy
  'Fast Eddie', 'Minnesota Slim', 'The Shark', 'Side Pocket',
  'Money Shot', 'Road Player', 'Action Jackson', 'Double Down',
  'Slick Rick', 'The Ringer',

  // Self-aware bad player
  'Scratch King', 'All Talk', 'Hold My Beer', 'YouTube Pro',
  'Warming Up', 'Almost Had It', 'Wrong Ball', 'Still Learning',
  'Oops My Bad', 'Table Donor', 'Next Time', 'Close Enough',
  'Wiff City', 'Coin Feeder',

  // Bar vibes
  'Last Call', 'Tab Open', 'Cash Only', 'Jukebox Hero',
  'Happy Hour', 'Bottoms Up', 'On The Rocks', 'Tip Jar',
  'Bar Back', 'House Rules', 'No Tab', 'Two For One',

  // Pool puns that actually land
  'Cue Later', 'Rack City', 'Chalk Talk', 'Felt Up',
  'Ball Buster', 'Rail Rider', 'Bank Shot Bob', 'Pocket Change',
  'English Major', 'Dead Combo', 'Run Out', 'Safety Dance',
  'Masse Appeal', 'Jump Man', 'Kick Shot Kid',

  // Cocky (in a fun way)
  'Easy Money', 'Clean Sweep', 'No Mercy', 'First Try',
  'Undefeated', 'Bye Bye Balls', 'One and Done', 'Lights Out',
  'Top Shelf', 'Game Over',

  // Pop culture pool mashups
  'Billiard Nye', 'Cue Anon', 'The Cue Whisperer',
  'Breaking Bad', 'Racked and Loaded', 'Full Send',
  'Pool Bunyan', 'Snookered', 'Table Flip',

  // Doubles partner energy
  'Plus One', 'The Closer', 'Bench Warmer', 'Secret Weapon',
  'Dead Weight', 'Carried', 'The Setup Man',

  // 8-ball specific
  'Behind the 8', 'Early 8', 'Sloppy 8', 'Called It',
  'Combo Meal', 'Corner Pocket', 'Cross Side', 'Thin Cut',

  // Names that sound like regulars at a dive bar
  'Big Tony', 'Southpaw', 'Lefty', 'The Professor',
  'Old School', 'Chalk Dust', 'Velvet Touch', 'The Natural',
  'Stick Man', 'Table Boss'
];

function suggest() {
  return names[Math.floor(Math.random() * names.length)];
}

module.exports = { suggest };
