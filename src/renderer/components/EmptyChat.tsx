import { useI18n } from '../i18n'

type EmptyChatProps = {
  projectName: string
  line: string
}

export function EmptyChat({ projectName, line }: EmptyChatProps) {
  const { t } = useI18n()

  return (
    <div className="empty-chat t-stagger is-shown">
      <p className="empty-kicker t-stagger-line t-stagger-line--1">{line}</p>
      <h1 className="t-stagger-line t-stagger-line--2">
        {projectName ? t('empty.title.project', { projectName }) : t('empty.title.default')}
      </h1>
    </div>
  )
}
