import mascotUrl from '../../../assets/branding/verboo-mascot.png'

export function TopBar() {
  return (
    <header className="topbar" onDoubleClick={() => window.verboo.toggleWindowZoom()}>
      <img className="topbar-mark" src={mascotUrl} alt="Verboo" />
    </header>
  )
}
