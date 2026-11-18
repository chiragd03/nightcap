// The TV's language tables, so Settings reads the same on both.

// (The audio and subtitle languages themselves come from the server: limits.ts, audioLanguages.)

/** One line of dialogue in each language, for the subtitles preview. */
export const SAMPLE: Record<string, string> = {
  eng: "I never thought I'd see this place again.",
  hin: 'मैंने कभी नहीं सोचा था कि यह जगह फिर देखूँगा।',
  spa: 'Nunca pensé que volvería a ver este lugar.',
  fre: "Je n'aurais jamais cru revoir cet endroit.",
  ger: 'Ich hätte nie gedacht, diesen Ort wiederzusehen.',
  ita: 'Non avrei mai pensato di rivedere questo posto.',
  por: 'Nunca pensei que veria este lugar de novo.',
  jpn: 'またこの場所を見るとは思わなかった。',
  kor: '이곳을 다시 보게 될 줄은 몰랐어.',
  chi: '我从没想过会再看到这个地方。',
  ara: 'لم أظن أنني سأرى هذا المكان مرة أخرى.',
  rus: 'Не думал, что снова увижу это место.',
  dut: 'Ik had nooit gedacht deze plek terug te zien.',
  tam: 'இந்த இடத்தை மீண்டும் பார்ப்பேன் என்று நினைக்கவே இல்லை.',
  tel: 'ఈ ప్రదేశాన్ని మళ్ళీ చూస్తానని ఎప్పుడూ అనుకోలేదు.',
  pan: 'ਮੈਂ ਕਦੇ ਨਹੀਂ ਸੋਚਿਆ ਸੀ ਕਿ ਇਹ ਥਾਂ ਮੁੜ ਵੇਖਾਂਗਾ।',
  urd: 'میں نے کبھی نہیں سوچا تھا کہ یہ جگہ دوبارہ دیکھوں گا۔',
}

/** Home's language rows (two-letter codes, as the server has them) in their own script. */
export const ROW_NATIVE: Record<string, string> = {
  hi: 'हिन्दी', ko: '한국어', anime: 'Anime', ja: '日本語', ta: 'தமிழ்', te: 'తెలుగు', ml: 'മലയാളം',
  es: 'Español', fr: 'Français', tr: 'Türkçe', zh: '中文',
}

/** Picture quality, as the TV describes it. */
export const QUALITIES = [
  { key: 'best', title: 'Best', short: 'Sharpest there is', detail: "4K when there's a version in 4K, otherwise the next best", data: 'Up to about 15 GB an hour' },
  { key: '4K', title: '4K', short: 'Ultra HD', detail: 'The sharpest picture; needs a fast connection', data: 'About 7 to 15 GB an hour' },
  { key: '1080p', title: '1080p', short: 'Full HD', detail: 'Very sharp, smaller files, quick to start', data: 'About 2 to 4 GB an hour' },
  { key: '720p', title: '720p', short: 'Saves data', detail: 'Fine on smaller screens; uses the least data', data: 'About 1 GB an hour' },
]
