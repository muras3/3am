interface Props {
  message: string;
}

export function ErrorState({ message }: Props) {
  return (
    <div className="empty-state">
      <p>{message}</p>
    </div>
  );
}
