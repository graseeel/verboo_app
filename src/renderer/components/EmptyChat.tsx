type EmptyChatProps = {
  projectName: string
  line: string
}

export function EmptyChat({ projectName, line }: EmptyChatProps) {
  return (
    <div className="empty-chat t-stagger is-shown">
      <p className="empty-kicker t-stagger-line t-stagger-line--1">{line}</p>
      <h1 className="t-stagger-line t-stagger-line--2">
        {projectName ? `Em que devemos trabalhar em ${projectName}?` : 'Em que devemos trabalhar agora?'}
      </h1>
    </div>
  )
}
