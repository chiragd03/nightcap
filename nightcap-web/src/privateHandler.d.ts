// The optional handler (privateHandler.ts), or none.
declare module '@nightcap/private-handler' {
  export const handler: import('./livetvHandler').StreamHandler | null
}
