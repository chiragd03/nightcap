// The TV's 28 avatars (Fluent Emoji, MIT licence), with the tint behind each, as the Android TV has them.

export const AVATARS: { key: string; image: string; tint: string }[] = [
  { key: 'fox', image: 'avatar_fox', tint: '#6B331B' },
  { key: 'panda', image: 'avatar_panda', tint: '#2E486B' },
  { key: 'tiger', image: 'avatar_tiger', tint: '#6B4A1B' },
  { key: 'owl', image: 'avatar_owl', tint: '#422E6B' },
  { key: 'unicorn', image: 'avatar_unicorn', tint: '#5E236B' },
  { key: 'robot', image: 'avatar_robot', tint: '#1B576B' },
  { key: 'cat', image: 'avatar_cat', tint: '#6B4D1B' },
  { key: 'dog', image: 'avatar_dog', tint: '#6B4425' },
  { key: 'lion', image: 'avatar_lion', tint: '#6B461B' },
  { key: 'koala', image: 'avatar_koala', tint: '#46566B' },
  { key: 'penguin', image: 'avatar_penguin', tint: '#1B406B' },
  { key: 'frog', image: 'avatar_frog', tint: '#2A6B2E' },
  { key: 'monkey', image: 'avatar_monkey', tint: '#6B3B1D' },
  { key: 'bear', image: 'avatar_bear', tint: '#6B3E1B' },
  { key: 'polar_bear', image: 'avatar_polar_bear', tint: '#1F466B' },
  { key: 'wolf', image: 'avatar_wolf', tint: '#38496B' },
  { key: 'rabbit', image: 'avatar_rabbit', tint: '#6B3859' },
  { key: 'hamster', image: 'avatar_hamster', tint: '#6B441B' },
  { key: 'mouse', image: 'avatar_mouse', tint: '#46466B' },
  { key: 'pig', image: 'avatar_pig', tint: '#6B273D' },
  { key: 'cow', image: 'avatar_cow', tint: '#46506B' },
  { key: 'chick', image: 'avatar_chick', tint: '#6B571B' },
  { key: 'octopus', image: 'avatar_octopus', tint: '#6B234D' },
  { key: 'dolphin', image: 'avatar_dolphin', tint: '#1B466B' },
  { key: 'dragon', image: 'avatar_dragon', tint: '#216B33' },
  { key: 'alien', image: 'avatar_alien', tint: '#1D466B' },
  { key: 'invader', image: 'avatar_invader', tint: '#3F1E6B' },
  { key: 'ghost', image: 'avatar_ghost', tint: '#3B436B' },
]
// Java's String.hashCode, so a profile with no avatar gets the same pick as on the TV.
function javaHash(s: string) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

/** A profile's avatar; one without a choice yet gets a steady pick from its id (as on the TV). */
export function avatarOf(key: string | null | undefined, profileId: string) {
  const found = AVATARS.find(a => a.key === key)
  if (found) return found
  const n = AVATARS.length
  return AVATARS[((javaHash(profileId) % n) + n) % n]
}

export const avatarSrc = (image: string) => `${import.meta.env.BASE_URL}avatars/${image}.webp`
