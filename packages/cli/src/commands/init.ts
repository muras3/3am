export async function runInit(_argv: string[]): Promise<void> {
  process.stderr.write("Error: 'init' command is not yet implemented\n");
  process.exit(1);
}

export async function runUpgrade(_argv: string[]): Promise<void> {
  process.stderr.write("Error: 'init --upgrade' command is not yet implemented\n");
  process.exit(1);
}
