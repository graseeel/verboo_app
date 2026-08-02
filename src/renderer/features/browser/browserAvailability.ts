export function supportsEmbeddedBrowser(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux'
}
