export const OAUTH_CONFIG = Object.freeze({
  // The Verboo backend must register and provide a Chrome-extension public
  // client before standalone chat can ship. Empty is deliberately fail-closed.
  clientId: '',
  authorizeUrl: 'https://code.verboo.ai/oauth/authorize',
  tokenUrl: 'https://code.verboo.ai/oauth/token',
  scopes: Object.freeze(['user:profile', 'user:inference']),
})

export default OAUTH_CONFIG
