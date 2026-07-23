export function supportsEmbeddedBrowser(platform: NodeJS.Platform): boolean {
  return platform === 'darwin'
}
