/**
 * Random loading quips
 * Shown by the TimelineStatusStep component while a request is in flight.
 *
 * These are written fresh rather than translated: the Chinese originals were
 * built on local internet memes that do not survive a literal rendering.
 */

const loadingTexts = [
  // Honest about the effort
  'This was supposed to look effortless',
  'Currently flailing, but making progress',
  'I know you are in a hurry. So am I',
  'Doggy-paddling through the knowledge base',
  'Letting the bullet fly a little longer',
  'Hand-crafting an answer, artisan style',
  'Do not rush me, I made the folder already',
  'Thinking so hard it is getting warm in here',
  'The CPU would like a word',
  // Domestic
  'Slow-roasting this one, good things take time',
  'Flipping the knowledge pancake',
  'Put the inspiration in the oven',
  'Letting the answer steep a bit',
  'Knitting a sweater out of sentences',
  'Pouring one for myself, back shortly',
  // Unhinged
  'Neurons are at the disco',
  'Colouring inside the lines',
  'Frantically leafing through everything I know',
  'The brain circus has begun',
  'Squishing some zeroes and ones together',
  'Winding up for something big',
  'The magnifying glass fogged up, one moment',
  'Trying to understand this frankly wild request',
  // Mystical
  'Casting. Do not interrupt',
  'Waking up my silicon friends',
  'Dialling into the wisdom of cyberspace',
  'Hold on, traveller, the divination is running',
  'Falling through a knowledge black hole',
  'Reverse-engineering human intent',
  'Crystal ball is cloudy, giving it a tap',
  // Workplace
  'Code running faster than the news cycle',
  'Management is online, please hold',
  'Riding over at full gallop',
  'Hauling knowledge at the speed of light',
  'One jigsaw piece left',
  'That is a wrap, nearly',
  'Launch countdown initiated',
  'Acquiring target lock',
];

/**
 * Pick a random loading quip.
 */
export function getRandomLoadingText(): string {
  return loadingTexts[Math.floor(Math.random() * loadingTexts.length)];
}
