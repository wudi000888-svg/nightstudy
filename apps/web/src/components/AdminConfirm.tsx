import { Dialog } from './UI';

export interface AdminConfirmation {
  title: string;
  message: string;
  label: string;
  run: () => void | Promise<void>;
}

export function AdminConfirm({
  action,
  onClose,
}: {
  action: AdminConfirmation | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!action} title={action?.title ?? '确认操作'} onClose={onClose}>
      <p>{action?.message}</p>
      <div className="action-row admin-confirm-actions">
        <button type="button" className="button ghost" onClick={onClose} autoFocus>
          取消
        </button>
        <button
          type="button"
          className="button primary"
          onClick={() => {
            if (!action) return;
            onClose();
            void action.run();
          }}
        >
          {action?.label ?? '确认'}
        </button>
      </div>
    </Dialog>
  );
}
