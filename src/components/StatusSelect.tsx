import { STATUS_LABELS, type WorkspaceStatus } from '@/types/workspace';

interface Props {
  value: WorkspaceStatus;
  onChange: (value: WorkspaceStatus) => void;
  disabled?: boolean;
  label?: string;
}

export function StatusSelect({ value, onChange, disabled, label }: Props) {
  return (
    <label className="field">
      {label && <span>{label}</span>}
      <select value={value} onChange={(event) => onChange(event.target.value as WorkspaceStatus)} disabled={disabled}>
        {Object.entries(STATUS_LABELS).map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}
