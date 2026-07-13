import { useI18n } from '../i18n'

type EmptyChatProps = {
  // `hasProject` is an explicit boolean rather than a truthy-string check on
  // `projectName`. The fallback string "Sem projeto" / "No project" is itself
  // truthy, so `projectName ? project : default` would always take the project
  // branch and render "Em que devemos trabalhar em Sem projeto?" — exactly the
  // bug we are fixing. Callers pass `hasProject` only when a real project is
  // active, and `projectName` is purely the display string for that project.
  hasProject: boolean
  projectName: string
  line: string
}

export function EmptyChat({ hasProject, projectName, line }: EmptyChatProps) {
  const { t } = useI18n()

  return (
    <div className="empty-chat t-stagger is-shown">
      <p className="empty-kicker t-stagger-line t-stagger-line--1">{line}</p>
      <h1 className="t-stagger-line t-stagger-line--2">
        {hasProject ? t('empty.title.project', { projectName }) : t('empty.title.default')}
      </h1>
    </div>
  )
}
