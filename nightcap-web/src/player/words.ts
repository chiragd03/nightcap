// Lines the player says that are made from data, the same in the web app and the Samsung/LG app.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Not out yet. Comes out 8 Nov 2026" (the viewer can act on this), as the Android TV says it
 * (`d MMM yyyy`). Made from the date's own digits ("2026-11-08"), never through Date. */
export function notOutYet(releases: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(releases)
  if (!m || +m[2] < 1 || +m[2] > 12) return 'Not out yet'
  return `Not out yet. Comes out ${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}`
}
