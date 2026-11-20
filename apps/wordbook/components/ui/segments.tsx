import styles from "./segments.module.css";

// A short row of exclusive filters: the chosen one is raised, the others stay quiet. Pressed
// state, not a radio, since each is a button that narrows a list the reader is already reading.
export function Segments<Value extends string>({
  label,
  value,
  options,
  onValueChange,
}: {
  label: string;
  value: Value;
  options: readonly { value: Value; label: string }[];
  onValueChange: (value: Value) => void;
}) {
  return (
    <div role="group" aria-label={label} className={styles.segments}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          className={styles.segment}
          onClick={() => onValueChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
