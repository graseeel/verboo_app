import type { ComputerUsePendingConfirmation } from '../../../shared/types'
import { ComputerUseConfirmationCard } from './ComputerUseConfirmationCard'

type ComputerUseConfirmationDialogProps = {
  confirmation: ComputerUsePendingConfirmation
  appName: string
  busy?: boolean
  onAllowOnce: () => void
  onDeny: () => void
}

export function ComputerUseConfirmationDialog({
  confirmation,
  appName,
  busy = false,
  onAllowOnce,
  onDeny,
}: ComputerUseConfirmationDialogProps) {
  return (
    <div className="modal-backdrop computer-use-consent-backdrop computer-use-confirmation-backdrop">
      <ComputerUseConfirmationCard
        variant="modal"
        confirmation={confirmation}
        appName={appName}
        busy={busy}
        onAllowOnce={onAllowOnce}
        onDeny={onDeny}
      />
    </div>
  )
}
