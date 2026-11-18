import { describe, expect, test } from 'vitest'
import { namedLanguage, trackLanguages, twoLetter } from './languages'

// A track's language as the server reads it: the page labels a file's audio tracks
// the same way, so a Hindi track tagged English (or nothing) but named "Hindi 5.1" is Hindi.

describe('track languages', () => {
  test('a name naming one language', () => {
    expect(namedLanguage('Hindi DD+ 5.1')).toBe('hi')
    expect(namedLanguage('Tamil')).toBe('ta')
    expect(namedLanguage('Hindi + English')).toBe(null)
    expect(namedLanguage('Stereo')).toBe(null)
    expect(namedLanguage('SoundHandler')).toBe(null)
    expect(namedLanguage(null)).toBe(null)
  })

  test("the name counts when the tag says nothing or English (Matroska's default)", () => {
    const tracks = [{ language: 'en', name: 'English 5.1' }, { language: 'en', name: 'Hindi 5.1' }, { language: null, name: 'Tamil' }, { language: 'ko', name: 'Hindi' }]
    expect(trackLanguages(tracks)).toEqual(['en', 'hi', 'ta', 'ko'])
  })

  test("the server's own reading of this file wins when it has one per track", () => {
    expect(trackLanguages([{ language: 'en', name: null }, { language: 'en', name: null }], ['en', 'hi'])).toEqual(['en', 'hi'])
    expect(trackLanguages([{ language: 'en', name: null }, { language: 'en', name: null }], ['en', 'und'])).toEqual(['en', null])
    // (A reading of another count isn't this file's tracks: the tracks' own say.)
    expect(trackLanguages([{ language: 'en', name: 'Hindi' }], ['en', 'hi'])).toEqual(['hi'])
  })
})

describe("track names as the server reads them", () => {
  test('its own name or its code as a word', () => {
    expect(namedLanguage('हिन्दी')).toBe('hi')
    expect(namedLanguage('HIN 5.1')).toBe('hi')
    expect(namedLanguage('Superior sound')).toBe(null)
    expect(trackLanguages([{ language: null, name: 'हिन्दी' }])).toEqual(['hi'])
  })
})

describe('a TV player\'s track tags', () => {
  test('to two letters', () => {
    expect(['eng', 'fra', 'fre', 'deu', 'zho', 'nld', 'en-US', 'EN', 'hin', 'und', '', 'mul', 'xyz'].map(twoLetter))
      .toEqual(['en', 'fr', 'fr', 'de', 'zh', 'nl', 'en', 'en', 'hi', null, null, null, 'xyz'])
  })
})
